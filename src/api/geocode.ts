import type { GeocodeResult } from '../types'
import {
  geocodeJuso,
  JusoKeyMissingError,
  searchJuso,
  jusoToGeocodeResults,
} from './juso'
import { geocodeKorea as geocodeNominatim } from './nominatim'

/**
 * Prefer 행정안전부 도로명주소 (Juso) when the dev proxy has a confmKey.
 * Falls back to Nominatim when:
 * - no key (proxy 503 / JusoKeyMissingError)
 * - Juso search returns empty
 * - Juso path throws unexpectedly
 *
 * OriginDestPanel should call this instead of Nominatim-only geocodeKorea.
 */
export async function geocodeKoreaPreferJuso(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const q = query.trim()
  if (!q) return []

  try {
    const addresses = await searchJuso(q, signal)
    if (addresses.length > 0) {
      const jusoResults = await jusoToGeocodeResults(addresses, signal)
      if (jusoResults.length > 0) return jusoResults
      // Search hit but no coords resolved — still try Nominatim on original query
    }
  } catch (e) {
    if (e instanceof JusoKeyMissingError) {
      // Expected without .env key — silent fallback
    } else if ((e as Error).name === 'AbortError') {
      throw e
    }
    // Other Juso errors: fall through to Nominatim
  }

  return geocodeNominatim(q, signal)
}

/** @deprecated Prefer geocodeKoreaPreferJuso — kept as alias for clarity at call sites. */
export async function geocodeKorea(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  return geocodeKoreaPreferJuso(query, signal)
}

export { geocodeJuso, JusoKeyMissingError }
