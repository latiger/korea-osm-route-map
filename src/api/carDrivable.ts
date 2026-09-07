import {
  looksLikeOpenWaterChord,
  haversineMeters,
  pathLengthMeters,
} from './openWaterFilter'
import type { LatLng } from '../types'

/**
 * Tip distance treated as contiguous land (MOLIT parts often meet within this).
 * Matches ~GAP_IGNORE_M band (90–150m).
 */
export const CAR_HARD_JOIN_M = 120

/**
 * Near soft join for land / short bridge gaps between MultiLineString parts.
 * Clears mainland MOLIT tip gaps on 국도 2 (~5.2 km) and 국도 7 mid-coast
 * holes (~7 km) while staying under many ferry-only island hops (~10+ km).
 */
export const CAR_SOFT_JOIN_M = 10_000

/**
 * Extended soft join for larger mainland national-road MOLIT holes only.
 * Applied only when tip-to-tip looks like a land corridor gap (not an
 * open-water / ferry island hop). Typical band 15–25 km.
 */
export const CAR_SOFT_JOIN_LAND_M = 20_000

/** Prefer-end component shorter than this fraction of longest → prefer longer corridor. */
const SHORT_END_COMPONENT_RATIO = 0.55

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
  /**
   * True when the chosen car path still looks truncated vs declared start/end
   * (e.g. missing Gangwon or Busan tip after component selection).
   */
  truncatedCorridor: boolean
}

function segmentTips(line: LatLng[]): [LatLng, LatLng] {
  return [line[0]!, line[line.length - 1]!]
}

function nearestTipPair(
  a: LatLng[],
  b: LatLng[],
): { dist: number; tipA: LatLng; tipB: LatLng } {
  const [a0, a1] = segmentTips(a)
  const [b0, b1] = segmentTips(b)
  let dist = Infinity
  let tipA = a0
  let tipB = b0
  for (const x of [a0, a1]) {
    for (const y of [b0, b1]) {
      const d = haversineMeters(x, y)
      if (d < dist) {
        dist = d
        tipA = x
        tipB = y
      }
    }
  }
  return { dist, tipA, tipB }
}

function minTipDistance(a: LatLng[], b: LatLng[]): number {
  return nearestTipPair(a, b).dist
}

/**
 * Extended soft-join gate: allow 10–20 km tip joins only for mainland MOLIT
 * holes, not ferry-island hops. Tip-to-tip open-water chords / ferry-only
 * hops are refused (no bridge cue on a bare tip chord).
 */
function canSoftJoinLandTips(a: LatLng[], b: LatLng[], dist: number): boolean {
  if (dist <= CAR_HARD_JOIN_M) return true
  if (dist <= CAR_SOFT_JOIN_M) return true
  if (dist > CAR_SOFT_JOIN_LAND_M) return false

  const { tipA, tipB } = nearestTipPair(a, b)
  // Bare tip–tip chord over empty space: refuse when it looks like open water
  // (straight sparse hop) — ferry islands without bridge cues stay separate.
  if (looksLikeOpenWaterChord([tipA, tipB])) {
    // Mainland MOLIT holes also look like 2-point straight chords. Allow only
    // when a part bends toward the gap (interior vertex near midpoint) so the
    // corridor is land-adjacent rather than a clean water hop.
    const mid: LatLng = {
      lat: (tipA.lat + tipB.lat) / 2,
      lng: (tipA.lng + tipB.lng) / 2,
    }
    const thr = Math.min(3_500, dist * 0.35)
    for (const line of [a, b]) {
      for (let i = 1; i < line.length - 1; i++) {
        if (haversineMeters(mid, line[i]!) <= thr) return true
      }
    }
    return false
  }
  return true
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

type Comp = { lines: LatLng[][]; length: number }

/**
 * Choose car-drivable component: preferEnd when it yields a full corridor;
 * if that component is much shorter than the longest, prefer the component
 * that also contains preferStart (or the longest) so 국도 7 keeps Gangwon.
 */
function chooseComponent(
  ranked: Comp[],
  preferEnd?: LatLng,
  preferStart?: LatLng,
): Comp {
  const longest = ranked[0]!
  if (!ranked.length) return longest

  const withEnd =
    preferEnd && Number.isFinite(preferEnd.lat) && Number.isFinite(preferEnd.lng)
      ? ranked.find((c) => pointInLines(preferEnd, c.lines, END_IN_COMPONENT_M))
      : undefined
  const withStart =
    preferStart &&
    Number.isFinite(preferStart.lat) &&
    Number.isFinite(preferStart.lng)
      ? ranked.find((c) =>
          pointInLines(preferStart, c.lines, END_IN_COMPONENT_M),
        )
      : undefined
  const withBoth =
    preferEnd && preferStart
      ? ranked.find(
          (c) =>
            pointInLines(preferEnd, c.lines, END_IN_COMPONENT_M) &&
            pointInLines(preferStart, c.lines, END_IN_COMPONENT_M),
        )
      : undefined

  if (withBoth) return withBoth

  if (withEnd) {
    const endShort =
      longest.length > 0 &&
      withEnd.length < longest.length * SHORT_END_COMPONENT_RATIO
    if (endShort) {
      // Truncated southern stub (국도 7 ≈Busan): prefer start-containing or longest.
      if (withStart && withStart.length > withEnd.length) return withStart
      return longest
    }
    return withEnd
  }

  if (withStart && withStart.length >= longest.length * SHORT_END_COMPONENT_RATIO) {
    return withStart
  }
  return longest
}

function corridorLooksTruncated(
  lines: LatLng[][],
  preferStart?: LatLng,
  preferEnd?: LatLng,
): boolean {
  if (!lines.length) return false
  const missStart =
    preferStart &&
    Number.isFinite(preferStart.lat) &&
    !pointInLines(preferStart, lines, END_IN_COMPONENT_M)
  const missEnd =
    preferEnd &&
    Number.isFinite(preferEnd.lat) &&
    !pointInLines(preferEnd, lines, END_IN_COMPONENT_M)
  return Boolean(missStart || missEnd)
}

/**
 * Keep only the car-drivable contiguous MultiLineString component
 * (mainland + bridge-linked islands). Ferry-only island chains and
 * open-water chord parts are excluded.
 *
 * Connectivity: join tips within CAR_HARD_JOIN_M always; soft-join up to
 * CAR_SOFT_JOIN_M for land/bridge MOLIT gaps; extended soft-join up to
 * CAR_SOFT_JOIN_LAND_M only for non-open-water land tips (mainland holes).
 * Prefer full start↔end corridor; avoid short preferEnd-only stubs.
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
      truncatedCorridor: false,
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
      truncatedCorridor: corridorLooksTruncated(
        [longest],
        preferStart,
        preferEnd,
      ),
    }
  }

  const parent = land.map((_, i) => i)
  for (let i = 0; i < land.length; i++) {
    for (let j = i + 1; j < land.length; j++) {
      const dist = minTipDistance(land[i]!, land[j]!)
      if (dist <= CAR_HARD_JOIN_M || canSoftJoinLandTips(land[i]!, land[j]!, dist)) {
        union(parent, i, j)
      }
    }
  }

  const comps = new Map<number, Comp>()
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
  const chosen = chooseComponent(ranked, preferEnd, preferStart)

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
    truncatedCorridor: corridorLooksTruncated(ordered, preferStart, preferEnd),
  }
}

/** Korean status when ferry-only island / open-water parts were dropped. */
export const FERRY_ISLAND_EXCLUDED_HINT =
  '차량 진입 불가(섬·페리) 구간 제외'

/** Korean status when car-drivable selection still misses declared start/end. */
export const TRUNCATED_CORRIDOR_HINT =
  '일부 구간이 차량 경로에서 제외되어 노선이 짧게 표시될 수 있습니다'
