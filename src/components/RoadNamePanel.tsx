import { useEffect, useRef, useState, type FormEvent } from 'react'
import { searchRoadsNominatim } from '../api/nominatim'
import { searchRoadsOverpass } from '../api/overpass'
import { fetchRoute } from '../api/osrm'
import type { LatLng, RoadMatch, RouteResult, TravelProfile } from '../types'
import { ProfileToggle } from './ProfileToggle'
import { RouteSummary } from './RouteSummary'

interface Props {
  profile: TravelProfile
  onProfileChange: (p: TravelProfile) => void
  onMarkersChange: (markers: Array<LatLng & { key: string; label?: string }>) => void
  onRouteChange: (route: RouteResult | null) => void
}

export function RoadNamePanel({
  profile,
  onProfileChange,
  onMarkersChange,
  onRouteChange,
}: Props) {
  const [roadText, setRoadText] = useState('테헤란로')
  const [matches, setMatches] = useState<RoadMatch[]>([])
  const [selected, setSelected] = useState<RoadMatch | null>(null)
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!selected) {
      onMarkersChange([])
      onRouteChange(null)
      return
    }
    onMarkersChange([
      {
        key: 'road-start',
        lat: selected.start.lat,
        lng: selected.start.lng,
        label: `${selected.name} 시작`,
      },
      {
        key: 'road-end',
        lat: selected.end.lat,
        lng: selected.end.lng,
        label: `${selected.name} 끝`,
      },
    ])
    onRouteChange(route)
  }, [selected, route, onMarkersChange, onRouteChange])

  async function routeRoad(match: RoadMatch, p: TravelProfile) {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)
    setError(null)
    try {
      const r = await fetchRoute([match.start, match.end], p, ac.signal)
      setRoute(r)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setRoute(null)
      setError((e as Error).message || '도로 경로 계산 실패')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (selected) void routeRoad(selected, profile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])

  async function handleSearch(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSelected(null)
    setRoute(null)
    setMatches([])
    setLoading(true)
    try {
      const name = roadText.trim()
      if (!name) throw new Error('도로명을 입력해 주세요.')

      let overpassMatches: RoadMatch[] = []
      try {
        overpassMatches = await searchRoadsOverpass(name)
      } catch {
        // Fall back to Nominatim only
      }

      if (overpassMatches.length > 0) {
        setMatches(overpassMatches)
        if (overpassMatches.length === 1) {
          setSelected(overpassMatches[0])
          await routeRoad(overpassMatches[0], profile)
        }
        return
      }

      const nom = await searchRoadsNominatim(name)
      if (!nom.length) {
        throw new Error(
          '해당 도로를 찾지 못했습니다. 국도·고속도로(예: 2번국도, 경부고속도로)나 도로명(예: 세종대로)으로 다시 시도해 보세요.',
        )
      }

      // Nominatim returns points — approximate a short segment around the point
      const synthetic: RoadMatch[] = nom.map((n) => {
        const delta = 0.004
        return {
          id: n.id,
          name: roadText.trim(),
          label: n.label,
          start: { lat: n.lat - delta / 2, lng: n.lng - delta / 2 },
          end: { lat: n.lat + delta / 2, lng: n.lng + delta / 2 },
        }
      })
      setMatches(synthetic)
      if (synthetic.length === 1) {
        setSelected(synthetic[0])
        await routeRoad(synthetic[0], profile)
      }
    } catch (err) {
      setError((err as Error).message || '도로 검색 중 오류가 발생했습니다.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="panel">
      <form onSubmit={handleSearch} className="stack">
        <ProfileToggle value={profile} onChange={onProfileChange} disabled={loading} />
        <label className="field">
          <span>도로명</span>
          <input
            value={roadText}
            onChange={(e) => setRoadText(e.target.value)}
            placeholder="예: 2번국도, 경부고속도로, 테헤란로"
            autoComplete="off"
          />
        </label>
        <button type="submit" className="primary" disabled={loading}>
          {loading ? '검색 중…' : '도로 검색 · 경로'}
        </button>
      </form>
      {matches.length > 1 && (
        <div className="picker">
          <p className="hint">여러 도로가 검색되었습니다. 선택하세요.</p>
          <ul className="suggest always">
            {matches.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  className={selected?.id === m.id ? 'selected' : ''}
                  onClick={() => {
                    setSelected(m)
                    void routeRoad(m, profile)
                  }}
                >
                  {m.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <RouteSummary route={route} />
      <p className="hint muted">
        Overpass로 OSM 도로(name·ref 등) geometry를 찾고, 구간의 시작·끝
        지점을 OSRM으로 연결합니다. 국도·고속도로는 OSM에서 ref(예: ref=2)와
        「국도 제N호선」 형태 name으로 태깅되어 있어, 「2번국도」처럼 검색해도
        매칭됩니다. 긴 도로는 같은 ref/name끼리 묶어 표시합니다.
      </p>
    </div>
  )
}
