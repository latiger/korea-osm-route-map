import type { GeocodeResult } from '../types'

const NOMINATIM = 'https://nominatim.openstreetmap.org'
const USER_AGENT =
  'korea-osm-route-map/1.0 (educational MVP; https://github.com/latiger/korea-osm-route-map)'

/** Korea bounding box: west,south,east,north */
const KOREA_VIEWBOX = '124.5,33.0,132.0,43.0'

function mapResults(
  data: Array<{
    place_id: number
    display_name: string
    lat: string
    lon: string
    type?: string
    class?: string
  }>,
): GeocodeResult[] {
  return data.map((item) => ({
    id: String(item.place_id),
    label: item.display_name,
    lat: Number(item.lat),
    lng: Number(item.lon),
    type: item.type ?? item.class,
  }))
}

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

  return mapResults(data)
}

export async function searchRoadsNominatim(
  roadName: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const q = roadName.trim()
  if (!q) return []

  const streetParams = new URLSearchParams({
    street: q,
    country: 'South Korea',
    format: 'json',
    addressdetails: '1',
    limit: '10',
    countrycodes: 'kr',
  })

  const streetRes = await fetch(`${NOMINATIM}/search?${streetParams}`, {
    signal,
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  })

  if (!streetRes.ok) {
    throw new Error(`도로명 검색 실패 (${streetRes.status})`)
  }

  const streetData = (await streetRes.json()) as Array<{
    place_id: number
    display_name: string
    lat: string
    lon: string
    type?: string
    class?: string
  }>

  const streetResults = mapResults(streetData)
  if (streetResults.length > 0) return streetResults

  // Secondary fallback: free-text q= (better for 국도/고속도로 / named highways)
  const freeParams = new URLSearchParams({
    q: `${q}, South Korea`,
    format: 'json',
    addressdetails: '1',
    limit: '10',
    countrycodes: 'kr',
    viewbox: KOREA_VIEWBOX,
    bounded: '0',
  })

  const freeRes = await fetch(`${NOMINATIM}/search?${freeParams}`, {
    signal,
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  })

  if (!freeRes.ok) {
    throw new Error(`도로명 검색 실패 (${freeRes.status})`)
  }

  const freeData = (await freeRes.json()) as Array<{
    place_id: number
    display_name: string
    lat: string
    lon: string
    type?: string
    class?: string
  }>

  return mapResults(freeData)
}
