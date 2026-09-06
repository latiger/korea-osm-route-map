/**
 * Korea Expressway (EX / data.ex.co.kr) client.
 *
 * - Static routes index (public/data/expressways/routes-index.json) works without a key.
 * - Live proxy /api/ex/* injects EX_API_KEY (or demo `test` if configured).
 * - Node/milepost endpoints with start/end coordinates are not reliably available
 *   without a personal key + additional datasets; geometry falls back to Overpass.
 */

import type { RoadMatch } from '../types'
import { parseRoadQuery } from './overpass'

export interface ExRouteInfo {
  routeNo: string
  routeNoNorm: string
  name: string
  aliases: string[]
}

interface ExRoutesIndex {
  source: string
  note?: string
  routes: ExRouteInfo[]
}

let routesCache: ExRoutesIndex | null = null

async function loadStaticRoutes(): Promise<ExRoutesIndex | null> {
  if (routesCache) return routesCache
  try {
    const res = await fetch('/data/expressways/routes-index.json')
    if (!res.ok) return null
    routesCache = (await res.json()) as ExRoutesIndex
    return routesCache
  } catch {
    return null
  }
}

/** Optional live list via Vite proxy (needs EX_API_KEY; demo `test` often works for traffic). */
export async function fetchExRoutesLive(
  signal?: AbortSignal,
): Promise<ExRouteInfo[] | null> {
  try {
    const res = await fetch('/api/ex/routes', { signal })
    if (!res.ok) return null
    const data = (await res.json()) as { routes?: ExRouteInfo[]; error?: string }
    return data.routes ?? null
  } catch {
    return null
  }
}

export function isExpresswayQuery(query: string): boolean {
  const kind = parseRoadQuery(query).kind
  return kind === 'expressway' || kind === 'named_expressway'
}

/**
 * Search expressways by number/name using static EX snapshot (and optional live proxy).
 * Returns metadata matches without official geometry — caller should use Overpass/OSRM.
 */
export async function searchExpressways(
  query: string,
  signal?: AbortSignal,
): Promise<RoadMatch[]> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const parsed = parseRoadQuery(query)
  const live = await fetchExRoutesLive(signal)
  const staticIdx = await loadStaticRoutes()
  const routes = live ?? staticIdx?.routes ?? []
  if (!routes.length) return []

  const q = query.trim().replace(/\s+/g, '').toLowerCase()
  const hits: ExRouteInfo[] = []

  for (const r of routes) {
    if (parsed.kind === 'expressway' && parsed.ref) {
      if (r.routeNoNorm === parsed.ref || String(Number(r.routeNo)) === parsed.ref) {
        hits.push(r)
        continue
      }
    }
    const hay = [r.name, r.routeNo, r.routeNoNorm, ...(r.aliases ?? [])]
      .join('|')
      .replace(/\s+/g, '')
      .toLowerCase()
    if (hay.includes(q) || q.includes(r.name.replace(/\s+/g, '').toLowerCase())) {
      hits.push(r)
    }
  }

  // Prefer exact name hits; return metadata-only matches (no coords → Overpass fills geometry)
  return hits.slice(0, 10).map((r) => ({
    id: `ex:route:${r.routeNo}`,
    name: r.name.endsWith('고속도로') ? r.name : `${r.name.replace(/선$/, '')}고속도로`,
    label: `${r.name} (EX 노선 ${r.routeNo}) · geometry는 Overpass 폴백`,
    // Placeholder — Overpass path should replace; keep Seoul-ish so empty search doesn't crash
    start: { lat: 0, lng: 0 },
    end: { lat: 0, lng: 0 },
    source: 'ex' as const,
    exRouteNo: r.routeNo,
    needsGeometryFallback: true,
  }))
}
