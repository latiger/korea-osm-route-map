import type { LatLng, RoadMatch } from '../types'

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
]
const USER_AGENT =
  'korea-osm-route-map/1.0 (educational MVP; https://github.com/latiger/korea-osm-route-map)'
const MAX_GROUPS = 15
/** Max raw OSM elements requested before grouping. */
const OUT_LIMIT = 100

function escapeOverpass(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type RoadKind = 'national' | 'expressway' | 'named_expressway' | 'street'

export interface ParsedRoadQuery {
  raw: string
  kind: RoadKind
  /** Numeric or string ref, e.g. "2" */
  ref?: string
  /** Exact / near-exact name strings to match */
  nameVariants: string[]
  /** Compact regex fragments for Overpass ~ */
  nameRegexes: string[]
  /** Regex fragments for ref tag */
  refRegexes: string[]
  preferMajorHighways: boolean
}

/**
 * Parse Korean road queries into OSM-oriented search variants.
 * Examples: 2번국도, 국도2호선, 1번고속도로, 경부고속도로, 테헤란로
 */
export function parseRoadQuery(input: string): ParsedRoadQuery {
  const raw = input.trim()
  const compact = raw.replace(/\s+/g, '')

  // 국도: 2번국도, 국도2, 국도2호선, 국도 제2호선, 2호 국도
  for (const re of [
    /^(\d+)번국도$/,
    /^국도(?:제)?(\d+)(?:호선|호)?$/,
    /^(\d+)호국도$/,
  ]) {
    const m = compact.match(re)
    if (m) return buildNumbered('national', raw, m[1])
  }
  for (const re of [
    /^(\d+)\s*번\s*국도$/,
    /^국도\s*(?:제)?\s*(\d+)\s*(?:호(?:선)?)?$/,
    /^(\d+)\s*호\s*국도$/,
  ]) {
    const m = raw.match(re)
    if (m) return buildNumbered('national', raw, m[1])
  }

  // 고속도로 (numbered)
  for (const re of [
    /^(\d+)번고속도로$/,
    /^고속도로(?:제)?(\d+)(?:호선|호)?$/,
    /^(\d+)호고속도로$/,
  ]) {
    const m = compact.match(re)
    if (m) return buildNumbered('expressway', raw, m[1])
  }
  for (const re of [
    /^(\d+)\s*번\s*고속도로$/,
    /^고속도로\s*(?:제)?\s*(\d+)\s*(?:호(?:선)?)?$/,
    /^(\d+)\s*호\s*고속도로$/,
  ]) {
    const m = raw.match(re)
    if (m) return buildNumbered('expressway', raw, m[1])
  }

  // Named expressway: …고속도로
  if (/고속도로/.test(compact) || /고속도로/.test(raw)) {
    const nameVariants = unique([raw, compact, raw.replace(/\s+/g, ' ').trim()])
    const nameRegexes = unique([
      escapeRegex(compact),
      escapeRegex(raw.replace(/\s+/g, ' ').trim()).replace(/\s+/g, '\\s*'),
    ])
    return {
      raw,
      kind: 'named_expressway',
      nameVariants,
      nameRegexes,
      refRegexes: [],
      preferMajorHighways: true,
    }
  }

  const nameVariants = unique([raw, compact])
  return {
    raw,
    kind: 'street',
    nameVariants,
    nameRegexes: unique([escapeRegex(raw), escapeRegex(compact)]),
    refRegexes: [],
    preferMajorHighways: false,
  }
}

function buildNumbered(
  kind: 'national' | 'expressway',
  raw: string,
  ref: string,
): ParsedRoadQuery {
  const labelStem = kind === 'national' ? '국도' : '고속도로'
  const nameVariants = unique([
    `${labelStem} 제${ref}호선`,
    `${labelStem}제${ref}호선`,
    `${labelStem} ${ref}호선`,
    `${labelStem}${ref}호선`,
    `${ref}번${labelStem}`,
    raw.trim(),
  ])

  const prefix = kind === 'national' ? '국도' : '고속도로'
  const refRegexes = unique([
    `(^|;)${escapeRegex(ref)}(;|$)`,
    `^${prefix}\\s*${escapeRegex(ref)}$`,
  ])

  // One flexible name regex covers most OSM spellings
  const nameRegexes = unique([
    `${labelStem}\\s*제?\\s*${escapeRegex(ref)}\\s*호?\\s*선?`,
    `${escapeRegex(ref)}\\s*번\\s*${labelStem}`,
  ])

  return {
    raw,
    kind,
    ref,
    nameVariants,
    nameRegexes,
    refRegexes,
    preferMajorHighways: true,
  }
}

function unique(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const i of items) {
    if (!i || seen.has(i)) continue
    seen.add(i)
    out.push(i)
  }
  return out
}

function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * start/end = the two geometry endpoints farthest apart among the group's
 * candidate endpoints (each way contributes its first and last vertex).
 * Falls back to first/last of the longest way if fewer than two endpoints exist.
 */
function farthestEndpoints(
  ways: Array<{ geometry: LatLng[] }>,
): { start: LatLng; end: LatLng } {
  const endpoints: LatLng[] = []
  let longest: LatLng[] | null = null
  for (const w of ways) {
    if (w.geometry.length < 2) continue
    endpoints.push(w.geometry[0], w.geometry[w.geometry.length - 1])
    if (!longest || w.geometry.length > longest.length) {
      longest = w.geometry
    }
  }
  if (endpoints.length < 2) {
    if (longest && longest.length >= 2) {
      return { start: longest[0], end: longest[longest.length - 1] }
    }
    const p = endpoints[0] ?? { lat: 0, lng: 0 }
    return { start: p, end: p }
  }

  let bestI = 0
  let bestJ = 1
  let bestD = -1
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      const d = haversineMeters(endpoints[i], endpoints[j])
      if (d > bestD) {
        bestD = d
        bestI = i
        bestJ = j
      }
    }
  }
  return { start: endpoints[bestI], end: endpoints[bestJ] }
}

interface OsmElement {
  id: number
  type: string
  tags?: Record<string, string>
  geometry?: Array<{ lat: number; lon: number }>
}

function wrapQuery(clauses: string[]): string {
  return `
[out:json][timeout:25];
area["ISO3166-1"="KR"][admin_level=2]->.kr;
(
${clauses.join('\n')}
);
out geom ${OUT_LIMIT};
`.trim()
}

/** Build one or more Overpass queries, ordered from cheapest/most precise. */
function buildOverpassQueries(parsed: ParsedRoadQuery): string[] {
  const major =
    '["highway"~"^(trunk|primary|secondary)$"]'
  const majorWide =
    '["highway"~"^(motorway|trunk|primary|secondary)(_link)?$"]'
  const motorway = '["highway"="motorway"]'
  const anyHwy = '["highway"]'

  if (parsed.kind === 'national' && parsed.ref) {
    const ref = escapeOverpass(parsed.ref)
    const refRx = escapeOverpass(`(^|;)${parsed.ref}(;|$)`)
    const canon = `국도 제${ref}호선`
    return [
      // 1) Fast ref scan on major roads (proven reliable on public Overpass)
      wrapQuery([`  way${major}["ref"~"${refRx}"](area.kr);`]),
      // 2) Wider highway classes + canonical name + route relation
      wrapQuery([
        `  way${majorWide}["ref"~"${refRx}"](area.kr);`,
        `  way${majorWide}["name"="${canon}"](area.kr);`,
        `  way${majorWide}["name:ko"="${canon}"](area.kr);`,
        `  relation["type"="route"]["route"="road"]["ref"="${ref}"](area.kr);`,
      ]),
    ]
  }

  if (parsed.kind === 'expressway' && parsed.ref) {
    const ref = escapeOverpass(parsed.ref)
    const refRx = escapeOverpass(`(^|;)${parsed.ref}(;|$)`)
    return [
      wrapQuery([`  way${motorway}["ref"~"${refRx}"](area.kr);`]),
      wrapQuery([
        `  way${motorway}["ref"~"${refRx}"](area.kr);`,
        `  relation["type"="route"]["route"~"^(road|motorway)$"]["ref"="${ref}"](area.kr);`,
      ]),
    ]
  }

  if (parsed.kind === 'named_expressway') {
    const clauses: string[] = []
    for (const n of parsed.nameVariants.slice(0, 2)) {
      const e = escapeOverpass(n)
      clauses.push(
        `  way${motorway}["name"="${e}"](area.kr);`,
        `  way${motorway}["name:ko"="${e}"](area.kr);`,
        `  way${motorway}["alt_name"="${e}"](area.kr);`,
      )
    }
    const withRel = [
      ...clauses,
      ...parsed.nameVariants.slice(0, 1).map(
        (n) =>
          `  relation["type"="route"]["route"~"^(road|motorway)$"]["name"="${escapeOverpass(n)}"](area.kr);`,
      ),
    ]
    return [wrapQuery(clauses), wrapQuery(withRel)]
  }

  // Street / plain name
  const clauses: string[] = []
  for (const n of parsed.nameVariants.slice(0, 2)) {
    const e = escapeOverpass(n)
    for (const key of ['name', 'name:ko', 'alt_name', 'official_name'] as const) {
      clauses.push(`  way${anyHwy}["${key}"="${e}"](area.kr);`)
    }
  }
  return [wrapQuery(clauses)]
}

function bestName(
  tags: Record<string, string> | undefined,
  fallback: string,
): string {
  if (!tags) return fallback
  return (
    tags['name:ko'] ||
    tags.name ||
    tags.official_name ||
    tags.alt_name ||
    (tags.ref ? `ref=${tags.ref}` : fallback)
  )
}

function groupKey(el: OsmElement, parsed: ParsedRoadQuery): string {
  const tags = el.tags ?? {}
  if (parsed.ref && tags.ref) {
    const parts = tags.ref.split(/[;/]/).map((p) => p.trim())
    if (parts.includes(parsed.ref)) return `ref:${parsed.ref}`
    return `ref:${tags.ref}`
  }
  if (tags.ref) return `ref:${tags.ref}`
  const n = tags['name:ko'] || tags.name || tags.official_name || tags.alt_name
  if (n) return `name:${n}`
  return `${el.type}/${el.id}`
}

function looksLikeRouteName(name: string | undefined, kind: RoadKind): boolean {
  if (!name) return false
  if (kind === 'national') return /국도/.test(name)
  if (kind === 'expressway' || kind === 'named_expressway') {
    return /고속도로|고속국도/.test(name)
  }
  return true
}

function groupLabel(
  tags: Record<string, string>,
  parsed: ParsedRoadQuery,
  memberCount: number,
): { name: string; label: string } {
  const ref = tags.ref || parsed.ref
  let title = bestName(tags, parsed.raw)

  if (parsed.kind === 'national' && parsed.ref) {
    // Prefer canonical 국도 name over local street names on shared-ref ways
    const candidates = [tags['name:ko'], tags.name, tags.official_name, tags.alt_name]
    title =
      candidates.find((n) => looksLikeRouteName(n, 'national')) ||
      `국도 제${parsed.ref}호선`
  } else if (parsed.kind === 'expressway' && parsed.ref) {
    const candidates = [tags['name:ko'], tags.name, tags.official_name, tags.alt_name]
    title =
      candidates.find((n) => looksLikeRouteName(n, 'expressway')) ||
      `고속도로 제${parsed.ref}호선`
  }

  const refPart = ref ? ` (ref=${ref})` : ''
  const hwy = tags.highway ? ` · ${tags.highway}` : tags.route ? ` · route` : ''
  const count = memberCount > 1 ? ` · ${memberCount}구간` : ''
  return {
    name: title,
    label: `${title}${refPart}${hwy}${count}`,
  }
}

function toLatLngGeom(
  geometry: Array<{ lat: number; lon: number }> | undefined,
): LatLng[] | null {
  if (!geometry || geometry.length < 2) return null
  return geometry.map((g) => ({ lat: g.lat, lng: g.lon }))
}

function groupElements(
  elements: OsmElement[],
  parsed: ParsedRoadQuery,
): RoadMatch[] {
  type WayPiece = {
    geometry: LatLng[]
    tags: Record<string, string>
    id: string
  }

  const buckets = new Map<
    string,
    { pieces: WayPiece[]; tags: Record<string, string> }
  >()

  for (const el of elements) {
    const geom = toLatLngGeom(el.geometry)
    if (!geom) continue
    if (el.type === 'way' && el.tags?.highway == null) continue
    if (
      el.type === 'relation' &&
      el.tags?.type === 'route' &&
      el.tags?.route &&
      !/^(road|motorway)$/.test(el.tags.route)
    ) {
      continue
    }

    const key = groupKey(el, parsed)
    const piece: WayPiece = {
      geometry: geom,
      tags: el.tags ?? {},
      id: `${el.type}/${el.id}`,
    }
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.pieces.push(piece)
      const pieceName = piece.tags['name:ko'] || piece.tags.name
      const bucketName = bucket.tags['name:ko'] || bucket.tags.name
      // Prefer tags that look like the numbered route over local road names
      if (
        looksLikeRouteName(pieceName, parsed.kind) &&
        !looksLikeRouteName(bucketName, parsed.kind)
      ) {
        bucket.tags = { ...bucket.tags, ...piece.tags }
      } else {
        if (!bucket.tags.name && piece.tags.name) {
          bucket.tags = { ...bucket.tags, name: piece.tags.name }
        }
        if (!bucket.tags['name:ko'] && piece.tags['name:ko']) {
          bucket.tags = { ...bucket.tags, 'name:ko': piece.tags['name:ko'] }
        }
        if (!bucket.tags.ref && piece.tags.ref) {
          bucket.tags = { ...bucket.tags, ref: piece.tags.ref }
        }
        if (!bucket.tags.highway && piece.tags.highway) {
          bucket.tags = { ...bucket.tags, highway: piece.tags.highway }
        }
      }
    } else {
      buckets.set(key, { pieces: [piece], tags: { ...piece.tags } })
    }
  }

  // If nothing grouped (e.g. odd tags), fall back to individual segments
  if (buckets.size === 0) {
    const singles: RoadMatch[] = []
    for (const el of elements) {
      const geom = toLatLngGeom(el.geometry)
      if (!geom) continue
      const tags = el.tags ?? {}
      const name = bestName(tags, parsed.raw)
      const { start, end } = farthestEndpoints([{ geometry: geom }])
      singles.push({
        id: `${el.type}/${el.id}`,
        name,
        label: `${name}${tags.highway ? ` (${tags.highway})` : ''} · OSM ${el.id}`,
        start,
        end,
        geometry: geom,
      })
      if (singles.length >= MAX_GROUPS) break
    }
    return singles
  }

  const matches: RoadMatch[] = []
  for (const [key, bucket] of buckets) {
    const { start, end } = farthestEndpoints(bucket.pieces)
    const { name, label } = groupLabel(
      bucket.tags,
      parsed,
      bucket.pieces.length,
    )
    const geometry = bucket.pieces.flatMap((p) => p.geometry)
    matches.push({
      id: `group:${key}`,
      name,
      label,
      start,
      end,
      geometry,
    })
  }

  matches.sort((a, b) => {
    const aRef = a.label.includes('ref=') ? 0 : 1
    const bRef = b.label.includes('ref=') ? 0 : 1
    if (aRef !== bRef) return aRef - bRef
    return (b.geometry?.length ?? 0) - (a.geometry?.length ?? 0)
  })

  return matches.slice(0, MAX_GROUPS)
}

async function postOverpass(
  endpoint: string,
  query: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Accept: '*/*',
      'User-Agent': USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
  })
}

export async function searchRoadsOverpass(
  roadName: string,
  signal?: AbortSignal,
): Promise<RoadMatch[]> {
  const name = roadName.trim()
  if (!name) return []

  const parsed = parseRoadQuery(name)
  const queries = buildOverpassQueries(parsed)

  let lastError: Error | null = null
  let sawEmpty = false

  for (const query of queries) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      // Per-attempt timeout so UI can fall back to Nominatim if Overpass is slow
      const attemptAbort = AbortSignal.timeout(45000)
      const combined =
        signal != null ? AbortSignal.any([signal, attemptAbort]) : attemptAbort
      try {
        const res = await postOverpass(endpoint, query, combined)
        if (!res.ok) {
          lastError = new Error(`Overpass 도로 검색 실패 (${res.status})`)
          continue
        }

        const data = (await res.json()) as {
          remark?: string
          elements?: OsmElement[]
        }

        if (data.remark && /runtime error|Query timed out/i.test(data.remark)) {
          lastError = new Error('Overpass 도로 검색 시간 초과')
          continue
        }

        const elements = data.elements ?? []
        if (elements.length === 0) {
          sawEmpty = true
          break // try next query variant
        }
        return groupElements(elements, parsed)
      } catch (e) {
        if ((e as Error).name === 'AbortError' && signal?.aborted) throw e
        lastError =
          (e as Error).name === 'TimeoutError'
            ? new Error('Overpass 도로 검색 시간 초과')
            : (e as Error)
      }
    }
  }

  if (sawEmpty && !lastError) return []
  throw lastError ?? new Error('Overpass 도로 검색 실패')
}
