import type { GeocodeResult } from '../types'
import { geocodeKakao, KakaoKeyMissingError } from './kakao'
import { geocodeKorea as geocodeNominatim } from './nominatim'

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
