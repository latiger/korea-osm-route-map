import type { LatLng, RouteResult, RouteSegment, RouteStep } from '../types'
import { looksLikeFerryName } from './ferryHints'

/** Naver Directions 5 allows at most 5 waypoints between origin and destination. */
export const NAVER_MAX_WAYPOINTS = 5
/** Naver Directions 15 allows at most 15 waypoints. */
export const NAVER_MAX_WAYPOINTS_15 = 15

/** Thrown when proxy has no Naver keys (503). */
export class NaverKeyMissingError extends Error {
  constructor(message = 'Naver API keys not configured') {
    super(message)
    this.name = 'NaverKeyMissingError'
  }
}

type NaverGuide = {
  pointIndex?: number
  type?: number
  instructions?: string
  distance?: number
  duration?: number
}

type NaverSection = {
  pointIndex?: number
  pointCount?: number
  distance?: number
  name?: string
  congestion?: number
  speed?: number
}

type NaverRouteOption = {
  summary?: {
    distance?: number
    duration?: number
  }
  path?: number[][]
  section?: NaverSection[]
  guide?: NaverGuide[]
}

type NaverDirectionsResponse = {
  code?: number
  message?: string
  route?: Record<string, NaverRouteOption[]>
}

/** Map Naver congestion (0–3) onto Kakao-like traffic_state for shared colors. */
function congestionToTrafficState(congestion: number | undefined): number {
  switch (congestion) {
    case 1:
      return 4 // 원활
    case 2:
      return 3 // 서행
    case 3:
      return 1 // 정체
    default:
      return 0
  }
}

function guideLabel(g: NaverGuide): string {
  const text = (g.instructions ?? '').trim()
  if (text) return text
  switch (g.type) {
    case 1:
      return '직진'
    case 2:
      return '좌회전'
    case 3:
      return '우회전'
    case 6:
      return '유턴'
    case 87:
      return '경유지'
    case 88:
      return '목적지'
    default:
      return '진행'
  }
}

function parsePath(path: number[][] | undefined): LatLng[] {
  if (!path?.length) return []
  const out: LatLng[] = []
  for (const pt of path) {
    const lng = pt[0]
    const lat = pt[1]
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    const prev = out[out.length - 1]
    if (prev && prev.lat === lat && prev.lng === lng) continue
    out.push({ lat, lng })
  }
  return out
}

function sectionPrefersNationalRoad(name: string | undefined, routeHint?: string): boolean {
  if (!name) return false
  if (/국도/.test(name)) return true
  if (routeHint) {
    const num = routeHint.match(/(\d+)/)?.[1]
    if (num && name.includes(num) && /국도|호선|번/.test(name)) return true
  }
  return false
}

function parseSectionsToTraffic(
  path: LatLng[],
  sections: NaverSection[] | undefined,
  opts?: { preferNationalRoad?: boolean; routeHint?: string },
): RouteSegment[] | undefined {
  if (!sections?.length || path.length < 2) return undefined
  const segments: RouteSegment[] = []
  for (const sec of sections) {
    const name = sec.name?.trim() || undefined
    // Ferry dropped, bridges kept (대교/교량/다리 beat 페리/항로 labels).
    if (looksLikeFerryName(name)) continue
    const start = sec.pointIndex ?? 0
    const count = sec.pointCount ?? 0
    if (count < 1) continue
    const end = Math.min(start + count, path.length - 1)
    const coordinates = path.slice(start, end + 1)
    if (coordinates.length < 2) continue
    segments.push({
      coordinates,
      trafficState: congestionToTrafficState(sec.congestion),
      trafficSpeed: sec.speed,
      name,
    })
  }

  if (
    opts?.preferNationalRoad &&
    segments.some((s) => sectionPrefersNationalRoad(s.name, opts.routeHint))
  ) {
    // Prefer keeping 국도-named sections for display continuity; drop unnamed
    // detours only when a national-road named section exists nearby is too
    // aggressive — keep all non-ferry, but sort 국도 names first for steps.
    return segments
  }
  return segments.length ? segments : undefined
}

/** Flatten traffic segments into a coordinate list (dedup consecutive tips). */
function coordinatesFromTraffic(segments: RouteSegment[]): LatLng[] {
  const out: LatLng[] = []
  for (const seg of segments) {
    for (const c of seg.coordinates) {
      const prev = out[out.length - 1]
      if (prev && prev.lat === c.lat && prev.lng === c.lng) continue
      out.push(c)
    }
  }
  return out
}

function parseGuidesToSteps(
  path: LatLng[],
  guides: NaverGuide[] | undefined,
): RouteStep[] {
  if (!guides?.length) return []
  return guides.map((g) => {
    const idx = g.pointIndex
    const location =
      idx != null && path[idx]
        ? path[idx]
        : undefined
    return {
      type: String(g.type ?? 'guide'),
      label: guideLabel(g),
      name: (g.instructions ?? '').trim(),
      distanceMeters: g.distance ?? 0,
      // Naver durations are milliseconds
      durationSeconds: Math.round((g.duration ?? 0) / 1000),
      location,
    }
  })
}

async function parseProxyJson<T>(res: Response): Promise<T> {
  if (res.status === 503) {
    let msg = 'Naver API keys not configured'
    try {
      const body = (await res.json()) as { message?: string }
      if (body.message) msg = body.message
    } catch {
      /* ignore */
    }
    throw new NaverKeyMissingError(msg)
  }
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as {
        message?: string
        error?: string
        errorMessage?: string
      }
      detail = body.message || body.errorMessage || body.error || ''
    } catch {
      /* ignore */
    }
    throw new Error(
      detail
        ? `네이버 길찾기 요청 실패 (${res.status}): ${detail}`
        : `네이버 길찾기 요청 실패 (${res.status})`,
    )
  }
  return (await res.json()) as T
}

function parseDirectionsResponse(
  data: NaverDirectionsResponse,
  opts?: { preferNationalRoad?: boolean; routeHint?: string },
): RouteResult {
  if (data.code != null && data.code !== 0) {
    throw new Error(
      data.message || `네이버 길찾기 오류 (code ${data.code})`,
    )
  }

  const routeBag = data.route
  if (!routeBag) {
    throw new Error(data.message || '네이버에서 경로를 찾을 수 없습니다.')
  }

  const optionKey =
    (['traoptimal', 'trafast', 'tracomfort'] as const).find(
      (k) => routeBag[k]?.length,
    ) ?? Object.keys(routeBag).find((k) => routeBag[k]?.length)

  if (!optionKey) {
    throw new Error(data.message || '네이버에서 경로를 찾을 수 없습니다.')
  }

  const route = routeBag[optionKey]![0]
  const rawPath = parsePath(route.path)
  if (rawPath.length < 2) {
    throw new Error('네이버 경로 좌표가 비어 있습니다.')
  }

  const omittedFerry = (route.section ?? []).some((sec) =>
    looksLikeFerryName(sec.name?.trim()),
  )
  const trafficSegments = parseSectionsToTraffic(rawPath, route.section, opts)
  const coordinates =
    omittedFerry && trafficSegments && trafficSegments.length > 0
      ? coordinatesFromTraffic(trafficSegments)
      : rawPath
  if (coordinates.length < 2) {
    throw new Error('네이버 경로 좌표가 비어 있습니다.')
  }

  const distanceMeters = route.summary?.distance ?? 0
  const durationMs = route.summary?.duration ?? 0
  const durationSeconds = Math.round(durationMs / 1000)

  let steps = parseGuidesToSteps(rawPath, route.guide)
  if (opts?.preferNationalRoad && opts.routeHint) {
    steps = steps.map((s) => {
      const name = s.name || s.label
      if (sectionPrefersNationalRoad(name, opts.routeHint)) return s
      return s
    })
  }

  return {
    coordinates,
    distanceMeters,
    durationSeconds,
    steps,
    trafficSegments,
    source: 'naver',
  }
}

async function fetchNaverDriving(
  points: LatLng[],
  apiPath: '/api/naver/direction' | '/api/naver/direction15',
  maxVias: number,
  signal?: AbortSignal,
  opts?: { preferNationalRoad?: boolean; routeHint?: string },
): Promise<RouteResult> {
  if (points.length < 2) {
    throw new Error('경로를 계산하려면 지점이 2개 이상 필요합니다.')
  }

  const viaCount = points.length - 2
  if (viaCount > maxVias) {
    throw new Error(
      `네이버 길찾기 경유점은 최대 ${maxVias}개입니다 (현재 ${viaCount}개).`,
    )
  }

  const origin = points[0]!
  const destination = points[points.length - 1]!
  const params = new URLSearchParams({
    start: `${origin.lng},${origin.lat}`,
    goal: `${destination.lng},${destination.lat}`,
    option: 'traoptimal',
  })

  if (viaCount > 0) {
    const waypoints = points
      .slice(1, -1)
      .map((p) => `${p.lng},${p.lat}`)
      .join('|')
    params.set('waypoints', waypoints)
  }

  const res = await fetch(`${apiPath}?${params}`, { signal })
  const data = await parseProxyJson<NaverDirectionsResponse>(res)
  return parseDirectionsResponse(data, opts)
}

/**
 * Fetch a driving route via Vite proxy → Naver Directions 5.
 * points[0]=origin, points[last]=destination, middle = waypoints (max 5).
 */
export async function fetchNaverDrivingRoute(
  points: LatLng[],
  signal?: AbortSignal,
  opts?: { preferNationalRoad?: boolean; routeHint?: string },
): Promise<RouteResult> {
  return fetchNaverDriving(
    points,
    '/api/naver/direction',
    NAVER_MAX_WAYPOINTS,
    signal,
    opts,
  )
}

/**
 * Fetch a driving route via Vite proxy → Naver Directions 15 (≤15 vias).
 * Prefer for long corridor rebuilds (국도 7 등).
 */
export async function fetchNaverDrivingRoute15(
  points: LatLng[],
  signal?: AbortSignal,
  opts?: { preferNationalRoad?: boolean; routeHint?: string },
): Promise<RouteResult> {
  return fetchNaverDriving(
    points,
    '/api/naver/direction15',
    NAVER_MAX_WAYPOINTS_15,
    signal,
    opts,
  )
}
