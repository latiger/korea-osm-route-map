import type { LatLng, RoadMatch } from '../types'
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
  coordinates?: LatLng[]
  geometry?: {
    type: string
    coordinates: unknown
  }
}

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

function toMatch(entry: NationalRoadIndexEntry, detail?: NationalRoadDetail | null): RoadMatch {
  const geometry = detail?.coordinates?.length
    ? detail.coordinates
    : entry.sampleLine?.map(([lng, lat]) => ({ lat, lng }))
  return {
    id: `molit:national:${entry.routeNo}`,
    name: entry.name,
    label: `${entry.name} · 공식 국도중심선 · 약 ${(entry.lengthMetersApprox / 1000).toFixed(0)}km · ${entry.segmentCount}구간`,
    start: entry.start,
    end: entry.end,
    geometry,
    source: 'molit',
    lengthMeters: entry.lengthMetersApprox,
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
    const entry = index.routes[parsed.ref] || index.routes[parsed.ref.padStart(2, '0')]
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

  // Load full geometry for first few matches (usually 1)
  const out: RoadMatch[] = []
  for (const entry of matches.slice(0, 5)) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const detail = await loadRouteDetail(entry.file)
    out.push(toMatch(entry, detail))
  }
  return out
}

/** Build a RouteResult-like coordinate path from official geometry (no OSRM). */
export function routeFromOfficialGeometry(
  match: RoadMatch,
): { coordinates: LatLng[]; distanceMeters: number; durationSeconds: number } | null {
  if (!match.geometry || match.geometry.length < 2) return null
  const distanceMeters =
    match.lengthMeters ??
    match.geometry.reduce((acc, p, i, arr) => {
      if (i === 0) return 0
      return acc + haversineMeters(arr[i - 1], p)
    }, 0)
  // Rough driving ETA at 60 km/h for summary only
  const durationSeconds = (distanceMeters / 1000 / 60) * 3600
  return {
    coordinates: match.geometry,
    distanceMeters,
    durationSeconds,
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
