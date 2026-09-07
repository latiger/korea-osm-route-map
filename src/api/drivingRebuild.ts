import {
  clipOrderedSegmentsToDeclaredEnds,
  listOfficialSegmentGaps,
  orderAndOrientSegments,
} from './nationalRoads'
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
/** Fill chunk-join holes when adjacent part endpoints are farther than this. */
const CHUNK_JOIN_GAP_M = 5
/** Densify traffic: real mini-route when consecutive segment tips exceed this. */
const TRAFFIC_DENSIFY_GAP_M = 30

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

function samePoint(a: LatLng, b: LatLng): boolean {
  return a.lat === b.lat && a.lng === b.lng
}

function appendCoordsSkippingDup(target: LatLng[], coords: LatLng[]): void {
  if (!coords.length) return
  const start =
    target.length && samePoint(target[target.length - 1]!, coords[0]!) ? 1 : 0
  for (let i = start; i < coords.length; i++) {
    const c = coords[i]!
    const prev = target[target.length - 1]
    if (prev && samePoint(prev, c)) continue
    target.push(c)
  }
}

/**
 * When consecutive traffic segment endpoints are >TRAFFIC_DENSIFY_GAP_M apart,
 * insert a real mini driving fill (same provider) instead of leaving a hole.
 */
async function densifyTrafficSegments(
  segments: RouteSegment[],
  provider: RoutingProvider,
  signal?: AbortSignal,
): Promise<RouteSegment[]> {
  if (segments.length < 2) return segments
  const out: RouteSegment[] = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    if (out.length) {
      const prev = out[out.length - 1]!
      const aEnd = prev.coordinates[prev.coordinates.length - 1]
      const bStart = seg.coordinates[0]
      if (
        aEnd &&
        bStart &&
        haversineMeters(aEnd, bStart) > TRAFFIC_DENSIFY_GAP_M
      ) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        try {
          const fill = await fetchRoute(
            [aEnd, bStart],
            'driving',
            signal,
            provider,
          )
          if (fill.trafficSegments?.length) {
            for (const fs of fill.trafficSegments) {
              if (fs.coordinates.length > 1) out.push(fs)
            }
          } else if (fill.coordinates && fill.coordinates.length > 1) {
            out.push({
              coordinates: fill.coordinates,
              trafficState: prev.trafficState,
              trafficSpeed: prev.trafficSpeed,
              name: prev.name,
            })
          }
        } catch (e) {
          if ((e as Error).name === 'AbortError') throw e
          // Leave hole rather than inventing a straight chord.
        }
      }
    }
    out.push(seg)
  }
  return out
}

/** Flatten traffic polylines into one continuous coordinate list (deduped tips). */
function coordinatesFromTraffic(segments: RouteSegment[]): LatLng[] {
  const out: LatLng[] = []
  for (const seg of segments) {
    appendCoordsSkippingDup(out, seg.coordinates)
  }
  return out
}

/**
 * Merge sequential driving API results into one RouteResult.
 * If adjacent chunk endpoints still leave a gap, fill along the road via
 * fetchRoute([end, start]) with the same provider (no map straight-chord).
 */
export async function stitchDrivingResults(
  parts: RouteResult[],
  provider: RoutingProvider,
  signal?: AbortSignal,
): Promise<RouteResult> {
  if (!parts.length) {
    throw new Error('이어 붙일 경로가 없습니다.')
  }
  if (parts.length === 1) {
    const only = parts[0]!
    let traffic = only.trafficSegments ?? []
    if (traffic.length > 1) {
      traffic = await densifyTrafficSegments(traffic, provider, signal)
    }
    const coords =
      traffic.length > 1
        ? coordinatesFromTraffic(traffic)
        : dedupeCoords(only.coordinates ?? [])
    return {
      ...only,
      coordinates: coords.length >= 2 ? coords : dedupeCoords(only.coordinates ?? []),
      trafficSegments: traffic.length ? traffic : only.trafficSegments,
    }
  }

  const coordinates: LatLng[] = []
  const trafficSegments: RouteSegment[] = []
  const steps: RouteStep[] = []
  let distanceMeters = 0
  let durationSeconds = 0
  let source = parts[0]!.source

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    distanceMeters += part.distanceMeters
    durationSeconds += part.durationSeconds
    if (part.source && part.source !== source) {
      // Prefer first commercial provider; keep 'osrm' only if all osrm
      if (source === 'osrm' && part.source !== 'osrm') source = part.source
    }

    const coords = part.coordinates ?? []

    if (i > 0 && coords.length && coordinates.length) {
      const prevTip = coordinates[coordinates.length - 1]!
      const nextStart = coords[0]!
      const gap = haversineMeters(prevTip, nextStart)
      if (gap > CHUNK_JOIN_GAP_M) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        try {
          const fill = await fetchRoute(
            [prevTip, nextStart],
            'driving',
            signal,
            provider,
          )
          const fillCoords = fill.coordinates ?? []
          if (fillCoords.length >= 2) {
            appendCoordsSkippingDup(coordinates, fillCoords)
            distanceMeters += fill.distanceMeters
            durationSeconds += fill.durationSeconds
          }
          if (fill.trafficSegments?.length) {
            trafficSegments.push(...fill.trafficSegments)
          } else if (fillCoords.length > 1) {
            const prevTraffic = trafficSegments[trafficSegments.length - 1]
            trafficSegments.push({
              coordinates: fillCoords,
              trafficState: prevTraffic?.trafficState ?? 0,
              trafficSpeed: prevTraffic?.trafficSpeed,
              name: prevTraffic?.name,
            })
          }
        } catch (e) {
          if ((e as Error).name === 'AbortError') throw e
          // Leave hole rather than inventing a straight chord on the map.
        }
      }
    }

    if (i === 0) {
      appendCoordsSkippingDup(coordinates, coords)
    } else if (coords.length) {
      appendCoordsSkippingDup(coordinates, coords)
    }

    if (part.trafficSegments?.length) {
      trafficSegments.push(...part.trafficSegments)
    }

    const partSteps = part.steps ?? []
    if (i === 0) {
      // Drop only trailing arrive/destination from middle joins later
      steps.push(
        ...partSteps.filter(
          (s, idx) =>
            !(idx === partSteps.length - 1 && isEndpointStep(s)),
        ),
      )
    } else if (i === parts.length - 1) {
      steps.push(
        ...partSteps.filter((s, idx) => !(idx === 0 && isEndpointStep(s))),
      )
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

  let densifiedTraffic = trafficSegments
  if (trafficSegments.length > 1) {
    densifiedTraffic = await densifyTrafficSegments(
      trafficSegments,
      provider,
      signal,
    )
  }

  // Prefer continuous path rebuilt from densified traffic when available.
  let finalCoords = dedupeCoords(coordinates)
  if (densifiedTraffic.length > 1) {
    const fromTraffic = coordinatesFromTraffic(densifiedTraffic)
    if (fromTraffic.length >= 2) finalCoords = fromTraffic
  }

  return {
    coordinates: finalCoords,
    distanceMeters,
    durationSeconds,
    steps,
    trafficSegments: densifiedTraffic.length ? densifiedTraffic : undefined,
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

  // Preserve segment boundaries for official gap listing (same as official path).
  const ordered = clipOrderedSegmentsToDeclaredEnds(
    orderAndOrientSegments(raw, match.start),
    match.start,
    match.end,
  )
  const flat = flattenOrderedLines(ordered)
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

  const stitched = await stitchDrivingResults(parts, provider, signal)
  // Geometry-only official gaps (no second Kakao pass) so GapList still works.
  const { gaps: rawGaps, connectorLineStrings } = listOfficialSegmentGaps(ordered)
  const gaps = rawGaps.map((g) => ({
    ...g,
    id: `${match.id}-${g.id}`,
    label: `${match.name} 내부`,
  }))

  // Keep a light road-name prefix on steps for multi-road chains
  const roadName = match.name
  return {
    ...stitched,
    steps: stitched.steps.map((s) => ({
      ...s,
      name: s.name || roadName,
      label: s.label.startsWith(roadName) ? s.label : s.label,
    })),
    gaps: gaps.length ? gaps : undefined,
    connectorLineStrings: connectorLineStrings.length
      ? connectorLineStrings
      : undefined,
  }
}
