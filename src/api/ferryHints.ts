/**
 * Name / guidance hints that indicate a ferry or open-water sailing segment
 * rather than a drivable road or bridge.
 */
export function looksLikeFerryName(text: string | undefined | null): boolean {
  if (!text) return false
  const t = text.toLowerCase()
  return /페리|여객선|항로|ferry/.test(t)
}
