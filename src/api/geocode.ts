import type { GeocodeResult, LatLng } from '../types'
import {
  geocodeKakao,
  KakaoKeyMissingError,
  reverseGeocodeKakao,
} from './kakao'
import {
  geocodeNaver,
  reverseGeocodeNaver,
} from './naverGeocode'
import { NaverKeyMissingError } from './naverNavi'
import {
  geocodeKorea as geocodeNominatim,
  reverseGeocodeNominatim,
} from './nominatim'

/**
 * Prefer Naver Geocoding when the proxy has keys; then Kakao Local; then Nominatim.
 */
export async function geocodeKoreaPreferNaver(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  const q = query.trim()
  if (!q) return []

  try {
    const naverResults = await geocodeNaver(q, signal)
    if (naverResults.length > 0) return naverResults
  } catch (e) {
    if (e instanceof NaverKeyMissingError) {
      // Expected without .env key — silent fallback
    } else if ((e as Error).name === 'AbortError') {
      throw e
    }
  }

  try {
    const kakaoResults = await geocodeKakao(q, signal)
    if (kakaoResults.length > 0) return kakaoResults
  } catch (e) {
    if (e instanceof KakaoKeyMissingError) {
      // fall through
    } else if ((e as Error).name === 'AbortError') {
      throw e
    }
  }

  return geocodeNominatim(q, signal)
}

/** @deprecated Prefer geocodeKoreaPreferNaver — Kakao-first alias kept for call sites. */
export async function geocodeKoreaPreferKakao(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  return geocodeKoreaPreferNaver(query, signal)
}

/**
 * Reverse-geocode a map click for OD place mode.
 * Prefers Naver; then Kakao; then Nominatim.
 */
export async function reverseGeocodeKorea(
  ll: LatLng,
  signal?: AbortSignal,
): Promise<GeocodeResult> {
  try {
    return await reverseGeocodeNaver(ll, signal)
  } catch (e) {
    if (e instanceof NaverKeyMissingError) {
      // fall through
    } else if ((e as Error).name === 'AbortError') {
      throw e
    }
  }

  try {
    return await reverseGeocodeKakao(ll, signal)
  } catch (e) {
    if (e instanceof KakaoKeyMissingError) {
      // fall through
    } else if ((e as Error).name === 'AbortError') {
      throw e
    }
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

/** @deprecated Prefer geocodeKoreaPreferNaver — kept as alias for call sites. */
export async function geocodeKorea(
  query: string,
  signal?: AbortSignal,
): Promise<GeocodeResult[]> {
  return geocodeKoreaPreferNaver(query, signal)
}

/** @deprecated Renamed — Naver is primary. */
export const geocodeKoreaPreferJuso = geocodeKoreaPreferNaver
