import type { LatLng, RoadMatch, RouteResult, RouteStep } from '../types'
import { parseRoadQuery } from './overpass'

export interface NationalRoadIndexEntry {
  routeNo: string
  routeNoRaw?: string
  name: string
  aliases: string[]
  bbox: [number, number, number, number]
  start: LatLng
  end: LatLng
  lengthMetersApprox: number
  segmentCount: number
  agencies?: string[]
  lineCount?: number
  sampleLine?: [number, number][]
  file: string
}

interface NationalRoadIndex {
  source: string
  updated?: string
  crs?: string
  routes: Record<string, NationalRoadIndexEntry>
}

interface NationalRoadDetail extends NationalRoadIndexEntry {
  /** Longest / primary line only (markers); prefer lines / geometry */
  coordinates?: LatLng[]
  /** Explicit multi-polyline LatLng paths (preferred) */
  lines?: LatLng[][]
  geometry?: {
    type: string
    coordinates: unknown
  }
}

const MAX_OFFICIAL_STEPS = 40
/** Merge consecutive segments shorter than this into one step label */
const TINY_SEGMENT_M = 500

let indexCache: NationalRoadIndex | null = null
let indexPromise: Promise<NationalRoadIndex | null> | null = null

async function loadIndex(): Promise<NationalRoadIndex | null> {
  if (indexCache) return indexCache
  if (!indexPromise) {
    indexPromise = (async () => {
      try {
        const res = await fetch('/data/national-roads/index.json')
        if (!res.ok) return null
        const data = (await res.json()) as NationalRoadIndex
        indexCache = data
        return data
      } catch {
        return null
      }
    })()
  }
  return indexPromise
}

async function loadRouteDetail(file: string): Promise<NationalRoadDetail | null> {
  try {
    const res = await fetch(`/data/national-roads/${file}`)
    if (!res.ok) return null
    return (await res.json()) as NationalRoadDetail
  } catch {
    return null
  }
}

function lngLatToLatLng(pt: [number, number] | number[]): LatLng {
  return { lng: pt[0], lat: pt[1] }
}

/** Extract separate polylines from MOLIT detail (never flatten MultiLineString). */
export function parseOfficialLineStrings(detail: NationalRoadDetail): LatLng[][] {
  if (detail.lines?.length) {
    return detail.lines.filter((l) => l.length >= 2)
  }

  const geom = detail.geometry
  if (geom?.coordinates != null) {
    if (geom.type === 'MultiLineString' && Array.isArray(geom.coordinates)) {
      return (geom.coordinates as number[][][])
        .map((line) => line.map(lngLatToLatLng))
        .filter((line) => line.length >= 2)
    }
    if (geom.type === 'LineString' && Array.isArray(geom.coordinates)) {
      const line = (geom.coordinates as number[][]).map(lngLatToLatLng)
      return line.length >= 2 ? [line] : []
    }
  }

  if (detail.coordinates && detail.coordinates.length >= 2) {
    return [detail.coordinates]
  }
  return []
}

function pathLengthMeters(path: LatLng[]): number {
  let acc = 0
  for (let i = 1; i < path.length; i++) {
    acc += haversineMeters(path[i - 1], path[i])
  }
  return acc
}

function longestLine(lineStrings: LatLng[][]): LatLng[] {
  if (!lineStrings.length) return []
  return lineStrings.reduce((best, cur) =>
    cur.length > best.length ? cur : best,
  )
}

/**
 * Build Korean step list from each lineString.
 * Tiny consecutive segments are merged for the list; map still draws all lines.
 * Caps with “외 N구간” when too many.
 */
function buildOfficialSteps(
  lineStrings: LatLng[][],
  roadName: string,
  agencies?: string[],
): RouteStep[] {
  type Seg = { dist: number; location?: LatLng; count: number }
  const raw: Seg[] = lineStrings.map((line) => ({
    dist: pathLengthMeters(line),
    location: line[0],
    count: 1,
  }))

  const merged: Seg[] = []
  for (const seg of raw) {
    const last = merged[merged.length - 1]
    if (last && (seg.dist < TINY_SEGMENT_M || last.dist < TINY_SEGMENT_M)) {
      last.dist += seg.dist
      last.count += seg.count
    } else {
      merged.push({ ...seg })
    }
  }

  const agencyHint =
    agencies && agencies.length > 0 && agencies.length <= 3
      ? agencies.join('·')
      : agencies && agencies.length > 3
        ? `${agencies.slice(0, 2).join('·')} 외`
        : ''

  let overflowExtra = 0
  let segsForSteps = merged
  if (merged.length > MAX_OFFICIAL_STEPS) {
    const keep = MAX_OFFICIAL_STEPS - 1
    const head = merged.slice(0, keep)
    const tail = merged.slice(keep)
    overflowExtra = tail.reduce((n, s) => n + s.count, 0)
    const overflowDist = tail.reduce((n, s) => n + s.dist, 0)
    segsForSteps = [
      ...head,
      {
        dist: overflowDist,
        location: tail[0]?.location,
        count: overflowExtra,
      },
    ]
  }

  return segsForSteps.map((seg, i) => {
    const isOverflow = i === segsForSteps.length - 1 && overflowExtra > 0
    const km = (seg.dist / 1000).toFixed(1)
    const label = isOverflow
      ? `외 ${overflowExtra}구간 · ${km} km`
      : seg.count > 1
        ? `구간 ${i + 1} (${seg.count}개 합침) · ${km} km`
        : `구간 ${i + 1} · ${km} km`
    return {
      type: 'continue',
      label,
      name: agencyHint || roadName,
      distanceMeters: seg.dist,
      durationSeconds: (seg.dist / 1000 / 60) * 3600,
      location: seg.location,
    }
  })
}

function toMatch(
  entry: NationalRoadIndexEntry,
  detail?: NationalRoadDetail | null,
): RoadMatch {
  const lineStrings = detail
    ? parseOfficialLineStrings(detail)
    : entry.sampleLine?.length
      ? [entry.sampleLine.map(([lng, lat]) => ({ lat, lng }))]
      : undefined

  const geometry = lineStrings?.length
    ? longestLine(lineStrings)
    : undefined

  return {
    id: `molit:national:${entry.routeNo}`,
    name: entry.name,
    label: `${entry.name} · 공식 국도중심선 · 약 ${(entry.lengthMetersApprox / 1000).toFixed(0)}km · ${entry.segmentCount}구간`,
    start: entry.start,
    end: entry.end,
    geometry,
    lineStrings,
    source: 'molit',
    lengthMeters: entry.lengthMetersApprox,
    agencies: entry.agencies ?? detail?.agencies,
  }
}

/** True when query is a numbered 국도 (e.g. 2번국도, 국도2호선). */
export function isNationalRoadQuery(query: string): boolean {
  return parseRoadQuery(query).kind === 'national'
}

/**
 * Search MOLIT 일반국도 centerline index.
 * Prefer this over Overpass when the query looks like a 국도 number.
 */
export async function searchNationalRoads(
  query: string,
  signal?: AbortSignal,
): Promise<RoadMatch[]> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const parsed = parseRoadQuery(query)
  const index = await loadIndex()
  if (!index?.routes) return []

  const q = query.trim().replace(/\s+/g, '')
  const matches: NationalRoadIndexEntry[] = []

  if (parsed.kind === 'national' && parsed.ref) {
    const entry =
      index.routes[parsed.ref] || index.routes[parsed.ref.padStart(2, '0')]
    if (entry) matches.push(entry)
  } else {
    const lower = q.toLowerCase()
    for (const entry of Object.values(index.routes)) {
      const hay = [entry.name, entry.routeNo, ...(entry.aliases ?? [])]
        .join('|')
        .replace(/\s+/g, '')
        .toLowerCase()
      if (hay.includes(lower) || lower.includes(entry.routeNo)) {
        matches.push(entry)
      }
    }
  }

  if (!matches.length) return []

  const out: RoadMatch[] = []
  for (const entry of matches.slice(0, 5)) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const detail = await loadRouteDetail(entry.file)
    out.push(toMatch(entry, detail))
  }
  return out
}

/**
 * Build a RouteResult from official MultiLineString geometry (no OSRM).
 * Uses lineStrings for map drawing; coordinates = longest line (markers/fallback).
 */
export function routeFromOfficialGeometry(match: RoadMatch): RouteResult | null {
  const lineStrings =
    match.lineStrings?.filter((l) => l.length >= 2) ??
    (match.geometry && match.geometry.length >= 2 ? [match.geometry] : [])

  if (!lineStrings.length) return null

  const distanceMeters =
    match.lengthMeters ??
    lineStrings.reduce((acc, line) => acc + pathLengthMeters(line), 0)

  const durationSeconds = (distanceMeters / 1000 / 60) * 3600
  const steps = buildOfficialSteps(lineStrings, match.name, match.agencies)

  return {
    coordinates: longestLine(lineStrings),
    lineStrings,
    distanceMeters,
    durationSeconds,
    steps,
    fromOfficialGeometry: true,
    source: 'official',
  }
}

function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
