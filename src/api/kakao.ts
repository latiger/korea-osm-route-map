import type { GeocodeResult } from '../types'

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
