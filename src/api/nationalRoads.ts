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
/** Bridge visual gaps larger than this between ordered official segments */
const GAP_BRIDGE_M = 90
/** Connector steps shorter than this are merged / omitted from the step list */
const TINY_CONNECTOR_STEP_M = 500

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


/**
 * Greedy order + orient MultiLineString parts into one traversal.
 * Starts near `startHint` (match.start) when provided; otherwise first segment.
 * Remaining far islands are still attached by nearest endpoint.
 */
export function orderAndOrientSegments(
  segments: LatLng[][],
  startHint?: LatLng,
): LatLng[][] {
  const usable = segments.filter((s) => s.length >= 2).map((s) => s.slice())
  if (usable.length <= 1) return usable

  const unused = usable
  const ordered: LatLng[][] = []

  const pickNearest = (tip: LatLng): { seg: LatLng[]; reverse: boolean; idx: number; dist: number } => {
    let bestIdx = 0
    let bestDist = Infinity
    let bestReverse = false
    for (let i = 0; i < unused.length; i++) {
      const seg = unused[i]
      const dStart = haversineMeters(tip, seg[0])
      const dEnd = haversineMeters(tip, seg[seg.length - 1])
      if (dStart < bestDist) {
        bestDist = dStart
        bestIdx = i
        bestReverse = false
      }
      if (dEnd < bestDist) {
        bestDist = dEnd
        bestIdx = i
        bestReverse = true
      }
    }
    return { seg: unused[bestIdx], reverse: bestReverse, idx: bestIdx, dist: bestDist }
  }

  // First segment: nearest endpoint to startHint, else keep file order of first
  if (startHint) {
    const first = pickNearest(startHint)
    unused.splice(first.idx, 1)
    const oriented = first.reverse ? first.seg.slice().reverse() : first.seg
    ordered.push(oriented)
  } else {
    ordered.push(unused.shift()!)
  }

  while (unused.length) {
    const tip = ordered[ordered.length - 1][ordered[ordered.length - 1].length - 1]
    const next = pickNearest(tip)
    unused.splice(next.idx, 1)
    const oriented = next.reverse ? next.seg.slice().reverse() : next.seg
    ordered.push(oriented)
  }

  return ordered
}

/**
 * Between consecutive oriented segments, insert a straight connector when the
 * gap exceeds GAP_BRIDGE_M. Official parts stay in `lineStrings`; bridges go
 * to `connectorLineStrings` for dashed styling.
 */
export function bridgeSegmentGaps(ordered: LatLng[][]): {
  lineStrings: LatLng[][]
  connectorLineStrings: LatLng[][]
  connectorMeters: number
} {
  const connectorLineStrings: LatLng[][] = []
  let connectorMeters = 0

  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]
    const next = ordered[i]
    const end = prev[prev.length - 1]
    const start = next[0]
    const gap = haversineMeters(end, start)
    if (gap > GAP_BRIDGE_M) {
      connectorLineStrings.push([end, start])
      connectorMeters += gap
    }
  }

  return {
    lineStrings: ordered,
    connectorLineStrings,
    connectorMeters,
  }
}

function buildConnectorSteps(connectors: LatLng[][]): RouteStep[] {
  if (!connectors.length) return []

  type Seg = { dist: number; location?: LatLng; count: number }
  const raw: Seg[] = connectors.map((line) => ({
    dist: pathLengthMeters(line),
    location: line[0],
    count: 1,
  }))

  const merged: Seg[] = []
  for (const seg of raw) {
    const last = merged[merged.length - 1]
    if (
      last &&
      (seg.dist < TINY_CONNECTOR_STEP_M || last.dist < TINY_CONNECTOR_STEP_M)
    ) {
      last.dist += seg.dist
      last.count += seg.count
    } else {
      merged.push({ ...seg })
    }
  }

  // Drop leftover tiny merged blobs under threshold (visual only / in distance)
  const notable = merged.filter((s) => s.dist >= TINY_CONNECTOR_STEP_M)
  if (!notable.length && merged.length) {
    // One summary step if total connector length is meaningful
    const total = merged.reduce((n, s) => n + s.dist, 0)
    if (total >= GAP_BRIDGE_M) {
      return [
        {
          type: 'connect',
          label:
            total >= 1000
              ? `연결 · ${(total / 1000).toFixed(1)} km`
              : `연결 · ${Math.round(total)} m`,
          name: '연결',
          distanceMeters: total,
          durationSeconds: (total / 1000 / 60) * 3600,
          location: merged[0].location,
        },
      ]
    }
    return []
  }

  return notable.map((seg) => {
    const label =
      seg.dist >= 1000
        ? `연결 · ${(seg.dist / 1000).toFixed(1)} km`
        : `연결 · ${Math.round(seg.dist)} m`
    return {
      type: 'connect',
      label: seg.count > 1 ? `${label} (${seg.count}개)` : label,
      name: '연결',
      distanceMeters: seg.dist,
      durationSeconds: (seg.dist / 1000 / 60) * 3600,
      location: seg.location,
    }
  })
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
 * Orders/orients segments, bridges visual gaps with straight connectors
 * (dashed on the map). coordinates = longest official line (markers/fallback).
 */
export function routeFromOfficialGeometry(match: RoadMatch): RouteResult | null {
  const raw =
    match.lineStrings?.filter((l) => l.length >= 2) ??
    (match.geometry && match.geometry.length >= 2 ? [match.geometry] : [])

  if (!raw.length) return null

  const ordered = orderAndOrientSegments(raw, match.start)
  const { lineStrings, connectorLineStrings, connectorMeters } =
    bridgeSegmentGaps(ordered)

  const officialMeters =
    match.lengthMeters ??
    lineStrings.reduce((acc, line) => acc + pathLengthMeters(line), 0)
  const distanceMeters = officialMeters + connectorMeters
  const durationSeconds = (distanceMeters / 1000 / 60) * 3600

  const steps = [
    ...buildOfficialSteps(lineStrings, match.name, match.agencies),
    ...buildConnectorSteps(connectorLineStrings),
  ]

  return {
    coordinates: longestLine(lineStrings),
    lineStrings,
    connectorLineStrings: connectorLineStrings.length
      ? connectorLineStrings
      : undefined,
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
