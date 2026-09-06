import type { GeocodeResult, LatLng } from '../types'

const NOMINATIM = 'https://nominatim.openstreetmap.org'
const USER_AGENT =
  'korea-osm-route-map/1.0 (educational MVP; https://github.com/latiger/korea-osm-route-map)'

/** Korea bounding box: west,south,east,north */
const KOREA_VIEWBOX = '124.5,33.0,132.0,43.0'

/** ~50m — client-side only; do not dedupe by name (동명 마을이 전국에 많음) */
const DEDUPE_METERS = 50

const HANGUL_RE = /[\uAC00-\uD7A3]/

/** ISO3166-2-lvl4 → Korean 시/도 (fallback when English admin names appear) */
const ISO_LVL4_KO: Record<string, string> = {
  'KR-11': '서울특별시',
  'KR-26': '부산광역시',
  'KR-27': '대구광역시',
  'KR-28': '인천광역시',
  'KR-29': '광주광역시',
  'KR-30': '대전광역시',
  'KR-31': '울산광역시',
  'KR-41': '경기도',
  'KR-42': '강원특별자치도',
  'KR-43': '충청북도',
  'KR-44': '충청남도',
  'KR-45': '전북특별자치도',
  'KR-46': '전라남도',
  'KR-47': '경상북도',
  'KR-48': '경상남도',
  'KR-49': '제주특별자치도',
  'KR-50': '세종특별자치시',
}

const ENGLISH_ADMIN_MARKERS = [
  'special',
  'metropolitan',
  'province',
  'south korea',
  'north korea',
  'chungcheong',
  'gyeongsang',
  'gyeonggi',
  'gangwon',
  'jeonnam',
  'jeonbuk',
  'jeolla',
  'jeju',
  'gwangju',
  'busan',
  'incheon',
  'daegu',
  'daejeon',
  'ulsan',
  'seoul',
  'sejong',
]

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
  'ISO3166-2-lvl4'?: string
  [key: string]: string | undefined
}

type NominatimHit = {
  place_id: number
  display_name: string
  lat: string
  lon: string
  name?: string
  type?: string
  class?: string
  addresstype?: string
  address?: NominatimAddress
}

const NOMINATIM_HEADERS: HeadersInit = {
  Accept: 'application/json',
  'Accept-Language': 'ko',
  'User-Agent': USER_AGENT,
}

function trim(v: string | undefined): string | undefined {
  const t = v?.trim()
  return t || undefined
}

function hasHangul(s: string): boolean {
  return HANGUL_RE.test(s)
}

function latinLetterRatio(s: string): number {
  const letters = s.replace(/[^A-Za-z\uAC00-\uD7A3]/g, '')
  if (!letters.length) return 0
  const latin = (s.match(/[A-Za-z]/g) || []).length
  return latin / letters.length
}

/** True when the value is mostly Latin and looks like English OSM admin junk. */
function isEnglishAdminJunk(s: string): boolean {
  if (hasHangul(s) && latinLetterRatio(s) < 0.45) return false
  if (!/[A-Za-z]/.test(s)) return false
  if (latinLetterRatio(s) < 0.55) return false

  const lower = s.toLowerCase()
  if (ENGLISH_ADMIN_MARKERS.some((w) => lower.includes(w))) return true
  // Romanized admin suffixes without Hangul: Naju-si, Oryong-ri, …
  if (/-(si|gun|gu|do|ri|eup|myeon|dong|ro|gil)\b/i.test(s)) return true
  // Pure Latin phrase with spaces/hyphens (e.g. "South Chungcheong")
  if (/^[A-Za-z][A-Za-z\s\-'.]+$/.test(s)) return true
  return false
}

/** Prefer Korean / Hangul address parts; drop English admin junk. */
function preferKorean(v: string | undefined): string | undefined {
  const t = trim(v)
  if (!t) return undefined
  if (isEnglishAdminJunk(t)) return undefined
  return t
}

function endsWithAny(s: string, suffixes: string[]): boolean {
  return suffixes.some((x) => s.endsWith(x))
}

function looksLikeSido(s: string): boolean {
  return (
    endsWithAny(s, [
      '특별시',
      '광역시',
      '특별자치시',
      '특별자치도',
      '도',
    ]) || s.includes('통합특별시')
  )
}

function hangulSegmentsFromDisplay(display: string): string[] {
  return display
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && hasHangul(p) && !isEnglishAdminJunk(p))
    // Drop country / postcode-only segments
    .filter((p) => p !== '대한민국' && p !== '남한' && !/^\d{5}$/.test(p))
}

/**
 * Prefer 시/도 · 시/군/구 · 읍/면 · 리/동 · (road/house) so same-named 리 are distinguishable.
 * Prefer Hangul / name:ko-style values; skip English OSM admin names.
 * Falls back to Hangul segments of display_name, then best available.
 */
function buildKoreaLabel(item: NominatimHit): string {
  const addr = item.address
  if (!addr) {
    const segs = hangulSegmentsFromDisplay(item.display_name)
    if (segs.length) return segs.slice(0, 5).join(' · ')
    return item.display_name
  }

  const iso =
    preferKorean(ISO_LVL4_KO[addr['ISO3166-2-lvl4'] ?? '']) ||
    trim(ISO_LVL4_KO[addr['ISO3166-2-lvl4'] ?? ''])

  let sido =
    preferKorean(addr.state) || preferKorean(addr.province) || iso

  const gu =
    preferKorean(addr.city_district) ||
    preferKorean(addr.borough) ||
    preferKorean(addr.district)
  const county = preferKorean(addr.county)
  const city = preferKorean(addr.city)

  // When city is actually 시/도 (서울특별시 등) and sido missing, promote it
  if (!sido && city && looksLikeSido(city)) {
    sido = city
  }

  // 시/군/구: prefer 구, then 군, then 시 (skip if city duplicates 시/도)
  let sigungu = gu || county
  if (!sigungu && city && city !== sido && !looksLikeSido(city)) {
    sigungu = city
  }

  const town = preferKorean(addr.town)
  const municipality = preferKorean(addr.municipality)
  const suburb = preferKorean(addr.suburb)

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
    preferKorean(addr.village) ||
    preferKorean(addr.hamlet) ||
    preferKorean(addr.quarter) ||
    preferKorean(addr.neighbourhood)
  if (!ridong && suburb && suburb !== eupmyeon) {
    if (endsWithAny(suburb, ['동', '리', '가']) || !eupmyeon) ridong = suburb
  }
  if (!ridong && town && town !== eupmyeon && endsWithAny(town, ['동', '리'])) {
    ridong = town
  }

  const road = preferKorean(addr.road) || preferKorean(addr.pedestrian)
  const house = preferKorean(addr.house_number)
  const roadPart = road && house ? `${road} ${house}` : road || house

  // Named POI (역, 건물 등) when present and Hangul / not junk
  const namedPlace =
    preferKorean(item.name) ||
    (item.addresstype
      ? preferKorean(addr[item.addresstype])
      : undefined) ||
    preferKorean(addr.railway) ||
    preferKorean(addr.amenity) ||
    preferKorean(addr.tourism) ||
    preferKorean(addr.building)

  const parts = [sido, sigungu, eupmyeon, ridong, roadPart].filter(
    (p): p is string => Boolean(p),
  )

  // Prepend POI name when it isn't already in the hierarchy
  if (namedPlace && !parts.includes(namedPlace)) {
    // Put name first for recognizability (서울역 · 서울특별시 · …)
    parts.unshift(namedPlace)
  }

  if (parts.length >= 2) return parts.join(' · ')

  // Rebuild from Hangul address values
  const hangulFromAddr = Object.entries(addr)
    .filter(
      ([k, v]) =>
        v &&
        k !== 'country' &&
        k !== 'country_code' &&
        k !== 'postcode' &&
        !k.startsWith('ISO3166') &&
        hasHangul(v) &&
        !isEnglishAdminJunk(v),
    )
    .map(([, v]) => v as string)

  const uniqueHangul = [...new Set(hangulFromAddr)]
  if (uniqueHangul.length >= 1) {
    // Prefer structured order when we have partial parts
    if (parts.length === 1 && uniqueHangul.length >= 1) {
      const merged = [...parts]
      for (const h of uniqueHangul) {
        if (!merged.includes(h)) merged.push(h)
      }
      return merged.slice(0, 5).join(' · ')
    }
    return uniqueHangul.slice(0, 5).join(' · ')
  }

  const displaySegs = hangulSegmentsFromDisplay(item.display_name)
  if (displaySegs.length) return displaySegs.slice(0, 5).join(' · ')

  // Last resort: strip English-only comma segments from display_name
  const cleaned = item.display_name
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && !isEnglishAdminJunk(p))
    .join(', ')
  return cleaned || item.display_name
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
    'accept-language': 'ko',
  })

  const res = await fetch(`${NOMINATIM}/search?${params}`, {
    signal,
    headers: NOMINATIM_HEADERS,
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
    'accept-language': 'ko',
  })

  const streetRes = await fetch(`${NOMINATIM}/search?${streetParams}`, {
    signal,
    headers: NOMINATIM_HEADERS,
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
    'accept-language': 'ko',
  })

  const freeRes = await fetch(`${NOMINATIM}/search?${freeParams}`, {
    signal,
    headers: NOMINATIM_HEADERS,
  })

  if (!freeRes.ok) {
    throw new Error(`도로명 검색 실패 (${freeRes.status})`)
  }

  const freeData = (await freeRes.json()) as NominatimHit[]
  return mapResults(freeData)
}


/**
 * Nominatim reverse geocode (fallback when Kakao key missing).
 */
export async function reverseGeocodeNominatim(
  ll: LatLng,
  signal?: AbortSignal,
): Promise<GeocodeResult> {
  const params = new URLSearchParams({
    lat: String(ll.lat),
    lon: String(ll.lng),
    format: 'json',
    addressdetails: '1',
    zoom: '18',
    'accept-language': 'ko',
  })
  const res = await fetch(`${NOMINATIM}/reverse?${params}`, {
    signal,
    headers: NOMINATIM_HEADERS,
  })
  if (!res.ok) {
    throw new Error(`역지오코딩 실패 (${res.status})`)
  }
  const item = (await res.json()) as NominatimHit & { error?: string }
  if (item.error || !item.lat) {
    return {
      id: `nominatim:coord:${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}`,
      label: `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`,
      lat: ll.lat,
      lng: ll.lng,
      type: 'coordinates',
    }
  }
  const mapped = mapResults([item])[0]
  return {
    ...mapped,
    lat: ll.lat,
    lng: ll.lng,
    id: `nominatim:rev:${item.place_id}`,
  }
}
