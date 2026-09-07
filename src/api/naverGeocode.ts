import type { GeocodeResult, LatLng } from '../types'
import { NaverKeyMissingError } from './naverNavi'

const MAX_RESULTS = 15
const DEDUPE_METERS = 50

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

type NaverAddress = {
  roadAddress?: string
  jibunAddress?: string
  englishAddress?: string
  x?: string
  y?: string
}

type NaverGeocodeResponse = {
  status?: string
  meta?: { totalCount?: number }
  addresses?: NaverAddress[]
  errorMessage?: string
  error?: string
  message?: string
}

type NaverReverseRegion = {
  name?: string
  area0?: { name?: string }
  area1?: { name?: string }
  area2?: { name?: string }
  area3?: { name?: string }
  area4?: { name?: string }
  land?: {
    name?: string
    number1?: string
    number2?: string
    addition0?: { value?: string }
  }
}

type NaverReverseResponse = {
  status?: { code?: number; name?: string; message?: string }
  results?: NaverReverseRegion[]
  error?: string
  message?: string
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
        ? `네이버 지오코딩 실패 (${res.status}): ${detail}`
        : `네이버 지오코딩 실패 (${res.status})`,
    )
  }
  return (await res.json()) as T
}

/**
 * Forward geocode via Vite proxy → Naver Geocoding.
 */
export async function geocodeNaver(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const q = query.trim()
  if (!q) return []

  const params = new URLSearchParams({
    query: q,
    count: String(MAX_RESULTS),
    language: 'kor',
  })
  const res = await fetch(`/api/naver/geocode?${params}`, { signal })
  const data = await parseProxyJson<NaverGeocodeResponse>(res)

  if (data.status && data.status !== 'OK') {
    throw new Error(data.errorMessage || data.message || `geocode ${data.status}`)
  }

  const out: GeocodeResult[] = []
  for (const addr of data.addresses ?? []) {
    const lng = addr.x != null ? Number(addr.x) : NaN
    const lat = addr.y != null ? Number(addr.y) : NaN
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    if (!inKorea(lat, lng)) continue
    const road = addr.roadAddress?.trim()
    const jibun = addr.jibunAddress?.trim()
    const label = road || jibun || q
    out.push({
      id: `naver:${lng},${lat}:${label}`,
      label,
      lat,
      lng,
      type: road ? 'road' : 'address',
    })
  }
  return dedupeByProximity(out).slice(0, MAX_RESULTS)
}

/**
 * Reverse geocode via Vite proxy → Naver Reverse Geocoding.
 */
export async function reverseGeocodeNaver(
  ll: LatLng,
  signal?: AbortSignal,
): Promise<GeocodeResult> {
  const params = new URLSearchParams({
    coords: `${ll.lng},${ll.lat}`,
    // legalcode + addr + roadaddr covers most map-click labels
    orders: 'legalcode,addr,roadaddr',
    output: 'json',
  })
  const res = await fetch(`/api/naver/reversegeocode?${params}`, { signal })
  const data = await parseProxyJson<NaverReverseResponse>(res)

  const statusCode = data.status?.code
  if (statusCode != null && statusCode !== 0) {
    throw new Error(
      data.status?.message || `reverse geocode code ${statusCode}`,
    )
  }

  const results = data.results ?? []
  let bestLabel = ''
  for (const r of results) {
    const land = r.land
    const roadBits = [
      r.area1?.name,
      r.area2?.name,
      r.area3?.name,
      land?.name,
      land?.number1
        ? land.number2
          ? `${land.number1}-${land.number2}`
          : land.number1
        : undefined,
      land?.addition0?.value,
    ]
      .map((p) => p?.trim())
      .filter(Boolean)
    const joined = roadBits.join(' ')
    if (joined.length > bestLabel.length) bestLabel = joined
  }

  if (!bestLabel) {
    bestLabel = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`
  }

  return {
    id: `naver-rev:${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}`,
    label: bestLabel,
    lat: ll.lat,
    lng: ll.lng,
    type: 'address',
  }
}
