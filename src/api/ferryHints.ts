/**
 * Name / guidance hints for ferry vs bridge.
 * Ferry legs are dropped from drawable traffic; bridges are always kept
 * (even when Kakao/Naver also mention 페리/항로 on the same leg).
 */

const BRIDGE_CUE =
  /대교|교량|다리|bridge/i
const FERRY_CUE =
  /페리|여객선|항로|ferry/i

/** Drivable bridge cues — prefer keeping these over ferry drops. */
export function looksLikeBridgeName(text: string | undefined | null): boolean {
  if (!text) return false
  return BRIDGE_CUE.test(text)
}

/**
 * True only for ferry / open-water sailing labels.
 * Bridge cues win: e.g. "중앙대교" or "○○대교 페리" is not treated as ferry.
 */
export function looksLikeFerryName(text: string | undefined | null): boolean {
  if (!text) return false
  if (looksLikeBridgeName(text)) return false
  return FERRY_CUE.test(text)
}
