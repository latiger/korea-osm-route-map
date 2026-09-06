import { KakaoKeyMissingError } from './kakao'
import { fetchKakaoDrivingRoute, KAKAO_MAX_WAYPOINTS } from './kakaoNavi'
import { fetchRoute as fetchOsrmRoute } from './osrm'
import type { LatLng, RouteResult, TravelProfile } from '../types'

export {
  formatDistance,
  formatDuration,
  maneuverLabelKorean,
  maneuverSymbol,
} from './osrm'

export { trafficStateColor, TRAFFIC_COLORS, KAKAO_MAX_WAYPOINTS } from './kakaoNavi'

/**
 * Routing facade:
 * - driving → Kakao Navi (traffic) when key available and ≤5 vias; else OSRM
 * - walking → OSRM only
 */
export async function fetchRoute(
  points: LatLng[],
  profile: TravelProfile,
  signal?: AbortSignal,
): Promise<RouteResult> {
  if (profile === 'walking') {
    const r = await fetchOsrmRoute(points, profile, signal)
    return { ...r, source: r.source ?? 'osrm' }
  }

  // driving: prefer Kakao when possible
  const viaCount = Math.max(0, points.length - 2)
  if (viaCount <= KAKAO_MAX_WAYPOINTS) {
    try {
      return await fetchKakaoDrivingRoute(points, signal)
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e
      // Missing key or any Kakao failure → OSRM fallback
      if (!(e instanceof KakaoKeyMissingError)) {
        console.warn('[route] Kakao Navi failed, falling back to OSRM:', e)
      }
    }
  }

  const r = await fetchOsrmRoute(points, 'driving', signal)
  return { ...r, source: r.source ?? 'osrm' }
}
