import { looksLikeOpenWaterChord, haversineMeters, pathLengthMeters } from './openWaterFilter'
import type { LatLng } from '../types'

/**
 * Tip distance treated as contiguous land (MOLIT parts often meet within this).
 * Matches ~GAP_IGNORE_M band (90–150m).
 */
export const CAR_HARD_JOIN_M = 120

/**
 * Soft join for land / short bridge gaps between MultiLineString parts.
 * Must clear the largest mainland MOLIT tip gaps on 국도 2 (~5.2 km) while
 * staying below typical ferry-only island hops (~8+ km).
 */
export const CAR_SOFT_JOIN_M = 6500

/** Declared end/start snaps into a component within this distance. */
const END_IN_COMPONENT_M = 5_000

export interface CarDrivableSelection {
  /** Oriented MultiLineString parts in the chosen car-drivable component. */
  lines: LatLng[][]
  /** Marker / sample start tip (toward original start, else western tip). */
  start: LatLng
  /** Marker end: declared end if inside, else component tip toward original end. */
  end: LatLng
  /** How many input parts were dropped (islands / open-water / other comps). */
  excludedPartCount: number
  /** True when at least one part was dropped as non-car-drivable. */
  droppedFerryIslands: boolean
}

function segmentTips(line: LatLng[]): [LatLng, LatLng] {
  return [line[0]!, line[line.length - 1]!]
}

function minTipDistance(a: LatLng[], b: LatLng[]): number {
  const [a0, a1] = segmentTips(a)
  const [b0, b1] = segmentTips(b)
  return Math.min(
    haversineMeters(a0, b0),
    haversineMeters(a0, b1),
    haversineMeters(a1, b0),
    haversineMeters(a1, b1),
  )
}

function findRoot(parent: number[], i: number): number {
  let r = i
  while (parent[r] !== r) r = parent[r]!
  let x = i
  while (parent[x] !== x) {
    const next = parent[x]!
    parent[x] = r
    x = next
  }
  return r
}

function union(parent: number[], a: number, b: number): void {
  const ra = findRoot(parent, a)
  const rb = findRoot(parent, b)
  if (ra !== rb) parent[ra] = rb
}

function pointInLines(point: LatLng | undefined, lines: LatLng[][], maxM: number): boolean {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    return false
  }
  let best = Infinity
  for (const line of lines) {
    for (const p of line) {
      const d = haversineMeters(point, p)
      if (d < best) best = d
      if (best <= maxM) return true
    }
  }
  return best <= maxM
}

function nearestTipInLines(target: LatLng, lines: LatLng[][]): LatLng {
  let best = lines[0]![0]!
  let bestD = Infinity
  for (const line of lines) {
    for (const tip of segmentTips(line)) {
      const d = haversineMeters(target, tip)
      if (d < bestD) {
        bestD = d
        best = tip
      }
    }
  }
  return best
}

/** Westernmost tip (then southernmost) — fallback start when no start hint. */
function westernTip(lines: LatLng[][]): LatLng {
  let best = lines[0]![0]!
  for (const line of lines) {
    for (const tip of segmentTips(line)) {
      if (
        tip.lng < best.lng - 1e-9 ||
        (Math.abs(tip.lng - best.lng) < 1e-9 && tip.lat < best.lat)
      ) {
        best = tip
      }
    }
  }
  return best
}

/**
 * Greedy order + orient parts for a single component, starting near `startHint`.
 */
function orderComponent(lines: LatLng[][], startHint: LatLng): LatLng[][] {
  const unused = lines.filter((s) => s.length >= 2).map((s) => s.slice())
  if (unused.length <= 1) return unused

  const ordered: LatLng[][] = []
  const pickNearest = (
    tip: LatLng,
  ): { seg: LatLng[]; reverse: boolean; idx: number } => {
    let bestIdx = 0
    let bestDist = Infinity
    let bestReverse = false
    for (let i = 0; i < unused.length; i++) {
      const seg = unused[i]!
      const dStart = haversineMeters(tip, seg[0]!)
      const dEnd = haversineMeters(tip, seg[seg.length - 1]!)
      if (dStart < bestDist) {
        bestDist = dStart
        bestIdx = i
        bestReverse = false
      }
      if (dEnd < bestDist) {
        bestDist = dEnd
        bestIdx = i
        bestReverse = true
      }
    }
    return { seg: unused[bestIdx]!, reverse: bestReverse, idx: bestIdx }
  }

  const first = pickNearest(startHint)
  unused.splice(first.idx, 1)
  ordered.push(first.reverse ? first.seg.slice().reverse() : first.seg)

  while (unused.length) {
    const tip = ordered[ordered.length - 1]![ordered[ordered.length - 1]!.length - 1]!
    const next = pickNearest(tip)
    unused.splice(next.idx, 1)
    ordered.push(next.reverse ? next.seg.slice().reverse() : next.seg)
  }
  return ordered
}

/**
 * Keep only the car-drivable contiguous MultiLineString component
 * (mainland + bridge-linked islands). Ferry-only island chains and
 * open-water chord parts are excluded.
 *
 * Connectivity: join tips within CAR_HARD_JOIN_M always; also soft-join up to
 * CAR_SOFT_JOIN_M for land/bridge MOLIT gaps. Do not join farther (ferry hops).
 * Open-water chord segments are never nodes in the graph.
 * Prefer the component that contains `preferEnd`; else the longest by length.
 */
export function selectCarDrivableComponent(
  parts: LatLng[][],
  preferEnd?: LatLng,
  preferStart?: LatLng,
): CarDrivableSelection {
  const usable = parts.filter((p) => p.length >= 2)
  if (!usable.length) {
    return {
      lines: [],
      start: preferStart ?? { lat: 0, lng: 0 },
      end: preferEnd ?? { lat: 0, lng: 0 },
      excludedPartCount: parts.length,
      droppedFerryIslands: parts.length > 0,
    }
  }

  // Drop ferry / open-water chord pieces; bridge-named legs stay via looksLike*.
  const land = usable.filter((p) => !looksLikeOpenWaterChord(p))
  const openWaterDropped = usable.length - land.length

  if (!land.length) {
    // Degenerate: everything looked like open water — fall back to largest part.
    const longest = usable.reduce((a, b) =>
      pathLengthMeters(b) > pathLengthMeters(a) ? b : a,
    )
    const start = preferStart
      ? nearestTipInLines(preferStart, [longest])
      : westernTip([longest])
    const end =
      preferEnd && pointInLines(preferEnd, [longest], END_IN_COMPONENT_M)
        ? preferEnd
        : nearestTipInLines(preferEnd ?? start, [longest])
    return {
      lines: orderComponent([longest], start),
      start,
      end,
      excludedPartCount: usable.length - 1 + (parts.length - usable.length),
      droppedFerryIslands: true,
    }
  }

  const parent = land.map((_, i) => i)
  for (let i = 0; i < land.length; i++) {
    for (let j = i + 1; j < land.length; j++) {
      const dist = minTipDistance(land[i]!, land[j]!)
      if (dist <= CAR_HARD_JOIN_M || dist <= CAR_SOFT_JOIN_M) {
        union(parent, i, j)
      }
    }
  }

  const comps = new Map<number, { lines: LatLng[][]; length: number }>()
  for (let i = 0; i < land.length; i++) {
    const root = findRoot(parent, i)
    let c = comps.get(root)
    if (!c) {
      c = { lines: [], length: 0 }
      comps.set(root, c)
    }
    c.lines.push(land[i]!)
    c.length += pathLengthMeters(land[i]!)
  }

  const ranked = [...comps.values()].sort((a, b) => b.length - a.length)

  let chosen = ranked[0]!
  if (preferEnd && Number.isFinite(preferEnd.lat) && Number.isFinite(preferEnd.lng)) {
    const withEnd = ranked.find((c) =>
      pointInLines(preferEnd, c.lines, END_IN_COMPONENT_M),
    )
    if (withEnd) chosen = withEnd
  }

  const excludedPartCount =
    usable.length - chosen.lines.length + (parts.length - usable.length)
  const droppedFerryIslands =
    excludedPartCount > 0 || openWaterDropped > 0 || ranked.length > 1

  const startHint =
    preferStart && Number.isFinite(preferStart.lat)
      ? preferStart
      : westernTip(chosen.lines)
  const start = nearestTipInLines(startHint, chosen.lines)
  const ordered = orderComponent(chosen.lines, start)

  const end =
    preferEnd && pointInLines(preferEnd, ordered, END_IN_COMPONENT_M)
      ? preferEnd
      : preferEnd && Number.isFinite(preferEnd.lat)
        ? nearestTipInLines(preferEnd, ordered)
        : ordered[ordered.length - 1]![ordered[ordered.length - 1]!.length - 1]!

  return {
    lines: ordered,
    start: ordered[0]![0]!,
    end,
    excludedPartCount,
    droppedFerryIslands: droppedFerryIslands && excludedPartCount > 0,
  }
}

/** Korean status when ferry-only island / open-water parts were dropped. */
export const FERRY_ISLAND_EXCLUDED_HINT =
  '차량 진입 불가(섬·페리) 구간 제외'
