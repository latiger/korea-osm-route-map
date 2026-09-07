import { KakaoKeyMissingError } from './kakao'
import { fetchKakaoDrivingRoute, KAKAO_MAX_WAYPOINTS } from './kakaoNavi'
import {
  fetchNaverDrivingRoute,
  NAVER_MAX_WAYPOINTS,
  NaverKeyMissingError,
} from './naverNavi'
import { fetchRoute as fetchOsrmRoute } from './osrm'
import type {
  LatLng,
  RouteResult,
  RoutingProvider,
  TravelProfile,
} from '../types'

export {
  formatDistance,
  formatDuration,
  maneuverLabelKorean,
  maneuverSymbol,
} from './osrm'

export { trafficStateColor, TRAFFIC_COLORS, KAKAO_MAX_WAYPOINTS } from './kakaoNavi'
export { NAVER_MAX_WAYPOINTS, NaverKeyMissingError } from './naverNavi'

export type { RoutingProvider }

const PROVIDER_STORAGE_KEY = 'route-provider'

export function loadStoredProvider(): RoutingProvider {
  try {
    const v = localStorage.getItem(PROVIDER_STORAGE_KEY)
    if (v === 'kakao' || v === 'naver' || v === 'auto') return v
  } catch {
    /* ignore */
  }
  return 'auto'
}

export function storeProvider(p: RoutingProvider): void {
  try {
    localStorage.setItem(PROVIDER_STORAGE_KEY, p)
  } catch {
    /* ignore */
  }
}

function fallbackHint(kind: 'key' | 'quota' | 'fail', who: string): string {
  if (kind === 'key') return `${who} 키 없음 → OSRM 폴백`
  if (kind === 'quota') return `${who} 할당량/한도 → 폴백`
  return `${who} 실패 → 폴백`
}

function classifyProviderError(
  e: unknown,
): { kind: 'key' | 'quota' | 'fail'; message: string } {
  if (e instanceof KakaoKeyMissingError || e instanceof NaverKeyMissingError) {
    return { kind: 'key', message: e.message }
  }
  const msg = ((e as Error)?.message ?? '').toLowerCase()
  if (
    /quota|rate.?limit|429|한도|할당|exceed|daily|usage/i.test(msg) ||
    /\b429\b/.test(msg)
  ) {
    return { kind: 'quota', message: (e as Error).message }
  }
  return { kind: 'fail', message: (e as Error)?.message ?? 'unknown' }
}

async function tryKakao(
  points: LatLng[],
  signal?: AbortSignal,
): Promise<{ route?: RouteResult; hint?: string }> {
  const viaCount = Math.max(0, points.length - 2)
  if (viaCount > KAKAO_MAX_WAYPOINTS) {
    return { hint: `카카오 경유지 ${KAKAO_MAX_WAYPOINTS}개 초과 → 폴백` }
  }
  try {
    return { route: await fetchKakaoDrivingRoute(points, signal) }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    const c = classifyProviderError(e)
    if (!(e instanceof KakaoKeyMissingError)) {
      console.warn('[route] Kakao Navi failed:', e)
    }
    return { hint: fallbackHint(c.kind, '카카오') }
  }
}

async function tryNaver(
  points: LatLng[],
  signal?: AbortSignal,
): Promise<{ route?: RouteResult; hint?: string }> {
  const viaCount = Math.max(0, points.length - 2)
  if (viaCount > NAVER_MAX_WAYPOINTS) {
    return { hint: `네이버 경유지 ${NAVER_MAX_WAYPOINTS}개 초과 → 폴백` }
  }
  try {
    return { route: await fetchNaverDrivingRoute(points, signal) }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    const c = classifyProviderError(e)
    if (!(e instanceof NaverKeyMissingError)) {
      console.warn('[route] Naver Directions failed:', e)
    }
    return { hint: fallbackHint(c.kind, '네이버') }
  }
}

async function osrmFallback(
  points: LatLng[],
  signal?: AbortSignal,
  hint?: string,
): Promise<RouteResult> {
  const r = await fetchOsrmRoute(points, 'driving', signal)
  return {
    ...r,
    source: r.source ?? 'osrm',
    fallbackNote: hint,
  }
}

/**
 * Routing facade:
 * - walking → OSRM only
 * - driving kakao → Kakao then OSRM
 * - driving naver → Naver then OSRM
 * - driving auto → Kakao then Naver then OSRM
 */
export async function fetchRoute(
  points: LatLng[],
  profile: TravelProfile,
  signal?: AbortSignal,
  provider: RoutingProvider = 'auto',
): Promise<RouteResult> {
  if (profile === 'walking') {
    const r = await fetchOsrmRoute(points, profile, signal)
    return { ...r, source: r.source ?? 'osrm' }
  }

  const hints: string[] = []

  if (provider === 'kakao') {
    const k = await tryKakao(points, signal)
    if (k.route) return k.route
    if (k.hint) hints.push(k.hint)
    return osrmFallback(points, signal, hints.join(' · ') || undefined)
  }

  if (provider === 'naver') {
    const n = await tryNaver(points, signal)
    if (n.route) return n.route
    if (n.hint) hints.push(n.hint)
    return osrmFallback(points, signal, hints.join(' · ') || undefined)
  }

  // auto: Kakao → Naver → OSRM
  const k = await tryKakao(points, signal)
  if (k.route) return k.route
  if (k.hint) hints.push(k.hint)

  const n = await tryNaver(points, signal)
  if (n.route) {
    return {
      ...n.route,
      fallbackNote: hints.length ? hints.join(' · ') : undefined,
    }
  }
  if (n.hint) hints.push(n.hint)

  return osrmFallback(points, signal, hints.join(' · ') || undefined)
}
