import type { RouteStep } from '../types'

export interface NumberedRouteStep extends RouteStep {
  /** 1-based display index after significant+located filter */
  n: number
  location: NonNullable<RouteStep['location']>
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

/**
 * Shared pipeline for list + map: significant steps that have a location,
 * then renumber 1..N. Order is preserved (callers should already order along
 * the route when needed). Steps without location never consume a number.
 */
export function significantDisplaySteps(
  steps: RouteStep[] | null | undefined,
): NumberedRouteStep[] {
  if (!steps?.length) return []
  const filtered = steps.filter(
    (s): s is RouteStep & { location: NonNullable<RouteStep['location']> } =>
      isSignificantStep(s) && s.location != null,
  )
  // If the filter would wipe the list, fall back to located steps only
  // (still renumbered) so badges stay contiguous from 1.
  const located = steps.filter(
    (s): s is RouteStep & { location: NonNullable<RouteStep['location']> } =>
      s.location != null,
  )
  const base = filtered.length > 0 ? filtered : located
  return base.map((s, i) => ({ ...s, n: i + 1 }))
}

/** Map badges: same numbered set as RouteSummary (located significant steps). */
export function significantStepMarkers(
  steps: RouteStep[] | null | undefined,
): Array<{ n: number; lat: number; lng: number; label?: string }> {
  return significantDisplaySteps(steps).map((s) => ({
    n: s.n,
    lat: s.location.lat,
    lng: s.location.lng,
    label: s.label,
  }))
}
