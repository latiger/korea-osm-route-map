import { routeFromOfficialGeometry } from './nationalRoads'
import { fetchRoute } from './route'
import { assessConnectorQuality } from './connectorQuality'
import type {
  GapBridgeKind,
  LatLng,
  RoadMatch,
  RouteGapInfo,
  RouteResult,
  RouteStep,
  RouteSegment,
  TravelProfile,
} from '../types'

/** Gap larger than this inserts a connector route between roads. */
const GAP_THRESHOLD_M = 80
/** Inter-road gaps larger than this are left unconnected (listed as skipped). */
const GAP_ROUTE_MAX_M = 5000

function formatGapLabelDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`
  return `${Math.round(meters)} m`
}

function flipGaps(gaps: RouteGapInfo[] | undefined): RouteGapInfo[] | undefined {
  if (!gaps?.length) return gaps
  return [...gaps]
    .map((g) => ({
      ...g,
      from: g.to,
      to: g.from,
      // Segment indices are invalid after reverse; insert uses haversine on from
      afterSegmentIndex: undefined,
    }))
    .reverse()
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

function reverseLineStrings(lines: LatLng[][]): LatLng[][] {
  return [...lines].map((l) => [...l].reverse()).reverse()
}

function reverseConnectorLineStrings(lines: LatLng[][] | undefined): LatLng[][] | undefined {
  if (!lines?.length) return undefined
  return reverseLineStrings(lines)
}

function lineStringsFromRoute(route: RouteResult): LatLng[][] {
  if (route.lineStrings?.length) {
    return route.lineStrings.filter((l) => l.length >= 2)
  }
  if (route.trafficSegments?.length) {
    return route.trafficSegments
      .map((s) => s.coordinates)
      .filter((l) => l.length >= 2)
  }
  if (route.coordinates && route.coordinates.length >= 2) {
    return [route.coordinates]
  }
  return []
}

interface MaterializedRoad {
  match: RoadMatch
  route: RouteResult
  start: LatLng
  end: LatLng
  lineStrings: LatLng[][]
  connectorLineStrings?: LatLng[][]
  official: boolean
}

async function materializeRoad(
  match: RoadMatch,
  profile: TravelProfile,
  signal?: AbortSignal,
): Promise<MaterializedRoad> {
  const official = await routeFromOfficialGeometry(match, signal)
  if (official) {
    return {
      match,
      route: official,
      start: match.start,
      end: match.end,
      lineStrings: lineStringsFromRoute(official),
      connectorLineStrings: official.connectorLineStrings,
      official: true,
    }
  }

  if (
    !Number.isFinite(match.start.lat) ||
    !Number.isFinite(match.end.lat) ||
    (match.start.lat === 0 && match.end.lat === 0)
  ) {
    throw new Error(
      `"${match.name}" 도로 시점·종점 좌표가 없어 경로를 계산할 수 없습니다.`,
    )
  }

  const r = await fetchRoute([match.start, match.end], profile, signal)
  return {
    match,
    route: r,
    start: match.start,
    end: match.end,
    lineStrings: lineStringsFromRoute(r),
    official: false,
  }
}

function orientRoad(
  road: MaterializedRoad,
  prevEnd: LatLng | null,
): MaterializedRoad {
  if (!prevEnd) return road

  const distToStart = haversineMeters(prevEnd, road.start)
  const distToEnd = haversineMeters(prevEnd, road.end)
  if (distToEnd >= distToStart) return road

  const flippedConnectors = reverseConnectorLineStrings(
    road.connectorLineStrings ?? road.route.connectorLineStrings,
  )
  return {
    ...road,
    start: road.end,
    end: road.start,
    lineStrings: reverseLineStrings(road.lineStrings),
    connectorLineStrings: flippedConnectors,
    route: {
      ...road.route,
      lineStrings: reverseLineStrings(lineStringsFromRoute(road.route)),
      connectorLineStrings: flippedConnectors,
      coordinates: road.route.coordinates
        ? [...road.route.coordinates].reverse()
        : road.route.coordinates,
      steps: [...road.route.steps].reverse(),
      trafficSegments: road.route.trafficSegments
        ? [...road.route.trafficSegments]
            .map((s) => ({
              ...s,
              coordinates: [...s.coordinates].reverse(),
            }))
            .reverse()
        : undefined,
      gaps: flipGaps(road.route.gaps),
    },
  }
}

function prefixSteps(steps: RouteStep[], roadName: string): RouteStep[] {
  return steps.map((s) => ({
    ...s,
    label: s.label.startsWith(roadName) ? s.label : `${roadName} · ${s.label}`,
    name: s.name || roadName,
  }))
}

function connectorSteps(conn: RouteResult): RouteStep[] {
  if (conn.steps.length) {
    return conn.steps.map((s) => ({
      ...s,
      label: s.label.startsWith('연결') ? s.label : `연결 · ${s.label}`,
      name: s.name ? `연결 · ${s.name}` : '연결',
    }))
  }
  return [
    {
      type: 'connect',
      label: '연결 · 도로 사이 구간',
      name: '연결',
      distanceMeters: conn.distanceMeters,
      durationSeconds: conn.durationSeconds,
      location: conn.coordinates?.[0],
    },
  ]
}

export interface ChainedRouteMeta {
  route: RouteResult
  start: LatLng
  end: LatLng
  junctions: LatLng[]
}

/**
 * Merge an ordered chain of RoadMatch into one RouteResult.
 * Orients each next road toward the previous end; inserts a driving/walk
 * connector when the gap exceeds ~80m.
 */
export async function buildChainedRoute(
  chain: RoadMatch[],
  profile: TravelProfile,
  signal?: AbortSignal,
): Promise<ChainedRouteMeta> {
  if (!chain.length) {
    throw new Error('체인이 비어 있습니다.')
  }

  const materialized: MaterializedRoad[] = []
  for (const match of chain) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const road = await materializeRoad(match, profile, signal)
    const prevEnd = materialized.length
      ? materialized[materialized.length - 1].end
      : null
    materialized.push(orientRoad(road, prevEnd))
  }

  const allLineStrings: LatLng[][] = []
  const allConnectorLineStrings: LatLng[][] = []
  const allCoords: LatLng[] = []
  const allSteps: RouteStep[] = []
  const trafficSegments: RouteSegment[] = []
  const allGaps: RouteGapInfo[] = []
  const junctions: LatLng[] = []
  let distanceMeters = 0
  let durationSeconds = 0
  let anyOfficial = false
  let anyNonOfficial = false

  for (let i = 0; i < materialized.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const road = materialized[i]

    if (i > 0) {
      const prev = materialized[i - 1]
      const gap = haversineMeters(prev.end, road.start)
      if (gap > GAP_THRESHOLD_M) {
        const gapLabel = `${prev.match.name} → ${road.match.name} 연결`
        let kind: GapBridgeKind = 'routed'

        if (gap > GAP_ROUTE_MAX_M) {
          kind = 'skipped'
          allGaps.push({
            id: `inter-${i}`,
            label: gapLabel,
            from: prev.end,
            to: road.start,
            gapMeters: gap,
            kind,
          })
          junctions.push(prev.end)
        } else {
          let conn: RouteResult | null = null
          try {
            conn = await fetchRoute([prev.end, road.start], profile, signal)
          } catch (e) {
            if ((e as Error).name === 'AbortError') throw e
            console.warn('[roadChain] inter-road connector failed, using straight:', e)
            kind = 'straight'
          }

          let rejectReason: string | undefined
          if (conn) {
            const connGeom =
              conn.trafficSegments?.length
                ? conn.trafficSegments.flatMap((s) => s.coordinates)
                : lineStringsFromRoute(conn).flat()
            const prevPoly =
              prev.lineStrings[prev.lineStrings.length - 1] ?? undefined
            const nextPoly = road.lineStrings[0] ?? undefined
            const quality = assessConnectorQuality({
              gap: { from: prev.end, to: road.start, gapMeters: gap },
              connector:
                connGeom.length >= 2
                  ? connGeom
                  : [prev.end, road.start],
              previousPolyline: prevPoly,
              nextPolyline: nextPoly,
              connectorDistanceMeters: conn.distanceMeters,
            })
            if (!quality.ok) {
              kind = 'blocked'
              rejectReason = quality.reason
              const straight: LatLng[] = [prev.end, road.start]
              allConnectorLineStrings.push(straight)
              allCoords.push(...straight)
              distanceMeters += gap
              durationSeconds += (gap / 1000 / 60) * 3600
            } else {
              kind = 'routed'
              distanceMeters += conn.distanceMeters
              durationSeconds += conn.durationSeconds
              allSteps.push(...connectorSteps(conn))

              if (conn.trafficSegments?.length) {
                trafficSegments.push(...conn.trafficSegments)
                for (const seg of conn.trafficSegments) {
                  allCoords.push(...seg.coordinates)
                }
              } else {
                const connLines = lineStringsFromRoute(conn)
                allLineStrings.push(...connLines)
                for (const line of connLines) allCoords.push(...line)
              }
              anyNonOfficial = true
            }
          } else {
            kind = 'straight'
            const straight: LatLng[] = [prev.end, road.start]
            allConnectorLineStrings.push(straight)
            allCoords.push(...straight)
            distanceMeters += gap
            durationSeconds += (gap / 1000 / 60) * 3600
            allSteps.push({
              type: 'connect',
              label: `연결 · ${formatGapLabelDistance(gap)} (직선)`,
              name: '연결',
              distanceMeters: gap,
              durationSeconds: (gap / 1000 / 60) * 3600,
              location: prev.end,
            })
          }

          allGaps.push({
            id: `inter-${i}`,
            label: gapLabel,
            from: prev.end,
            to: road.start,
            gapMeters: gap,
            kind,
            ...(rejectReason ? { rejectReason } : {}),
          })
          junctions.push(prev.end)
        }
      } else if (gap > 1) {
        junctions.push(prev.end)
      }
    }

    if (road.official) anyOfficial = true
    else anyNonOfficial = true

    // Road parts as lineStrings (blue); intra-road gap bridges as dashed connectors.
    allLineStrings.push(...road.lineStrings)
    for (const line of road.lineStrings) allCoords.push(...line)
    const roadConnectors =
      road.connectorLineStrings ?? road.route.connectorLineStrings
    if (roadConnectors?.length) {
      allConnectorLineStrings.push(...roadConnectors)
      for (const line of roadConnectors) allCoords.push(...line)
    }
    if (road.route.gaps?.length) {
      allGaps.push(...road.route.gaps)
    }
    distanceMeters += road.route.distanceMeters
    durationSeconds += road.route.durationSeconds
    allSteps.push(...prefixSteps(road.route.steps, road.match.name))
  }

  const first = materialized[0]
  const last = materialized[materialized.length - 1]

  return {
    route: {
      coordinates: allCoords.length ? allCoords : first.route.coordinates,
      lineStrings: allLineStrings.length ? allLineStrings : undefined,
      connectorLineStrings: allConnectorLineStrings.length
        ? allConnectorLineStrings
        : undefined,
      distanceMeters,
      durationSeconds,
      steps: allSteps,
      fromOfficialGeometry: anyOfficial && !anyNonOfficial,
      source: anyOfficial ? 'official' : 'osrm',
      trafficSegments: trafficSegments.length ? trafficSegments : undefined,
      gaps: allGaps.length ? allGaps : undefined,
    },
    start: first.start,
    end: last.end,
    junctions,
  }
}

/** Start / end / optional junction markers for a chained route. */
export function buildChainMarkers(
  chain: RoadMatch[],
  meta?: Pick<ChainedRouteMeta, 'start' | 'end' | 'junctions'>,
): Array<LatLng & { key: string; label?: string }> {
  if (!chain.length) return []

  const start = meta?.start ?? chain[0].start
  const end = meta?.end ?? chain[chain.length - 1].end
  const markers: Array<LatLng & { key: string; label?: string }> = [
    {
      key: 'chain-start',
      lat: start.lat,
      lng: start.lng,
      label: `${chain[0].name} 시작`,
    },
    {
      key: 'chain-end',
      lat: end.lat,
      lng: end.lng,
      label: `${chain[chain.length - 1].name} 끝`,
    },
  ]

  ;(meta?.junctions ?? []).forEach((j, i) => {
    markers.push({
      key: `chain-junction-${i}`,
      lat: j.lat,
      lng: j.lng,
      label: `연결 ${i + 1}`,
    })
  })

  return markers
}
