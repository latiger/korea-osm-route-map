import { useEffect, useRef, useState, type FormEvent } from 'react'
import { searchExpressways, isExpresswayQuery } from '../api/ex'
import {
  isNationalRoadQuery,
  routeFromOfficialGeometry,
  searchNationalRoads,
} from '../api/nationalRoads'
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
  const [roadText, setRoadText] = useState('2번국도')
  const [matches, setMatches] = useState<RoadMatch[]>([])
  const [selected, setSelected] = useState<RoadMatch | null>(null)
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dataNote, setDataNote] = useState<string | null>(null)
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
      // Prefer official centerline geometry when present (multi-line + steps)
      const official = routeFromOfficialGeometry(match)
      if (official) {
        setRoute(official)
        return
      }

      if (
        !Number.isFinite(match.start.lat) ||
        !Number.isFinite(match.end.lat) ||
        (match.start.lat === 0 && match.end.lat === 0)
      ) {
        throw new Error('도로 시점·종점 좌표가 없어 OSRM 경로를 계산할 수 없습니다.')
      }

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
    setDataNote(null)
    setSelected(null)
    setRoute(null)
    setMatches([])
    setLoading(true)
    try {
      const name = roadText.trim()
      if (!name) throw new Error('도로명을 입력해 주세요.')

      // Phase A: numbered 국도 → MOLIT official centerline first
      if (isNationalRoadQuery(name)) {
        try {
          const molit = await searchNationalRoads(name)
          if (molit.length > 0) {
            setMatches(molit)
            setDataNote(
              '국토교통부 일반국도 도로중심선(공식) geometry를 사용합니다. OSRM은 대체 경로용입니다.',
            )
            if (molit.length === 1) {
              setSelected(molit[0])
              await routeRoad(molit[0], profile)
            }
            return
          }
          setDataNote('공식 국도 데이터에 해당 노선이 없어 Overpass로 폴백합니다.')
        } catch {
          setDataNote('공식 국도 인덱스 로드 실패 — Overpass로 폴백합니다.')
        }
      }

      // Phase B: expressway — EX name/number index, then Overpass for geometry
      let exHints: RoadMatch[] = []
      if (isExpresswayQuery(name)) {
        try {
          exHints = await searchExpressways(name)
        } catch {
          // ignore — Overpass still runs
        }
      }

      let overpassMatches: RoadMatch[] = []
      try {
        // If EX gave a canonical name, try that first for better OSM hits
        const overpassQuery =
          exHints[0] && exHints[0].name ? exHints[0].name : name
        overpassMatches = await searchRoadsOverpass(overpassQuery)
        if (!overpassMatches.length && overpassQuery !== name) {
          overpassMatches = await searchRoadsOverpass(name)
        }
      } catch {
        // Fall back to Nominatim only
      }

      if (overpassMatches.length > 0) {
        const tagged = overpassMatches.map((m) => ({
          ...m,
          source: 'overpass' as const,
          label: exHints.length
            ? `${m.label} · EX매칭 후 OSM`
            : m.label,
        }))
        setMatches(tagged)
        if (exHints.length) {
          setDataNote(
            '고속도로: EX 노선 목록으로 이름을 맞춘 뒤 OSM(Overpass) geometry를 사용합니다. 노드 이정 좌표 API는 사용자 EX_API_KEY·추가 데이터가 필요합니다.',
          )
        }
        if (tagged.length === 1) {
          setSelected(tagged[0])
          await routeRoad(tagged[0], profile)
        }
        return
      }

      // EX metadata only — no geometry
      if (exHints.length) {
        setMatches(exHints)
        setDataNote(
          'EX 노선은 찾았으나 geometry/시점·종점 좌표가 없습니다. Overpass도 비어 있습니다. EX_API_KEY 및 노드 이정 데이터 연동을 확인해 주세요.',
        )
        return
      }

      const nom = await searchRoadsNominatim(name)
      if (!nom.length) {
        throw new Error(
          '해당 도로를 찾지 못했습니다. 국도·고속도로(예: 2번국도, 경부고속도로)나 도로명(예: 세종대로)으로 다시 시도해 보세요.',
        )
      }

      const synthetic: RoadMatch[] = nom.map((n) => {
        const delta = 0.004
        return {
          id: n.id,
          name: roadText.trim(),
          label: n.label,
          start: { lat: n.lat - delta / 2, lng: n.lng - delta / 2 },
          end: { lat: n.lat + delta / 2, lng: n.lng + delta / 2 },
          source: 'nominatim' as const,
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
      {dataNote && <p className="hint">{dataNote}</p>}
      <RouteSummary route={route} />
      <p className="hint muted">
        국도(예: 2번국도)는 국토교통부 일반국도 도로중심선 공식 데이터를 우선하고,
        고속도로는 EX 노선 목록(이름/번호) + OSM Overpass geometry를 사용합니다.
        그 외 도로명은 Overpass → Nominatim 순입니다. 공식 선형이 있으면 그
        geometry를 그리고, 없으면 시점·종점을 OSRM으로 연결합니다.
      </p>
    </div>
  )
}
