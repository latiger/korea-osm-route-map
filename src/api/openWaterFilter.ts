import { looksLikeBridgeName, looksLikeFerryName } from './ferryHints'
import type { LatLng } from '../types'

/**
 * Max consecutive-point distance (m) to keep in one drawn polyline piece.
 * Sparse stitch / official holes often jump kilometers — Leaflet would chord those.
 */
export const POLYLINE_MAX_JUMP_M = 600

/**
 * Drop long near-straight sparse chords (ferry / open-water stitches) after
 * jump-splitting. Real bridges usually have denser vertices; coastal roads wind.
 * Tuned tighter so leftover app-drawn sea strokes disappear while dense
 * winding island roads stay.
 */
export const OPEN_WATER_MIN_LENGTH_M = 380
/** pathLen/chord above this ⇒ sinuous enough to keep (stricter = drop more straights). */
export const OPEN_WATER_STRAIGHTNESS_MAX = 1.08
/** Average vertex spacing below this ⇒ dense enough to keep (bridges / land roads). */
export const OPEN_WATER_AVG_STEP_M = 180

export function haversineMeters(a: LatLng, b: LatLng): number {
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

export function pathLengthMeters(points: LatLng[]): number {
  let sum = 0
  for (let i = 1; i < points.length; i++) {
    sum += haversineMeters(points[i - 1]!, points[i]!)
  }
  return sum
}

/**
 * Split a polyline into continuous pieces so Leaflet never draws a straight
 * chord across consecutive points farther than maxJumpM apart.
 */
export function splitPolylineOnJumps(
  points: LatLng[],
  maxJumpM: number = POLYLINE_MAX_JUMP_M,
): LatLng[][] {
  if (points.length < 2) return []
  const pieces: LatLng[][] = []
  let current: LatLng[] = [points[0]!]
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!
    const p = points[i]!
    if (haversineMeters(prev, p) > maxJumpM) {
      if (current.length > 1) pieces.push(current)
      current = [p]
    } else {
      current.push(p)
    }
  }
  if (current.length > 1) pieces.push(current)
  return pieces
}

/**
 * Heuristic for ferry / open-water chords between islands:
 * long, near-straight, sparsely sampled — or an explicit ferry-only name.
 * Bridge-named legs (대교/교량/다리) always stay; ferry dropped, bridges kept.
 * Sinuous coastal roads (path ≫ chord) and dense bridge polylines stay.
 */
export function looksLikeOpenWaterChord(
  points: LatLng[],
  name?: string | null,
): boolean {
  // Bridges always stay — never drop 대교/교량/다리 even if geometry is straight.
  if (looksLikeBridgeName(name)) return false
  // Name-based drop only for ferry-only labels (bridge cues already excluded).
  if (looksLikeFerryName(name)) return true
  if (points.length < 2) return false
  const pathLen = pathLengthMeters(points)
  if (pathLen < OPEN_WATER_MIN_LENGTH_M) return false
  const start = points[0]!
  const end = points[points.length - 1]!
  const chord = haversineMeters(start, end)
  if (chord < OPEN_WATER_MIN_LENGTH_M * 0.85) return false
  if (chord <= 0) return false
  const ratio = pathLen / chord
  if (ratio > OPEN_WATER_STRAIGHTNESS_MAX) return false
  const avgStep = pathLen / (points.length - 1)
  if (avgStep < OPEN_WATER_AVG_STEP_M) return false
  return true
}

export function dropOpenWaterPieces(
  pieces: LatLng[][],
  name?: string | null,
): LatLng[][] {
  return pieces.filter((piece) => !looksLikeOpenWaterChord(piece, name))
}

/**
 * Official MultiLineString → drawable land centerline pieces:
 * jump-split each part, drop open-water / ferry chords, keep sinuous land roads.
 */
export function officialLandUnderlay(lines: LatLng[][]): LatLng[][] {
  const out: LatLng[][] = []
  for (const line of lines) {
    if (line.length < 2) continue
    out.push(...dropOpenWaterPieces(splitPolylineOnJumps(line)))
  }
  return out
}

/** Approx distance from point to polyline (vertices + segment projections). */
export function distanceToPolylineMeters(point: LatLng, line: LatLng[]): number {
  if (line.length === 0) return Infinity
  if (line.length === 1) return haversineMeters(point, line[0]!)
  let best = Infinity
  const lat0 = (point.lat * Math.PI) / 180
  const cosLat = Math.cos(lat0)
  const R = 6371000
  const toXY = (ll: LatLng) => ({
    x: ((ll.lng - point.lng) * Math.PI) / 180 * cosLat * R,
    y: ((ll.lat - point.lat) * Math.PI) / 180 * R,
  })
  for (let i = 1; i < line.length; i++) {
    const A = toXY(line[i - 1]!)
    const B = toXY(line[i]!)
    const dx = B.x - A.x
    const dy = B.y - A.y
    const len2 = dx * dx + dy * dy
    let dist: number
    if (len2 < 1e-6) {
      dist = Math.hypot(A.x, A.y)
    } else {
      // P is origin (0,0); project onto AB
      let t = (-A.x * dx + -A.y * dy) / len2
      t = Math.max(0, Math.min(1, t))
      const qx = A.x + t * dx
      const qy = A.y + t * dy
      dist = Math.hypot(qx, qy)
    }
    if (dist < best) best = dist
  }
  return best
}

export function distanceToPolylinesMeters(
  point: LatLng,
  lines: LatLng[][],
): number {
  let best = Infinity
  for (const line of lines) {
    const d = distanceToPolylineMeters(point, line)
    if (d < best) best = d
  }
  return best
}

/** Hide map step badges farther than this from any drawable route piece. */
export const STEP_MARKER_MAX_DIST_M = 100
