import type { LatLng, RouteResult, RouteStep, TravelProfile } from '../types'

const OSRM = 'https://router.project-osrm.org'

interface OsrmManeuver {
  type?: string
  modifier?: string
  location?: [number, number]
}

interface OsrmStep {
  distance: number
  duration: number
  name?: string
  maneuver?: OsrmManeuver
  mode?: string
}

interface OsrmLeg {
  steps?: OsrmStep[]
  distance?: number
  duration?: number
}

/** Map OSRM maneuver type + modifier to a short Korean label. */
export function maneuverLabelKorean(
  type: string | undefined,
  modifier: string | undefined,
): string {
  const t = (type ?? '').toLowerCase()
  const m = (modifier ?? '').toLowerCase()

  if (t === 'depart') return '출발'
  if (t === 'arrive') return '도착'

  if (t === 'roundabout' || t === 'rotary') return '회전교차로'
  if (t === 'exit roundabout' || t === 'exit rotary') return '회전교차로 진출'
  if (t === 'roundabout turn') {
    if (m.includes('left')) return '회전교차로 좌회전'
    if (m.includes('right')) return '회전교차로 우회전'
    return '회전교차로'
  }

  if (t === 'on ramp') {
    if (m.includes('left')) return '램프 진입 (좌)'
    if (m.includes('right')) return '램프 진입 (우)'
    return '램프 진입'
  }
  if (t === 'off ramp') {
    if (m.includes('left')) return '램프 진출 (좌)'
    if (m.includes('right')) return '램프 진출 (우)'
    return '램프 진출'
  }

  if (t === 'merge') {
    if (m.includes('left')) return '합류 (좌)'
    if (m.includes('right')) return '합류 (우)'
    return '합류'
  }

  if (t === 'fork') {
    if (m.includes('left')) return '분기 (좌)'
    if (m.includes('right')) return '분기 (우)'
    if (m === 'straight') return '분기 (직진)'
    return '분기'
  }

  if (t === 'end of road') {
    if (m.includes('left')) return '도로 끝 좌회전'
    if (m.includes('right')) return '도로 끝 우회전'
    return '도로 끝'
  }

  if (t === 'new name' || t === 'continue' || t === 'notification') {
    if (m === 'straight' || !m) return '직진'
    if (m === 'uturn') return '유턴'
    if (m.includes('sharp') && m.includes('left')) return '급좌회전'
    if (m.includes('sharp') && m.includes('right')) return '급우회전'
    if (m.includes('slight') && m.includes('left')) return '약간 좌측'
    if (m.includes('slight') && m.includes('right')) return '약간 우측'
    if (m.includes('left')) return '좌회전'
    if (m.includes('right')) return '우회전'
    return '직진'
  }

  // turn and other types driven mainly by modifier
  if (m === 'uturn') return '유턴'
  if (m.includes('sharp') && m.includes('left')) return '급좌회전'
  if (m.includes('sharp') && m.includes('right')) return '급우회전'
  if (m.includes('slight') && m.includes('left')) return '약간 좌측'
  if (m.includes('slight') && m.includes('right')) return '약간 우측'
  if (m.includes('left')) return '좌회전'
  if (m.includes('right')) return '우회전'
  if (m === 'straight') return '직진'

  if (t === 'turn') return '회전'
  if (t) return '진행'
  return '직진'
}

/** Arrow / symbol for a maneuver (used in the step list UI). */
export function maneuverSymbol(
  type: string | undefined,
  modifier: string | undefined,
): string {
  const t = (type ?? '').toLowerCase()
  const m = (modifier ?? '').toLowerCase()

  if (t === 'depart') return '●'
  if (t === 'arrive') return '◎'
  if (t === 'connect') return '↔'
  if (t === 'roundabout' || t === 'rotary' || t === 'exit roundabout' || t === 'exit rotary')
    return '↻'
  if (m === 'uturn') return '↩'
  if (m.includes('sharp') && m.includes('left')) return '↰'
  if (m.includes('sharp') && m.includes('right')) return '↱'
  if (m.includes('slight') && m.includes('left')) return '↖'
  if (m.includes('slight') && m.includes('right')) return '↗'
  if (m.includes('left')) return '←'
  if (m.includes('right')) return '→'
  if (m === 'straight' || t === 'new name' || t === 'continue') return '↑'
  return '→'
}

function parseSteps(legs: OsrmLeg[] | undefined): RouteStep[] {
  if (!legs?.length) return []
  const out: RouteStep[] = []
  for (const leg of legs) {
    for (const step of leg.steps ?? []) {
      const type = step.maneuver?.type ?? ''
      const modifier = step.maneuver?.modifier
      const loc = step.maneuver?.location
      out.push({
        type,
        modifier,
        label: maneuverLabelKorean(type, modifier),
        name: (step.name ?? '').trim(),
        distanceMeters: step.distance ?? 0,
        durationSeconds: step.duration ?? 0,
        location: loc
          ? { lng: loc[0], lat: loc[1] }
          : undefined,
      })
    }
  }
  return out
}

export async function fetchRoute(
  points: LatLng[],
  profile: TravelProfile,
  signal?: AbortSignal,
): Promise<RouteResult> {
  if (points.length < 2) {
    throw new Error('경로를 계산하려면 지점이 2개 이상 필요합니다.')
  }

  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';')
  const url =
    `${OSRM}/route/v1/${profile}/${coords}` +
    `?overview=full&geometries=geojson&steps=true`

  const res = await fetch(url, { signal })
  if (!res.ok) {
    throw new Error(`경로 요청 실패 (${res.status})`)
  }

  const data = (await res.json()) as {
    code: string
    routes?: Array<{
      distance: number
      duration: number
      geometry: { coordinates: [number, number][] }
      legs?: OsrmLeg[]
    }>
    message?: string
  }

  if (data.code !== 'Ok' || !data.routes?.[0]) {
    throw new Error(
      data.message
        ? `경로를 찾을 수 없습니다: ${data.message}`
        : '경로를 찾을 수 없습니다. 지점을 확인해 주세요.',
    )
  }

  const route = data.routes[0]
  return {
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    coordinates: route.geometry.coordinates.map(([lng, lat]) => ({
      lat,
      lng,
    })),
    steps: parseSteps(route.legs),
    source: 'osrm',
  }
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(1)} km`
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}시간 ${m}분`
  if (m > 0) return `${m}분`
  return `${s}초`
}
