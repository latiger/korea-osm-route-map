import type { RouteStep } from '../types'

export interface NumberedRouteStep extends RouteStep {
  /** 1-based display index after significant-step filter */
  n: number
}

/**
 * Keep meaningful turn-by-turn steps: endpoints / gap connectors,
 * positive-distance legs, and labeled road segments. Drops a wall of
 * zero-length micro-maneuvers that make map badges jump (e.g. 44).
 */
export function isSignificantStep(step: RouteStep): boolean {
  const t = (step.type ?? '').toLowerCase()
  if (
    t === 'depart' ||
    t === 'arrive' ||
    t === 'connect' ||
    t === '100' ||
    t === '101'
  ) {
    return true
  }
  if (step.distanceMeters > 0) return true
  if ((step.name ?? '').trim()) return true
  return false
}

/** Filter to significant steps and renumber 1..N for list + map sync. */
export function significantDisplaySteps(
  steps: RouteStep[] | null | undefined,
): NumberedRouteStep[] {
  if (!steps?.length) return []
  const filtered = steps.filter(isSignificantStep)
  // If filter would wipe the list, fall back to full steps (still renumbered).
  const base = filtered.length > 0 ? filtered : steps
  return base.map((s, i) => ({ ...s, n: i + 1 }))
}

/** Map badges: significant steps that have a location (same `n` as list). */
export function significantStepMarkers(
  steps: RouteStep[] | null | undefined,
): Array<{ n: number; lat: number; lng: number; label?: string }> {
  return significantDisplaySteps(steps)
    .filter((s) => s.location != null)
    .map((s) => ({
      n: s.n,
      lat: s.location!.lat,
      lng: s.location!.lng,
      label: s.label,
    }))
}
