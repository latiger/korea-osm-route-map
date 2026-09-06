import type { GeocodeResult } from '../types'
import { geocodeKorea as geocodeNominatim } from './nominatim'

/** Thrown when proxy has no JUSO_CONFM_KEY (503) — UI should fall back to Nominatim. */
export class JusoKeyMissingError extends Error {
  constructor(message = 'Juso API key not configured') {
    super(message)
    this.name = 'JusoKeyMissingError'
  }
}

export type JusoAddress = {
  roadAddr: string
  roadAddrPart1: string
  roadAddrPart2?: string
  jibunAddr: string
  engAddr?: string
  zipNo?: string
  admCd: string
  rnMgtSn: string
  bdMgtSn?: string
  siNm: string
  sggNm: string
  emdNm: string
  liNm?: string
  rn: string
  udrtYn: string
  buldMnnm: string
  buldSlno: string
  bdNm?: string
  detBdNmList?: string
}

type JusoSearchResponse = {
  results?: {
    common?: {
      errorCode?: string
      errorMessage?: string
      totalCount?: string
    }
    juso?: JusoAddress[] | null
  }
  error?: string
  message?: string
}

type JusoCoordResponse = {
  results?: {
    common?: {
      errorCode?: string
      errorMessage?: string
    }
    juso?: Array<{
      entX?: string
      entY?: string
    }> | null
  }
  error?: string
  message?: string
}

/** Official Juso guidance: strip SQL reserved words / special chars before request. */
const SQL_RESERVED = [
  'OR',
  'SELECT',
  'INSERT',
  'DELETE',
  'UPDATE',
  'CREATE',
  'DROP',
  'EXEC',
  'UNION',
  'FETCH',
  'DECLARE',
  'TRUNCATE',
] as const

const MAX_RESULTS = 15
/** Cap Nominatim bridge calls when coord API is unavailable (etiquette). */
const MAX_NOMINATIM_BRIDGE = 6

/**
 * Filter keyword per 행정안전부 도로명주소 검색어필터링 안내.
 * Removes `%=><` and SQL reserved tokens (case-insensitive).
 */
export function filterJusoKeyword(raw: string): string {
  let s = raw.trim()
  if (!s) return ''
  s = s.replace(/[%=><]/g, '')
  for (const word of SQL_RESERVED) {
    s = s.replace(new RegExp(word, 'gi'), '')
  }
  return s.replace(/\s+/g, ' ').trim()
}

function buildJusoLabel(a: JusoAddress): string {
  const road = a.roadAddr?.trim() || a.roadAddrPart1?.trim()
  if (road) return road
  const parts = [a.siNm, a.sggNm, a.emdNm, a.liNm, a.rn]
    .map((p) => p?.trim())
    .filter(Boolean)
  if (parts.length) return parts.join(' ')
  return a.jibunAddr?.trim() || '주소'
}

function inKorea(lat: number, lng: number): boolean {
  return lat > 33 && lat < 43 && lng > 124 && lng < 132
}

/**
 * EPSG:5179 (Korea 2000 / Unified CS, UTM-K) → WGS84 lat/lng.
 * Coord API returns entX/entY in this system; conversion required for Leaflet.
 */
export function utmKToWgs84(
  entX: number,
  entY: number,
): { lat: number; lng: number } {
  const a = 6378137.0
  const f = 1 / 298.257222101
  const e2 = f * (2 - f)
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2))

  const lon0 = (127.5 * Math.PI) / 180
  const lat0 = (38.0 * Math.PI) / 180
  const k0 = 1.0
  const FE = 1_000_000.0
  const FN = 2_000_000.0

  const x = entX - FE
  const y = entY - FN

  const M0 =
    a *
    ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256) * lat0 -
      ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 * e2 * e2) / 1024) *
        Math.sin(2 * lat0) +
      ((15 * e2 * e2) / 256 + (45 * e2 * e2 * e2) / 1024) * Math.sin(4 * lat0) -
      ((35 * e2 * e2 * e2) / 3072) * Math.sin(6 * lat0))

  const M = M0 + y / k0
  const mu =
    M /
    (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256))

  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 * e1 * e1) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 * e1 * e1 * e1) / 32) * Math.sin(4 * mu) +
    ((151 * e1 * e1 * e1) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 * e1 * e1 * e1) / 512) * Math.sin(8 * mu)

  const sinPhi = Math.sin(phi1)
  const cosPhi = Math.cos(phi1)
  const tanPhi = Math.tan(phi1)
  const N1 = a / Math.sqrt(1 - e2 * sinPhi * sinPhi)
  const T1 = tanPhi * tanPhi
  const C1 = (e2 / (1 - e2)) * cosPhi * cosPhi
  const R1 = (a * (1 - e2)) / Math.pow(1 - e2 * sinPhi * sinPhi, 1.5)
  const D = x / (N1 * k0)

  const lat =
    phi1 -
    ((N1 * tanPhi) / R1) *
      (D * D / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * (e2 / (1 - e2))) *
          D *
          D *
          D *
          D) /
          24 +
        ((61 +
          90 * T1 +
          298 * C1 +
          45 * T1 * T1 -
          252 * (e2 / (1 - e2)) -
          3 * C1 * C1) *
          Math.pow(D, 6)) /
          720)

  const lng =
    lon0 +
    (D -
      ((1 + 2 * T1 + C1) * D * D * D) / 6 +
      ((5 -
        2 * C1 +
        28 * T1 -
        3 * C1 * C1 +
        8 * (e2 / (1 - e2)) +
        24 * T1 * T1) *
        Math.pow(D, 5)) /
        120) /
      cosPhi

  return {
    lat: (lat * 180) / Math.PI,
    lng: (lng * 180) / Math.PI,
  }
}

async function parseProxyJson<T>(res: Response): Promise<T> {
  if (res.status === 503) {
    let msg = 'Juso API key not configured'
    try {
      const body = (await res.json()) as { message?: string }
      if (body.message) msg = body.message
    } catch {
      /* ignore */
    }
    throw new JusoKeyMissingError(msg)
  }
  if (!res.ok) {
    throw new Error(`Juso 요청 실패 (${res.status})`)
  }
  return (await res.json()) as T
}

/**
 * Search 도로명주소 candidates via Vite proxy → addrLinkApi.do
 */
export async function searchJuso(
  keyword: string,
  signal?: AbortSignal,
): Promise<JusoAddress[]> {
  const filtered = filterJusoKeyword(keyword)
  if (!filtered) return []

  const params = new URLSearchParams({
    currentPage: '1',
    countPerPage: String(MAX_RESULTS),
    keyword: filtered,
    resultType: 'json',
  })

  const res = await fetch(`/api/juso/search?${params}`, { signal })
  const data = await parseProxyJson<JusoSearchResponse>(res)

  const code = data.results?.common?.errorCode
  if (code && code !== '0') {
    if (code === 'E0005' || code === 'E0006') return []
    const msg = data.results?.common?.errorMessage || `Juso error ${code}`
    throw new Error(msg)
  }

  return (data.results?.juso ?? []).slice(0, MAX_RESULTS)
}

/**
 * Coordinate lookup via Vite proxy → addrCoordApi.do
 * Requires admCd, rnMgtSn, udrtYn, buldMnnm, buldSlno from a search hit.
 * Returns WGS84 lat/lng (converted from UTM-K entX/entY).
 */
export async function coordFromJuso(
  addr: Pick<
    JusoAddress,
    'admCd' | 'rnMgtSn' | 'udrtYn' | 'buldMnnm' | 'buldSlno'
  >,
  signal?: AbortSignal,
): Promise<{ lat: number; lng: number } | null> {
  const params = new URLSearchParams({
    admCd: addr.admCd,
    rnMgtSn: addr.rnMgtSn,
    udrtYn: addr.udrtYn || '0',
    buldMnnm: String(addr.buldMnnm ?? '0'),
    buldSlno: String(addr.buldSlno ?? '0'),
    resultType: 'json',
  })

  const res = await fetch(`/api/juso/coord?${params}`, { signal })
  const data = await parseProxyJson<JusoCoordResponse>(res)

  const code = data.results?.common?.errorCode
  if (code && code !== '0') return null

  const hit = data.results?.juso?.[0]
  const entX = hit?.entX ? Number(hit.entX) : NaN
  const entY = hit?.entY ? Number(hit.entY) : NaN
  if (!Number.isFinite(entX) || !Number.isFinite(entY)) return null

  const wgs = utmKToWgs84(entX, entY)
  if (!inKorea(wgs.lat, wgs.lng)) return null
  return wgs
}

/**
 * TODO: Prefer full coord API path. If coord fails (separate 승인키, empty
 * entX/entY, conversion edge case), temporarily bridge via Nominatim using
 * the selected road address string so Juso labels/candidates still help.
 */
async function nominatimBridgeCoords(
  addr: JusoAddress,
  signal?: AbortSignal,
): Promise<{ lat: number; lng: number } | null> {
  const q = addr.roadAddr || addr.jibunAddr
  if (!q) return null
  const hits = await geocodeNominatim(q, signal)
  if (!hits.length) return null
  return { lat: hits[0].lat, lng: hits[0].lng }
}

function toGeocodeId(a: JusoAddress, index: number): string {
  return `juso:${a.bdMgtSn || `${a.admCd}${a.rnMgtSn}`}:${a.buldMnnm}-${a.buldSlno}:${index}`
}

/**
 * Map Juso search hits → GeocodeResult[].
 * 1) Parallel addrCoordApi (UTM-K → WGS84)
 * 2) If none resolved, Nominatim bridge on roadAddr (capped) — TODO full coord
 */
export async function jusoToGeocodeResults(
  addresses: JusoAddress[],
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const list = addresses.slice(0, MAX_RESULTS)

  const coordSettled = await Promise.all(
    list.map(async (a) => {
      try {
        return await coordFromJuso(a, signal)
      } catch (e) {
        if (e instanceof JusoKeyMissingError) throw e
        return null
      }
    }),
  )

  const withCoord: GeocodeResult[] = []
  const needBridge: { a: JusoAddress; i: number }[] = []

  list.forEach((a, i) => {
    const c = coordSettled[i]
    if (c) {
      withCoord.push({
        id: toGeocodeId(a, i),
        label: buildJusoLabel(a),
        lat: c.lat,
        lng: c.lng,
        type: 'juso',
      })
    } else {
      needBridge.push({ a, i })
    }
  })

  if (withCoord.length > 0) return withCoord

  // Coord API unavailable for this key — Nominatim bridge (labels from Juso)
  const bridged: GeocodeResult[] = []
  for (const { a, i } of needBridge.slice(0, MAX_NOMINATIM_BRIDGE)) {
    if (signal?.aborted) break
    try {
      const c = await nominatimBridgeCoords(a, signal)
      if (!c) continue
      bridged.push({
        id: toGeocodeId(a, i),
        label: buildJusoLabel(a),
        lat: c.lat,
        lng: c.lng,
        type: 'juso-nominatim-bridge',
      })
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e
      // skip this candidate
    }
  }
  return bridged
}

/**
 * Full Juso geocode: search + coords. Throws JusoKeyMissingError when
 * proxy returns 503 (no key) so callers can fall back to Nominatim.
 */
export async function geocodeJuso(
  keyword: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const addresses = await searchJuso(keyword, signal)
  if (!addresses.length) return []
  return jusoToGeocodeResults(addresses, signal)
}
