import type { LatLng, RouteGapInfo } from '../types'

/** Absolute bearing difference (degrees) treated as a sharp reverse / U-turn. */
const UTURN_BEARING_DEG = 135
/** Connector much longer than the gap + doubles back → out-and-back. */
const OUT_AND_BACK_RATIO = 3
/** How close a later point must be to an earlier one to count as doubling back. */
const DOUBLES_BACK_NEAR_M = 80
/** Skip tiny segments when estimating polyline bearings. */
const MIN_BEARING_SEGMENT_M = 15

const REASON_UTURN = '유턴이 필요해 연결할 수 없음'
const REASON_OUT_AND_BACK = '왕복·되돌림 경로라 연결할 수 없음'

export interface ConnectorQualityInput {
  gap: Pick<RouteGapInfo, 'from' | 'to' | 'gapMeters'>
  connector: LatLng[]
  /** Official (or previous) segment ending at gap.from */
  previousPolyline?: LatLng[] | null
  /** Official (or next) segment starting at gap.to */
  nextPolyline?: LatLng[] | null
  /** Routed path length when known (falls back to polyline length) */
  connectorDistanceMeters?: number
}

export interface ConnectorQualityResult {
  ok: boolean
  reason?: string
}

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

/** Initial bearing from `from` → `to` in degrees [0, 360). */
export function bearingDegrees(from: LatLng, to: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const toDeg = (r: number) => (r * 180) / Math.PI
  const φ1 = toRad(from.lat)
  const φ2 = toRad(to.lat)
  const Δλ = toRad(to.lng - from.lng)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

/** Smallest absolute difference between two bearings, in [0, 180]. */
export function bearingDeltaDegrees(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

function pathLengthMeters(coords: LatLng[]): number {
  let sum = 0
  for (let i = 1; i < coords.length; i++) {
    sum += haversineMeters(coords[i - 1], coords[i])
  }
  return sum
}

/**
 * Bearing of travel approaching the end of a polyline
 * (last segment long enough to be meaningful).
 */
export function polylineEndBearing(poly: LatLng[]): number | null {
  if (!poly || poly.length < 2) return null
  for (let i = poly.length - 1; i >= 1; i--) {
    if (haversineMeters(poly[i - 1], poly[i]) >= MIN_BEARING_SEGMENT_M) {
      return bearingDegrees(poly[i - 1], poly[i])
    }
  }
  return bearingDegrees(poly[poly.length - 2], poly[poly.length - 1])
}

/**
 * Bearing of travel leaving the start of a polyline
 * (first segment long enough to be meaningful).
 */
export function polylineStartBearing(poly: LatLng[]): number | null {
  if (!poly || poly.length < 2) return null
  for (let i = 1; i < poly.length; i++) {
    if (haversineMeters(poly[i - 1], poly[i]) >= MIN_BEARING_SEGMENT_M) {
      return bearingDegrees(poly[i - 1], poly[i])
    }
  }
  return bearingDegrees(poly[0], poly[1])
}

function looksLikeOutAndBack(
  connector: LatLng[],
  gapMeters: number,
  distanceMeters: number,
): boolean {
  if (!(gapMeters > 0) || !(distanceMeters > 0)) return false
  if (distanceMeters / gapMeters < OUT_AND_BACK_RATIO) return false
  if (connector.length < 4) return false

  // Later points returning near an earlier prefix → doubles back
  const near = DOUBLES_BACK_NEAR_M
  const prefixEnd = Math.max(2, Math.floor(connector.length * 0.4))
  for (let i = prefixEnd; i < connector.length; i++) {
    for (let j = 0; j < Math.min(prefixEnd, i - 1); j++) {
      if (haversineMeters(connector[i], connector[j]) <= near) {
        return true
      }
    }
  }
  return false
}

/**
 * Reject connector routes that require a sharp U-turn relative to adjacent
 * official segments, or that are extreme out-and-back detours.
 */
export function assessConnectorQuality(
  input: ConnectorQualityInput,
): ConnectorQualityResult {
  const { gap, connector, previousPolyline, nextPolyline } = input
  if (!connector || connector.length < 2) {
    return { ok: false, reason: REASON_UTURN }
  }

  const dist =
    input.connectorDistanceMeters != null && input.connectorDistanceMeters > 0
      ? input.connectorDistanceMeters
      : pathLengthMeters(connector)

  const approach = previousPolyline
    ? polylineEndBearing(previousPolyline)
    : null
  const depart = polylineStartBearing(connector)
  if (approach != null && depart != null) {
    if (bearingDeltaDegrees(approach, depart) >= UTURN_BEARING_DEG) {
      return { ok: false, reason: REASON_UTURN }
    }
  }

  const arrival = polylineEndBearing(connector)
  const continueBearing = nextPolyline
    ? polylineStartBearing(nextPolyline)
    : null
  if (arrival != null && continueBearing != null) {
    if (bearingDeltaDegrees(arrival, continueBearing) >= UTURN_BEARING_DEG) {
      return { ok: false, reason: REASON_UTURN }
    }
  }

  if (looksLikeOutAndBack(connector, gap.gapMeters, dist)) {
    return { ok: false, reason: REASON_OUT_AND_BACK }
  }

  return { ok: true }
}
