import type { LatLng, RoadMatch } from '../types'

const OVERPASS = 'https://overpass-api.de/api/interpreter'

function escapeOverpass(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Approximate endpoints from way node order (first/last). */
function endpointsFromGeometry(geom: LatLng[]): { start: LatLng; end: LatLng } {
  const start = geom[0]
  const end = geom[geom.length - 1]
  return { start, end }
}

export async function searchRoadsOverpass(
  roadName: string,
  signal?: AbortSignal,
): Promise<RoadMatch[]> {
  const name = roadName.trim()
  if (!name) return []

  const escaped = escapeOverpass(name)
  // South Korea approx bbox
  const query = `
[out:json][timeout:25];
area["ISO3166-1"="KR"][admin_level=2]->.kr;
(
  way["highway"]["name"="${escaped}"](area.kr);
  way["highway"]["name:ko"="${escaped}"](area.kr);
  way["highway"]["name"~"${escaped}",i](area.kr);
);
out geom 15;
`.trim()

  const res = await fetch(OVERPASS, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Accept: 'application/json',
    },
    body: `data=${encodeURIComponent(query)}`,
  })

  if (!res.ok) {
    throw new Error(`Overpass 도로 검색 실패 (${res.status})`)
  }

  const data = (await res.json()) as {
    elements?: Array<{
      id: number
      type: string
      tags?: Record<string, string>
      geometry?: Array<{ lat: number; lon: number }>
    }>
  }

  const matches: RoadMatch[] = []
  for (const el of data.elements ?? []) {
    if (!el.geometry || el.geometry.length < 2) continue
    const geometry = el.geometry.map((g) => ({ lat: g.lat, lng: g.lon }))
    const { start, end } = endpointsFromGeometry(geometry)
    const roadLabel =
      el.tags?.['name:ko'] || el.tags?.name || name
    const highway = el.tags?.highway ? ` (${el.tags.highway})` : ''
    matches.push({
      id: `way/${el.id}`,
      name: roadLabel,
      label: `${roadLabel}${highway} · OSM ${el.id}`,
      start,
      end,
      geometry,
    })
  }

  return matches
}
