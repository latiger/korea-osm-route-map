import type { GeocodeResult } from '../types'

const NOMINATIM = 'https://nominatim.openstreetmap.org'
const USER_AGENT =
  'korea-osm-route-map/1.0 (educational MVP; https://github.com/latiger/korea-osm-route-map)'

/** Korea bounding box: west,south,east,north */
const KOREA_VIEWBOX = '124.5,33.0,132.0,43.0'

/** ~50m — client-side only; do not dedupe by name (동명 마을이 전국에 많음) */
const DEDUPE_METERS = 50

type NominatimAddress = {
  state?: string
  province?: string
  city?: string
  county?: string
  town?: string
  municipality?: string
  city_district?: string
  borough?: string
  district?: string
  suburb?: string
  quarter?: string
  neighbourhood?: string
  village?: string
  hamlet?: string
  road?: string
  pedestrian?: string
  house_number?: string
  [key: string]: string | undefined
}

type NominatimHit = {
  place_id: number
  display_name: string
  lat: string
  lon: string
  type?: string
  class?: string
  address?: NominatimAddress
}

function trim(v: string | undefined): string | undefined {
  const t = v?.trim()
  return t || undefined
}

function endsWithAny(s: string, suffixes: string[]): boolean {
  return suffixes.some((x) => s.endsWith(x))
}

/**
 * Prefer 시/도 · 시/군/구 · 읍/면 · 리/동 · (road/house) so same-named 리 are distinguishable.
 * Falls back to display_name when address parts are missing.
 */
function buildKoreaLabel(item: NominatimHit): string {
  const addr = item.address
  if (!addr) return item.display_name

  const sido = trim(addr.state) || trim(addr.province)

  const gu =
    trim(addr.city_district) || trim(addr.borough) || trim(addr.district)
  const county = trim(addr.county)
  const city = trim(addr.city)
  // 시/군/구: prefer 구, then 군, then 시 (skip if city duplicates 시/도 e.g. 서울특별시)
  let sigungu = gu || county
  if (!sigungu && city && city !== sido) sigungu = city

  const town = trim(addr.town)
  const municipality = trim(addr.municipality)
  const suburb = trim(addr.suburb)

  // 읍/면
  let eupmyeon: string | undefined
  for (const cand of [municipality, town, suburb]) {
    if (cand && endsWithAny(cand, ['읍', '면'])) {
      eupmyeon = cand
      break
    }
  }

  // 리/동
  let ridong =
    trim(addr.village) ||
    trim(addr.hamlet) ||
    trim(addr.quarter) ||
    trim(addr.neighbourhood)
  if (!ridong && suburb && suburb !== eupmyeon) {
    if (endsWithAny(suburb, ['동', '리', '가']) || !eupmyeon) ridong = suburb
  }
  if (!ridong && town && town !== eupmyeon && endsWithAny(town, ['동', '리'])) {
    ridong = town
  }

  const road = trim(addr.road) || trim(addr.pedestrian)
  const house = trim(addr.house_number)
  const roadPart = road && house ? `${road} ${house}` : road || house

  const parts = [sido, sigungu, eupmyeon, ridong, roadPart].filter(
    (p): p is string => Boolean(p),
  )

  // Need at least 시·군 level clarity; otherwise display_name is safer
  if (parts.length < 2) return item.display_name
  return parts.join(' · ')
}

function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = (a.lat - b.lat) * 111_320
  const dLng =
    (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180)
  return Math.hypot(dLat, dLng)
}

/** Keep distinct places; collapse only near-identical coordinates (~50m). */
function dedupeByProximity(results: GeocodeResult[]): GeocodeResult[] {
  const out: GeocodeResult[] = []
  for (const r of results) {
    const dup = out.some((o) => distanceMeters(o, r) < DEDUPE_METERS)
    if (!dup) out.push(r)
  }
  return out
}

function mapResults(data: NominatimHit[]): GeocodeResult[] {
  return data.map((item) => ({
    id: String(item.place_id),
    label: buildKoreaLabel(item),
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

  // Nominatim/OSM ≠ 행정안전부 도로명주소 DB — complete KR coverage needs Juso API later.
  const params = new URLSearchParams({
    q,
    format: 'json',
    addressdetails: '1',
    limit: '30',
    dedupe: '0',
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

  const data = (await res.json()) as NominatimHit[]
  return dedupeByProximity(mapResults(data))
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

  const streetData = (await streetRes.json()) as NominatimHit[]
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

  const freeData = (await freeRes.json()) as NominatimHit[]
  return mapResults(freeData)
}
