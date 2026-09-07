import { KakaoKeyMissingError } from './kakao'
import { looksLikeFerryName } from './ferryHints'
import type { LatLng, RouteResult, RouteSegment, RouteStep } from '../types'

/** Kakao Directions API allows at most 5 waypoints between origin and destination. */
export const KAKAO_MAX_WAYPOINTS = 5

export const TRAFFIC_COLORS: Record<number, string> = {
  4: '#22c55e', // 원활
  3: '#eab308', // 서행
  2: '#f97316', // 지체
  1: '#ef4444', // 정체
  6: '#7f1d1d', // 사고/통행불가
  0: '#64748b', // 정보없음
}

export function trafficStateColor(state: number | undefined | null): string {
  if (state == null) return '#3b82f6'
  return TRAFFIC_COLORS[state] ?? '#3b82f6'
}

type KakaoRoad = {
  name?: string
  distance?: number
  duration?: number
  traffic_speed?: number
  traffic_state?: number
  vertexes?: number[]
}

type KakaoGuide = {
  name?: string
  x?: number
  y?: number
  distance?: number
  duration?: number
  type?: number
  guidance?: string
  road_index?: number
}

type KakaoSection = {
  distance?: number
  duration?: number
  roads?: KakaoRoad[]
  guides?: KakaoGuide[]
}

type KakaoRoute = {
  result_code?: number
  result_msg?: string
  summary?: {
    distance?: number
    duration?: number
  }
  sections?: KakaoSection[]
}

type KakaoDirectionsResponse = {
  routes?: KakaoRoute[]
  // Some error shapes
  code?: number | string
  msg?: string
  message?: string
  error?: string
}

function vertexesToLatLng(vertexes: number[] | undefined): LatLng[] {
  if (!vertexes?.length) return []
  const out: LatLng[] = []
  for (let i = 0; i + 1 < vertexes.length; i += 2) {
    const lng = vertexes[i]
    const lat = vertexes[i + 1]
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    out.push({ lat, lng })
  }
  return out
}

function parseRoadsToSegments(sections: KakaoSection[]): RouteSegment[] {
  const segments: RouteSegment[] = []
  for (const section of sections) {
    for (const road of section.roads ?? []) {
      const name = road.name?.trim() || undefined
      // Omit ferry / open-water sailing legs from drawable traffic + stitch path.
      if (looksLikeFerryName(name)) continue
      const coordinates = vertexesToLatLng(road.vertexes)
      if (coordinates.length < 2) continue
      segments.push({
        coordinates,
        trafficState: road.traffic_state ?? 0,
        trafficSpeed: road.traffic_speed,
        name,
      })
    }
  }
  return segments
}

function parseGuidesToSteps(sections: KakaoSection[]): RouteStep[] {
  const steps: RouteStep[] = []
  for (const section of sections) {
    for (const g of section.guides ?? []) {
      const guidance = (g.guidance ?? '').trim()
      const name = (g.name ?? '').trim()
      const label = guidance || name || '진행'
      const x = g.x
      const y = g.y
      steps.push({
        type: String(g.type ?? 'guide'),
        label,
        name: name || guidance,
        distanceMeters: g.distance ?? 0,
        durationSeconds: g.duration ?? 0,
        location:
          Number.isFinite(x) && Number.isFinite(y)
            ? { lng: x as number, lat: y as number }
            : undefined,
      })
    }
  }
  return steps
}

async function parseProxyJson<T>(res: Response): Promise<T> {
  if (res.status === 503) {
    let msg = 'Kakao API key not configured'
    try {
      const body = (await res.json()) as { message?: string }
      if (body.message) msg = body.message
    } catch {
      /* ignore */
    }
    throw new KakaoKeyMissingError(msg)
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { message?: string; msg?: string; error?: string }
      detail = body.message || body.msg || body.error || ''
    } catch {
      /* ignore */
    }
    throw new Error(
      detail
        ? `카카오내비 경로 요청 실패 (${res.status}): ${detail}`
        : `카카오내비 경로 요청 실패 (${res.status})`,
    )
  }
  return (await res.json()) as T
}

/**
 * Fetch a driving route via Vite proxy → Kakao Navi Directions API.
 * points[0]=origin, points[last]=destination, middle = waypoints (max 5).
 */
export async function fetchKakaoDrivingRoute(
  points: LatLng[],
  signal?: AbortSignal,
): Promise<RouteResult> {
  if (points.length < 2) {
    throw new Error('경로를 계산하려면 지점이 2개 이상 필요합니다.')
  }

  const viaCount = points.length - 2
  if (viaCount > KAKAO_MAX_WAYPOINTS) {
    throw new Error(
      `카카오내비 경유점은 최대 ${KAKAO_MAX_WAYPOINTS}개입니다 (현재 ${viaCount}개).`,
    )
  }

  const origin = points[0]
  const destination = points[points.length - 1]
  const params = new URLSearchParams({
    origin: `${origin.lng},${origin.lat}`,
    destination: `${destination.lng},${destination.lat}`,
    priority: 'RECOMMEND',
    summary: 'false',
    road_details: 'true',
    alternatives: 'false',
  })

  if (viaCount > 0) {
    const waypoints = points
      .slice(1, -1)
      .map((p) => `${p.lng},${p.lat}`)
      .join('|')
    params.set('waypoints', waypoints)
  }

  const res = await fetch(`/api/kakao/navi/directions?${params}`, { signal })
  const data = await parseProxyJson<KakaoDirectionsResponse>(res)

  const route = data.routes?.[0]
  if (!route) {
    throw new Error(
      data.message || data.msg || '카카오내비에서 경로를 찾을 수 없습니다.',
    )
  }

  // result_code 0 = success; some responses omit it when OK
  if (
    route.result_code != null &&
    route.result_code !== 0 &&
    !route.sections?.length
  ) {
    throw new Error(
      route.result_msg ||
        `카카오내비 경로 오류 (code ${route.result_code})`,
    )
  }

  const sections = route.sections ?? []
  const trafficSegments = parseRoadsToSegments(sections)
  const coordinates = trafficSegments.flatMap((s) => s.coordinates)
  // Deduplicate consecutive duplicate vertices between segments
  const deduped: LatLng[] = []
  for (const c of coordinates) {
    const prev = deduped[deduped.length - 1]
    if (prev && prev.lat === c.lat && prev.lng === c.lng) continue
    deduped.push(c)
  }

  const distanceMeters =
    route.summary?.distance ??
    sections.reduce((sum, s) => sum + (s.distance ?? 0), 0)
  const durationSeconds =
    route.summary?.duration ??
    sections.reduce((sum, s) => sum + (s.duration ?? 0), 0)

  if (deduped.length < 2) {
    throw new Error('카카오내비 경로 좌표가 비어 있습니다.')
  }

  return {
    coordinates: deduped,
    distanceMeters,
    durationSeconds,
    steps: parseGuidesToSteps(sections),
    trafficSegments,
    source: 'kakao',
  }
}
