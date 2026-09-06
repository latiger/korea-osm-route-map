import type { GeocodeResult, LatLng } from '../types'
import {
  geocodeKakao,
  KakaoKeyMissingError,
  reverseGeocodeKakao,
} from './kakao'
import {
  geocodeKorea as geocodeNominatim,
  reverseGeocodeNominatim,
} from './nominatim'

/**
 * Prefer Kakao Local API (address + keyword) when the dev proxy has a REST key.
 * Falls back to Nominatim when:
 * - no key (proxy 503 / KakaoKeyMissingError)
 * - Kakao search returns empty
 * - Kakao path throws unexpectedly
 *
 * OriginDestPanel should call this instead of Nominatim-only geocodeKorea.
 */
export async function geocodeKoreaPreferKakao(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const q = query.trim()
  if (!q) return []

  try {
    const kakaoResults = await geocodeKakao(q, signal)
    if (kakaoResults.length > 0) return kakaoResults
  } catch (e) {
    if (e instanceof KakaoKeyMissingError) {
      // Expected without .env key — silent fallback
    } else if ((e as Error).name === 'AbortError') {
      throw e
    }
    // Other Kakao errors: fall through to Nominatim
  }

  return geocodeNominatim(q, signal)
}

/**
 * Reverse-geocode a map click for OD place mode.
 * Prefers Kakao POI/address; falls back to Nominatim reverse.
 */
export async function reverseGeocodeKorea(
  ll: LatLng,
  signal?: AbortSignal,
): Promise<GeocodeResult> {
  try {
    return await reverseGeocodeKakao(ll, signal)
  } catch (e) {
    if (e instanceof KakaoKeyMissingError) {
      // fall through
    } else if ((e as Error).name === 'AbortError') {
      throw e
    }
    // Other Kakao errors: fall through
  }

  try {
    return await reverseGeocodeNominatim(ll, signal)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    return {
      id: `coord:${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}`,
      label: `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`,
      lat: ll.lat,
      lng: ll.lng,
      type: 'coordinates',
    }
  }
}

/** @deprecated Prefer geocodeKoreaPreferKakao — kept as alias for call sites. */
export async function geocodeKorea(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  return geocodeKoreaPreferKakao(query, signal)
}

/** @deprecated Renamed to geocodeKoreaPreferKakao (Kakao is primary). */
export const geocodeKoreaPreferJuso = geocodeKoreaPreferKakao

export { KakaoKeyMissingError }
