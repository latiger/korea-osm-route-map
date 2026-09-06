import type { GeocodeResult, LatLng } from '../types'

/** Thrown when proxy has no KAKAO_REST_API_KEY (503) — UI should fall back to Nominatim. */
export class KakaoKeyMissingError extends Error {
  constructor(message = 'Kakao API key not configured') {
    super(message)
    this.name = 'KakaoKeyMissingError'
  }
}

type KakaoAddressDoc = {
  address_name?: string
  address_type?: string
  x?: string
  y?: string
  address?: {
    address_name?: string
    region_1depth_name?: string
    region_2depth_name?: string
    region_3depth_name?: string
    region_3depth_h_name?: string
    mountain_yn?: string
    main_address_no?: string
    sub_address_no?: string
  } | null
  road_address?: {
    address_name?: string
    region_1depth_name?: string
    region_2depth_name?: string
    region_3depth_name?: string
    road_name?: string
    underground_yn?: string
    main_building_no?: string
    sub_building_no?: string
    building_name?: string
    zone_no?: string
  } | null
}

type KakaoKeywordDoc = {
  id?: string
  place_name?: string
  category_name?: string
  address_name?: string
  road_address_name?: string
  x?: string
  y?: string
}

type KakaoSearchResponse = {
  documents?: KakaoAddressDoc[] | KakaoKeywordDoc[]
  meta?: { total_count?: number; pageable_count?: number; is_end?: boolean }
  error?: string
  message?: string
}

const MAX_RESULTS = 15
/** If address search returns fewer than this, also query keyword (places). */
const ADDRESS_MIN_BEFORE_KEYWORD = 5
/** ~50m — collapse near-identical coordinates */
const DEDUPE_METERS = 50

/** Rough WGS84 Korea bbox (Kakao Local is KR-only; still filter junk). */
function inKorea(lat: number, lng: number): boolean {
  return lat > 33 && lat < 43 && lng > 124 && lng < 132
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

function dedupeByProximity(results: GeocodeResult[]): GeocodeResult[] {
  const out: GeocodeResult[] = []
  for (const r of results) {
    if (out.some((o) => distanceMeters(o, r) < DEDUPE_METERS)) continue
    out.push(r)
  }
  return out
}

function parseCoord(x?: string, y?: string): { lat: number; lng: number } | null {
  const lng = x != null ? Number(x) : NaN
  const lat = y != null ? Number(y) : NaN
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (!inKorea(lat, lng)) return null
  return { lat, lng }
}

function buildAddressLabel(doc: KakaoAddressDoc): string {
  const road = doc.road_address?.address_name?.trim()
  const jibun = doc.address?.address_name?.trim() || doc.address_name?.trim()
  const building = doc.road_address?.building_name?.trim()

  if (road && building && !road.includes(building)) {
    return `${building} · ${road}`
  }
  if (road) return road
  if (jibun) return jibun

  const regions = [
    doc.road_address?.region_1depth_name || doc.address?.region_1depth_name,
    doc.road_address?.region_2depth_name || doc.address?.region_2depth_name,
    doc.road_address?.region_3depth_name ||
      doc.address?.region_3depth_name ||
      doc.address?.region_3depth_h_name,
    doc.road_address?.road_name,
  ]
    .map((p) => p?.trim())
    .filter(Boolean)
  return regions.length ? regions.join(' ') : '주소'
}

function buildKeywordLabel(doc: KakaoKeywordDoc): string {
  const place = doc.place_name?.trim()
  const road = doc.road_address_name?.trim()
  const addr = doc.address_name?.trim()
  const loc = road || addr
  if (place && loc) return `${place} · ${loc}`
  return place || loc || '장소'
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
    throw new Error(`Kakao 요청 실패 (${res.status})`)
  }
  return (await res.json()) as T
}

/**
 * Address search via Vite proxy → dapi.kakao.com/v2/local/search/address.json
 */
export async function searchKakaoAddress(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const q = query.trim()
  if (!q) return []

  const params = new URLSearchParams({ query: q, size: String(MAX_RESULTS) })
  const res = await fetch(`/api/kakao/address?${params}`, { signal })
  const data = await parseProxyJson<KakaoSearchResponse>(res)
  const docs = (data.documents ?? []) as KakaoAddressDoc[]

  const mapped: GeocodeResult[] = []
  docs.forEach((doc, i) => {
    const c = parseCoord(doc.x, doc.y)
    if (!c) return
    mapped.push({
      id: `kakao:addr:${doc.address_name ?? i}:${c.lat.toFixed(6)},${c.lng.toFixed(6)}`,
      label: buildAddressLabel(doc),
      lat: c.lat,
      lng: c.lng,
      type: doc.address_type ? `kakao-address:${doc.address_type}` : 'kakao-address',
    })
  })
  return dedupeByProximity(mapped).slice(0, MAX_RESULTS)
}

/**
 * Keyword (places) search via Vite proxy → dapi.kakao.com/v2/local/search/keyword.json
 */
export async function searchKakaoKeyword(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const q = query.trim()
  if (!q) return []

  const params = new URLSearchParams({ query: q, size: String(MAX_RESULTS) })
  const res = await fetch(`/api/kakao/keyword?${params}`, { signal })
  const data = await parseProxyJson<KakaoSearchResponse>(res)
  const docs = (data.documents ?? []) as KakaoKeywordDoc[]

  const mapped: GeocodeResult[] = []
  docs.forEach((doc, i) => {
    const c = parseCoord(doc.x, doc.y)
    if (!c) return
    mapped.push({
      id: `kakao:kw:${doc.id ?? i}:${c.lat.toFixed(6)},${c.lng.toFixed(6)}`,
      label: buildKeywordLabel(doc),
      lat: c.lat,
      lng: c.lng,
      type: 'kakao-keyword',
    })
  })
  return dedupeByProximity(mapped).slice(0, MAX_RESULTS)
}

/**
 * Combined Kakao geocode: address first, then keyword if few results.
 * Dedupes by proximity. Throws KakaoKeyMissingError on proxy 503.
 */
export async function geocodeKakao(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const q = query.trim()
  if (!q) return []

  const addressHits = await searchKakaoAddress(q, signal)
  if (addressHits.length >= ADDRESS_MIN_BEFORE_KEYWORD) {
    return addressHits.slice(0, MAX_RESULTS)
  }

  let keywordHits: GeocodeResult[] = []
  try {
    keywordHits = await searchKakaoKeyword(q, signal)
  } catch (e) {
    if (e instanceof KakaoKeyMissingError) throw e
    if ((e as Error).name === 'AbortError') throw e
    // keyword failure: still return address hits
  }

  return dedupeByProximity([...addressHits, ...keywordHits]).slice(
    0,
    MAX_RESULTS,
  )
}


type KakaoCoord2AddressDoc = {
  address?: {
    address_name?: string
    region_1depth_name?: string
    region_2depth_name?: string
    region_3depth_name?: string
    region_3depth_h_name?: string
  } | null
  road_address?: {
    address_name?: string
    building_name?: string
    region_1depth_name?: string
    region_2depth_name?: string
    region_3depth_name?: string
    road_name?: string
  } | null
}

type KakaoCoord2AddressResponse = {
  documents?: KakaoCoord2AddressDoc[]
  meta?: { total_count?: number }
}

type KakaoCategoryDoc = {
  id?: string
  place_name?: string
  category_name?: string
  address_name?: string
  road_address_name?: string
  x?: string
  y?: string
  distance?: string
}

/** Nearby POI search radius (meters). */
const REVERSE_POI_RADIUS = 80
/** Prefer place_name when nearest hit is within this distance. */
const PREFER_POI_METERS = 60

/**
 * Reverse address via Vite proxy → dapi.kakao.com/v2/local/geo/coord2address.json
 */
export async function kakaoCoord2Address(
  ll: LatLng,
  signal?: AbortSignal,
): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({
    x: String(ll.lng),
    y: String(ll.lat),
  })
  const res = await fetch(`/api/kakao/coord2address?${params}`, { signal })
  const data = await parseProxyJson<KakaoCoord2AddressResponse>(res)
  const doc = data.documents?.[0]
  if (!doc) return null

  const road = doc.road_address?.address_name?.trim()
  const building = doc.road_address?.building_name?.trim()
  const jibun = doc.address?.address_name?.trim()
  let label = ''
  if (road && building && !road.includes(building)) {
    label = `${building} · ${road}`
  } else if (building && jibun) {
    label = `${building} · ${jibun}`
  } else if (road) {
    label = road
  } else if (jibun) {
    label = jibun
  } else {
    return null
  }

  return {
    id: `kakao:rev:${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}`,
    label,
    lat: ll.lat,
    lng: ll.lng,
    type: 'kakao-coord2address',
  }
}

/**
 * Keyword search centered on coordinates (nearest matching places).
 */
export async function searchKakaoKeywordNearby(
  ll: LatLng,
  query: string,
  signal?: AbortSignal,
  radius = REVERSE_POI_RADIUS,
): Promise<GeocodeResult[]> {
  const q = query.trim()
  if (!q) return []
  const params = new URLSearchParams({
    query: q,
    x: String(ll.lng),
    y: String(ll.lat),
    radius: String(radius),
    size: '5',
    sort: 'distance',
  })
  const res = await fetch(`/api/kakao/keyword?${params}`, { signal })
  const data = await parseProxyJson<KakaoSearchResponse>(res)
  const docs = (data.documents ?? []) as KakaoKeywordDoc[]

  const mapped: GeocodeResult[] = []
  docs.forEach((doc, i) => {
    const c = parseCoord(doc.x, doc.y)
    if (!c) return
    mapped.push({
      id: `kakao:near:${doc.id ?? i}:${c.lat.toFixed(6)},${c.lng.toFixed(6)}`,
      label: buildKeywordLabel(doc),
      lat: c.lat,
      lng: c.lng,
      type: 'kakao-keyword-nearby',
    })
  })
  return mapped
}

/**
 * Category search near coordinates (common POI groups).
 * category_group_code: see Kakao Local docs (MT1, CS2, PK6, …).
 */
async function searchKakaoCategoryNearby(
  ll: LatLng,
  categoryGroupCode: string,
  signal?: AbortSignal,
  radius = REVERSE_POI_RADIUS,
): Promise<GeocodeResult[]> {
  const params = new URLSearchParams({
    category_group_code: categoryGroupCode,
    x: String(ll.lng),
    y: String(ll.lat),
    radius: String(radius),
    size: '5',
    sort: 'distance',
  })
  const res = await fetch(`/api/kakao/category?${params}`, { signal })
  const data = await parseProxyJson<{ documents?: KakaoCategoryDoc[] }>(res)
  const docs = data.documents ?? []
  const mapped: GeocodeResult[] = []
  docs.forEach((doc, i) => {
    const c = parseCoord(doc.x, doc.y)
    if (!c) return
    const place = doc.place_name?.trim()
    const road = doc.road_address_name?.trim()
    const addr = doc.address_name?.trim()
    const loc = road || addr
    const label =
      place && loc ? `${place} · ${loc}` : place || loc || '장소'
    mapped.push({
      id: `kakao:cat:${doc.id ?? i}:${c.lat.toFixed(6)},${c.lng.toFixed(6)}`,
      label,
      lat: c.lat,
      lng: c.lng,
      type: `kakao-category:${categoryGroupCode}`,
    })
  })
  return mapped
}

/**
 * Reverse-geocode a map click: prefer nearby POI name when close,
 * otherwise road/jibun address from coord2address.
 * Throws KakaoKeyMissingError when proxy has no key.
 */
export async function reverseGeocodeKakao(
  ll: LatLng,
  signal?: AbortSignal,
): Promise<GeocodeResult> {
  // Address + a few nearby category searches in parallel
  const categories = ['MT1', 'CS2', 'SW8', 'CT1', 'AT4', 'AD5']
  const [addressSettled, ...catSettled] = await Promise.allSettled([
    kakaoCoord2Address(ll, signal),
    ...categories.map((code) =>
      searchKakaoCategoryNearby(ll, code, signal, 50),
    ),
  ])

  if (
    addressSettled.status === 'rejected' &&
    addressSettled.reason instanceof KakaoKeyMissingError
  ) {
    throw addressSettled.reason
  }

  const address =
    addressSettled.status === 'fulfilled' ? addressSettled.value : null

  const candidates: GeocodeResult[] = []
  for (const s of catSettled) {
    if (s.status !== 'fulfilled') {
      if (s.reason instanceof KakaoKeyMissingError) throw s.reason
      continue
    }
    if (s.value[0]) candidates.push(s.value[0])
  }

  // Keyword using building / first label fragment from address
  if (address) {
    const hint = address.label.split(' · ')[0]?.trim()
    if (hint && hint.length >= 2) {
      try {
        const hits = await searchKakaoKeywordNearby(ll, hint, signal, 50)
        if (hits[0]) candidates.push(hits[0])
      } catch (e) {
        if (e instanceof KakaoKeyMissingError) throw e
        if ((e as Error).name === 'AbortError') throw e
      }
    }
  }

  candidates.sort(
    (a, b) => distanceMeters(a, ll) - distanceMeters(b, ll),
  )
  const nearest = candidates[0]
  if (nearest && distanceMeters(nearest, ll) <= PREFER_POI_METERS) {
    return {
      ...nearest,
      lat: ll.lat,
      lng: ll.lng,
      id: `kakao:pick:${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}`,
    }
  }

  if (address) {
    return {
      ...address,
      lat: ll.lat,
      lng: ll.lng,
    }
  }

  if (nearest) {
    return {
      ...nearest,
      lat: ll.lat,
      lng: ll.lng,
      id: `kakao:pick:${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}`,
    }
  }

  return {
    id: `kakao:coord:${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}`,
    label: `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`,
    lat: ll.lat,
    lng: ll.lng,
    type: 'coordinates',
  }
}
