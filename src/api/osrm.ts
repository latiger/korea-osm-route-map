import type { LatLng, RouteResult, TravelProfile } from '../types'

const OSRM = 'https://router.project-osrm.org'

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
    `?overview=full&geometries=geojson&steps=false`

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
