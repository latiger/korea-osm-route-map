import type { GeocodeResult } from '../types'

const NOMINATIM = 'https://nominatim.openstreetmap.org'
const USER_AGENT =
  'korea-osm-route-map/1.0 (educational MVP; https://github.com/latiger/korea-osm-route-map)'

/** Korea bounding box: west,south,east,north */
const KOREA_VIEWBOX = '124.5,33.0,132.0,43.0'

export async function geocodeKorea(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const q = query.trim()
  if (!q) return []

  const params = new URLSearchParams({
    q,
    format: 'json',
    addressdetails: '1',
    limit: '8',
    countrycodes: 'kr',
    viewbox: KOREA_VIEWBOX,
    bounded: '0',
  })

  const res = await fetch(`${NOMINATIM}/search?${params}`, {
    signal,
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  })

  if (!res.ok) {
    throw new Error(`지오코딩 요청 실패 (${res.status})`)
  }

  const data = (await res.json()) as Array<{
    place_id: number
    display_name: string
    lat: string
    lon: string
    type?: string
    class?: string
  }>

  return data.map((item) => ({
    id: String(item.place_id),
    label: item.display_name,
    lat: Number(item.lat),
    lng: Number(item.lon),
    type: item.type ?? item.class,
  }))
}

export async function searchRoadsNominatim(
  roadName: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const q = roadName.trim()
  if (!q) return []

  const params = new URLSearchParams({
    street: q,
    country: 'South Korea',
    format: 'json',
    addressdetails: '1',
    limit: '10',
    countrycodes: 'kr',
  })

  const res = await fetch(`${NOMINATIM}/search?${params}`, {
    signal,
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  })

  if (!res.ok) {
    throw new Error(`도로명 검색 실패 (${res.status})`)
  }

  const data = (await res.json()) as Array<{
    place_id: number
    display_name: string
    lat: string
    lon: string
    type?: string
    class?: string
  }>

  return data.map((item) => ({
    id: String(item.place_id),
    label: item.display_name,
    lat: Number(item.lat),
    lng: Number(item.lon),
    type: item.type ?? item.class,
  }))
}
