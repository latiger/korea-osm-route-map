import type { LatLng, RouteResult, RouteStep } from '../types'

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

function coordsNear(a: LatLng, b: LatLng, eps = 1e-5): boolean {
  return Math.abs(a.lat - b.lat) < eps && Math.abs(a.lng - b.lng) < eps
}

/** Project point onto segment; return distance (m) and clamped t in [0,1]. */
function projectPointToSegment(
  p: LatLng,
  a: LatLng,
  b: LatLng,
): { dist: number; t: number } {
  const lat0 = (((a.lat + b.lat) / 2) * Math.PI) / 180
  const toXY = (ll: LatLng) => ({
    x: ll.lng * Math.cos(lat0) * 111320,
    y: ll.lat * 110540,
  })
  const P = toXY(p)
  const A = toXY(a)
  const B = toXY(b)
  const dx = B.x - A.x
  const dy = B.y - A.y
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const projX = A.x + t * dx
  const projY = A.y + t * dy
  const dist = Math.hypot(P.x - projX, P.y - projY)
  return { dist, t }
}

/**
 * Distance along the polyline from the start to the nearest projection of `p`.
 */
function distanceAlongPath(p: LatLng, path: LatLng[], cumDist: number[]): number {
  let bestDist = Infinity
  let bestAlong = 0
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]
    const b = path[i + 1]
    const { dist, t } = projectPointToSegment(p, a, b)
    if (dist < bestDist) {
      bestDist = dist
      const segLen = cumDist[i + 1] - cumDist[i]
      bestAlong = cumDist[i] + t * segLen
    }
  }
  // Also consider exact vertices (degenerate / endpoint)
  for (let i = 0; i < path.length; i++) {
    const d = haversineMeters(p, path[i])
    if (d < bestDist) {
      bestDist = d
      bestAlong = cumDist[i]
    }
  }
  return bestAlong
}

function endpointsMatch(line: LatLng[], from: LatLng, to: LatLng): boolean {
  if (line.length < 2) return false
  const a = line[0]
  const b = line[line.length - 1]
  return (
    (coordsNear(a, from) && coordsNear(b, to)) ||
    (coordsNear(a, to) && coordsNear(b, from))
  )
}

/**
 * Flatten official segments + gap connectors in travel order.
 * Prefer lineStrings interleaved with connectorLineStrings (via gap metadata),
 * else coordinates, else trafficSegments.
 */
export function pathPointsFromRoute(route: RouteResult): LatLng[] {
  const lines = route.lineStrings?.filter((l) => l.length >= 2)
  if (lines?.length) {
    const connectors = route.connectorLineStrings ?? []
    const gaps = route.gaps ?? []
    const used = new Set<number>()
    const connectorAfter = new Map<number, LatLng[]>()

    for (const gap of gaps) {
      if (gap.afterSegmentIndex == null) continue
      const ci = connectors.findIndex(
        (line, i) => !used.has(i) && endpointsMatch(line, gap.from, gap.to),
      )
      if (ci < 0) continue
      used.add(ci)
      let line = connectors[ci]
      if (
        line.length >= 2 &&
        !coordsNear(line[0], gap.from) &&
        coordsNear(line[line.length - 1], gap.from)
      ) {
        line = line.slice().reverse()
      }
      connectorAfter.set(gap.afterSegmentIndex, line)
    }

    // Fallback when gaps lack afterSegmentIndex: zip connectors in list order
    // after successive segments (legacy / chain connectors).
    if (!connectorAfter.size && connectors.length) {
      const n = Math.min(connectors.length, Math.max(lines.length - 1, 0))
      for (let i = 0; i < n; i++) {
        if (connectors[i]?.length >= 2) {
          connectorAfter.set(i, connectors[i])
          used.add(i)
        }
      }
    }

    const out: LatLng[] = []
    for (let i = 0; i < lines.length; i++) {
      out.push(...lines[i])
      const conn = connectorAfter.get(i)
      if (conn?.length) out.push(...conn)
    }
    for (let i = 0; i < connectors.length; i++) {
      if (!used.has(i) && connectors[i].length >= 2) {
        out.push(...connectors[i])
      }
    }
    if (out.length >= 2) return out
  }

  if (route.coordinates && route.coordinates.length >= 2) {
    return route.coordinates
  }

  if (route.trafficSegments?.length) {
    const flat = route.trafficSegments.flatMap((s) => s.coordinates)
    if (flat.length >= 2) return flat
  }

  return []
}

/**
 * Sort steps that have `location` by distance along the route polyline from
 * the start. Steps without location keep relative order and are appended after.
 */
export function orderStepsAlongRoute(
  steps: RouteStep[],
  pathPoints: LatLng[],
): RouteStep[] {
  if (!steps.length) return steps
  if (pathPoints.length < 2) return steps

  const cumDist: number[] = [0]
  for (let i = 1; i < pathPoints.length; i++) {
    cumDist.push(cumDist[i - 1] + haversineMeters(pathPoints[i - 1], pathPoints[i]))
  }

  const withLoc: { step: RouteStep; along: number; origIdx: number }[] = []
  const withoutLoc: { step: RouteStep; origIdx: number }[] = []

  steps.forEach((step, origIdx) => {
    if (!step.location) {
      withoutLoc.push({ step, origIdx })
      return
    }
    const along = distanceAlongPath(step.location, pathPoints, cumDist)
    withLoc.push({ step, along, origIdx })
  })

  withLoc.sort((a, b) => a.along - b.along || a.origIdx - b.origIdx)
  withoutLoc.sort((a, b) => a.origIdx - b.origIdx)

  return [...withLoc.map((x) => x.step), ...withoutLoc.map((x) => x.step)]
}

/** Reorder `route.steps` by distance along the route path from the start. */
export function reorderRouteSteps(route: RouteResult): RouteResult {
  const pathPoints = pathPointsFromRoute(route)
  if (pathPoints.length < 2 || !route.steps?.length) return route
  return {
    ...route,
    steps: orderStepsAlongRoute(route.steps, pathPoints),
  }
}
