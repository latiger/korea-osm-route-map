import { clipPathToDeclaredEnds, orderAndOrientSegments } from './nationalRoads'
import { fetchRoute } from './route'
import type {
  LatLng,
  RoadMatch,
  RouteResult,
  RouteSegment,
  RouteStep,
  RoutingProvider,
} from '../types'

/** Max vias per Kakao/Naver Directions call. */
const MAX_VIAS = 5
/** Points per API call = start + vias + end */
const POINTS_PER_CALL = MAX_VIAS + 2
/** Sample guide points roughly every N meters along official centerline. */
const SAMPLE_EVERY_M = 12_000
/** Soft cap on samples so very long roads do not explode API call count. */
const MAX_SAMPLES = 80

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

function pathLengthMeters(path: LatLng[]): number {
  let sum = 0
  for (let i = 1; i < path.length; i++) {
    sum += haversineMeters(path[i - 1], path[i])
  }
  return sum
}

/** Concatenate oriented MultiLineString parts, skipping duplicate tips. */
export function flattenOrderedLines(lines: LatLng[][]): LatLng[] {
  const out: LatLng[] = []
  for (const line of lines) {
    for (const p of line) {
      const prev = out[out.length - 1]
      if (prev && prev.lat === p.lat && prev.lng === p.lng) continue
      out.push(p)
    }
  }
  return out
}

/**
 * Walk the polyline and emit points roughly every `everyM` meters,
 * always including start and end.
 */
export function sampleAlongPath(
  path: LatLng[],
  everyM = SAMPLE_EVERY_M,
  maxSamples = MAX_SAMPLES,
): LatLng[] {
  if (path.length < 2) return path.slice()
  const total = pathLengthMeters(path)
  if (total <= 0) return [path[0], path[path.length - 1]]

  const targetCount = Math.min(
    maxSamples,
    Math.max(2, Math.ceil(total / everyM) + 1),
  )
  if (targetCount <= 2) return [path[0], path[path.length - 1]]

  const step = total / (targetCount - 1)
  const samples: LatLng[] = [path[0]]
  let segIdx = 0
  let segStartDist = 0
  let nextTarget = step

  const segLen = (i: number) => haversineMeters(path[i], path[i + 1])

  while (samples.length < targetCount - 1 && segIdx < path.length - 1) {
    const len = segLen(segIdx)
    const segEnd = segStartDist + len
    while (nextTarget <= segEnd + 1e-6 && samples.length < targetCount - 1) {
      const t = len > 0 ? (nextTarget - segStartDist) / len : 0
      const a = path[segIdx]
      const b = path[segIdx + 1]
      samples.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
      })
      nextTarget += step
    }
    segStartDist = segEnd
    segIdx++
  }

  const end = path[path.length - 1]
  const last = samples[samples.length - 1]
  if (!last || last.lat !== end.lat || last.lng !== end.lng) {
    samples.push(end)
  }
  return samples
}

/**
 * Split samples into overlapping windows of ≤ POINTS_PER_CALL points
 * (start + ≤5 vias + end). Windows share the endpoint so stitch is seamless.
 */
export function chunkSamplesForDriving(samples: LatLng[]): LatLng[][] {
  if (samples.length < 2) return []
  if (samples.length <= POINTS_PER_CALL) return [samples]

  const chunks: LatLng[][] = []
  let i = 0
  while (i < samples.length - 1) {
    const endIdx = Math.min(i + POINTS_PER_CALL - 1, samples.length - 1)
    chunks.push(samples.slice(i, endIdx + 1))
    if (endIdx === samples.length - 1) break
    i = endIdx // overlap at shared endpoint
  }
  return chunks
}

function dedupeCoords(coords: LatLng[]): LatLng[] {
  const out: LatLng[] = []
  for (const c of coords) {
    const prev = out[out.length - 1]
    if (prev && prev.lat === c.lat && prev.lng === c.lng) continue
    out.push(c)
  }
  return out
}

function isEndpointStep(s: RouteStep): boolean {
  const t = (s.type ?? '').toLowerCase()
  if (
    t === 'depart' ||
    t === 'arrive' ||
    t === '100' ||
    t === '101' ||
    t === '1000' ||
    t === '87' ||
    t === '88'
  ) {
    return true
  }
  const label = (s.label ?? '').trim()
  return /출발|도착|목적지|경유지/.test(label) && label.length < 12
}

/** Merge sequential driving API results into one RouteResult. */
export function stitchDrivingResults(
  parts: RouteResult[],
): RouteResult {
  if (!parts.length) {
    throw new Error('이어 붙일 경로가 없습니다.')
  }
  if (parts.length === 1) return parts[0]

  const coordinates: LatLng[] = []
  const trafficSegments: RouteSegment[] = []
  const steps: RouteStep[] = []
  let distanceMeters = 0
  let durationSeconds = 0
  let source = parts[0].source

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    distanceMeters += part.distanceMeters
    durationSeconds += part.durationSeconds
    if (part.source && part.source !== source) {
      // Prefer first commercial provider; keep 'osrm' only if all osrm
      if (source === 'osrm' && part.source !== 'osrm') source = part.source
    }

    const coords = part.coordinates ?? []
    if (i === 0) {
      coordinates.push(...coords)
    } else if (coords.length) {
      // Skip first point if it duplicates the previous tip
      const start = coordinates.length ? 1 : 0
      coordinates.push(...coords.slice(start))
    }

    if (part.trafficSegments?.length) {
      trafficSegments.push(...part.trafficSegments)
    }

    const partSteps = part.steps ?? []
    if (i === 0) {
      // Drop only trailing arrive/destination from middle joins later
      steps.push(...partSteps.filter((s, idx) => !(idx === partSteps.length - 1 && isEndpointStep(s))))
    } else if (i === parts.length - 1) {
      steps.push(...partSteps.filter((s, idx) => !(idx === 0 && isEndpointStep(s))))
    } else {
      steps.push(
        ...partSteps.filter(
          (s, idx) =>
            !(idx === 0 && isEndpointStep(s)) &&
            !(idx === partSteps.length - 1 && isEndpointStep(s)),
        ),
      )
    }
  }

  return {
    coordinates: dedupeCoords(coordinates),
    distanceMeters,
    durationSeconds,
    steps,
    trafficSegments: trafficSegments.length ? trafficSegments : undefined,
    source,
    fromOfficialGeometry: false,
  }
}

/**
 * Rebuild an official centerline road as a real driving route via
 * Kakao/Naver (provider), sampling vias along the ordered MOLIT/OSM path.
 */
export async function rebuildOfficialAsDriving(
  match: RoadMatch,
  provider: RoutingProvider,
  signal?: AbortSignal,
): Promise<RouteResult | null> {
  const raw =
    match.lineStrings?.filter((l) => l.length >= 2) ??
    (match.geometry && match.geometry.length >= 2 ? [match.geometry] : [])
  if (!raw.length) return null

  const ordered = orderAndOrientSegments(raw, match.start)
  const flat = clipPathToDeclaredEnds(
    flattenOrderedLines(ordered),
    match.start,
    match.end,
  )
  if (flat.length < 2) return null

  const samples = sampleAlongPath(flat)
  const chunks = chunkSamplesForDriving(samples)
  if (!chunks.length) return null

  const parts: RouteResult[] = []
  for (const chunk of chunks) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    if (chunk.length < 2) continue
    const part = await fetchRoute(chunk, 'driving', signal, provider)
    parts.push(part)
  }

  if (!parts.length) return null

  const stitched = stitchDrivingResults(parts)
  // Keep a light road-name prefix on steps for multi-road chains
  const roadName = match.name
  return {
    ...stitched,
    steps: stitched.steps.map((s) => ({
      ...s,
      name: s.name || roadName,
      label: s.label.startsWith(roadName) ? s.label : s.label,
    })),
  }
}
