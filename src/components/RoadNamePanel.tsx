import { useEffect, useRef, useState, type FormEvent } from 'react'
import { searchExpressways, isExpresswayQuery } from '../api/ex'
import {
  isNationalRoadQuery,
  searchNationalRoads,
} from '../api/nationalRoads'
import { searchRoadsNominatim } from '../api/nominatim'
import { searchRoadsOverpass } from '../api/overpass'
import { buildChainMarkers, buildChainedRoute } from '../api/roadChain'
import type { LatLng, RoadMatch, RouteResult, TravelProfile } from '../types'
import { ProfileToggle } from './ProfileToggle'
import { RouteSummary } from './RouteSummary'

interface Props {
  profile: TravelProfile
  onProfileChange: (p: TravelProfile) => void
  onMarkersChange: (markers: Array<LatLng & { key: string; label?: string }>) => void
  onRouteChange: (route: RouteResult | null) => void
  onFocusLocation?: (ll: LatLng) => void
  /** Full panel reset (App can clear focus / fit) */
  onReset?: () => void
}

type ChainAction = 'prepend' | 'append' | 'replace'

export function RoadNamePanel({
  profile,
  onProfileChange,
  onMarkersChange,
  onRouteChange,
  onFocusLocation,
  onReset,
}: Props) {
  const [roadText, setRoadText] = useState('2번국도')
  const [matches, setMatches] = useState<RoadMatch[]>([])
  const [chain, setChain] = useState<RoadMatch[]>([])
  /** When chain non-empty, which search result shows prepend/append actions */
  const [actionTargetId, setActionTargetId] = useState<string | null>(null)
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dataNote, setDataNote] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  /** Oriented ends from last successful chain build (for markers) */
  const metaRef = useRef<{ start: LatLng; end: LatLng; junctions: LatLng[] } | null>(
    null,
  )

  useEffect(() => {
    if (!chain.length) {
      metaRef.current = null
      onMarkersChange([])
      onRouteChange(null)
      return
    }
    onMarkersChange(buildChainMarkers(chain, metaRef.current ?? undefined))
    onRouteChange(route)
  }, [chain, route, onMarkersChange, onRouteChange])

  async function routeChain(nextChain: RoadMatch[], p: TravelProfile) {
    if (!nextChain.length) {
      abortRef.current?.abort()
      setRoute(null)
      metaRef.current = null
      return
    }

    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)
    setError(null)
    try {
      const meta = await buildChainedRoute(nextChain, p, ac.signal)
      if (ac.signal.aborted) return
      metaRef.current = {
        start: meta.start,
        end: meta.end,
        junctions: meta.junctions,
      }
      setRoute(meta.route)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setRoute(null)
      metaRef.current = null
      setError((e as Error).message || '도로 경로 계산 실패')
    } finally {
      if (!ac.signal.aborted) setLoading(false)
    }
  }

  useEffect(() => {
    if (chain.length) void routeChain(chain, profile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])

  async function applyChain(next: RoadMatch[]) {
    setChain(next)
    setActionTargetId(null)
    await routeChain(next, profile)
  }

  function handlePickMatch(match: RoadMatch) {
    if (chain.length === 0) {
      applyChain([match])
      return
    }
    // Chain non-empty → toggle action row on this candidate
    setActionTargetId((id) => (id === match.id ? null : match.id))
  }

  function handleChainAction(match: RoadMatch, action: ChainAction) {
    if (action === 'prepend') applyChain([match, ...chain])
    else if (action === 'append') applyChain([...chain, match])
    else applyChain([match])
  }

  function removeAt(index: number) {
    const next = chain.filter((_, i) => i !== index)
    applyChain(next)
  }

  function clearChain() {
    applyChain([])
  }

  function clearAll() {
    abortRef.current?.abort()
    abortRef.current = null
    setRoadText('')
    setMatches([])
    setChain([])
    setActionTargetId(null)
    setRoute(null)
    setError(null)
    setDataNote(null)
    setLoading(false)
    metaRef.current = null
    onMarkersChange([])
    onRouteChange(null)
    onReset?.()
  }

  async function handleSearch(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setDataNote(null)
    setActionTargetId(null)
    // Do NOT wipe chain — only refresh matches
    setMatches([])
    setLoading(true)
    try {
      const name = roadText.trim()
      if (!name) throw new Error('도로명을 입력해 주세요.')

      const chainWasEmpty = chain.length === 0

      // Phase A: numbered 국도 → MOLIT official centerline first
      if (isNationalRoadQuery(name)) {
        try {
          const molit = await searchNationalRoads(name)
          if (molit.length > 0) {
            setMatches(molit)
            setDataNote(
              '국토교통부 일반국도 도로중심선(공식) geometry를 사용합니다. OSRM은 대체 경로용입니다.',
            )
            if (molit.length === 1 && chainWasEmpty) {
              await applyChain([molit[0]])
            } else if (molit.length === 1) {
              setActionTargetId(molit[0].id)
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
        if (tagged.length === 1 && chainWasEmpty) {
          await applyChain([tagged[0]])
        } else if (tagged.length === 1) {
          setActionTargetId(tagged[0].id)
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
      if (synthetic.length === 1 && chainWasEmpty) {
        await applyChain([synthetic[0]])
      } else if (synthetic.length === 1) {
        setActionTargetId(synthetic[0].id)
      }
    } catch (err) {
      setError((err as Error).message || '도로 검색 중 오류가 발생했습니다.')
    } finally {
      setLoading(false)
    }
  }

  const showPicker =
    matches.length > 1 || (matches.length >= 1 && chain.length > 0)

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
        <p className="field-hint">도로를 여러 개 이어 붙일 수 있습니다.</p>
        <button type="submit" className="primary" disabled={loading}>
          {loading ? '검색 중…' : '도로 검색 · 경로'}
        </button>
        {(route != null ||
          chain.length > 0 ||
          matches.length > 0 ||
          roadText.trim() !== '') && (
          <button
            type="button"
            className="danger-outline"
            onClick={clearAll}
            disabled={loading}
          >
            경로지우기
          </button>
        )}
      </form>

      {chain.length > 0 && (
        <div className="road-chain">
          <div className="road-chain-header">
            <span className="road-chain-title">체인 ({chain.length})</span>
            <button
              type="button"
              className="road-chain-clear"
              onClick={clearChain}
              disabled={loading}
            >
              체인 비우기
            </button>
          </div>
          <ol className="road-chain-list">
            {chain.map((m, i) => (
              <li key={`${m.id}-${i}`} className="road-chain-chip">
                <span className="road-chain-chip-label">
                  {i + 1}. {m.name}
                </span>
                <button
                  type="button"
                  className="road-chain-remove"
                  aria-label={`${m.name} 제거`}
                  onClick={() => removeAt(i)}
                  disabled={loading}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}

      {showPicker && (
        <div className="picker">
          <p className="hint">
            {chain.length > 0
              ? '검색 결과에서 앞에 붙이거나 뒤에 붙이세요.'
              : '여러 도로가 검색되었습니다. 선택하세요.'}
          </p>
          <ul className="suggest always">
            {matches.map((m) => {
              const inChain = chain.some((c) => c.id === m.id)
              const showActions = chain.length > 0 && actionTargetId === m.id
              return (
                <li key={m.id} className="road-match-item">
                  <button
                    type="button"
                    className={
                      inChain || actionTargetId === m.id ? 'selected' : ''
                    }
                    onClick={() => handlePickMatch(m)}
                  >
                    {m.label}
                    {inChain ? ' · 체인에 포함' : ''}
                  </button>
                  {showActions && (
                    <div className="chain-actions">
                      <button
                        type="button"
                        className="chain-action"
                        disabled={loading}
                        onClick={() => handleChainAction(m, 'prepend')}
                      >
                        앞에 붙이기
                      </button>
                      <button
                        type="button"
                        className="chain-action"
                        disabled={loading}
                        onClick={() => handleChainAction(m, 'append')}
                      >
                        뒤에 붙이기
                      </button>
                      <button
                        type="button"
                        className="chain-action chain-action-replace"
                        disabled={loading}
                        onClick={() => handleChainAction(m, 'replace')}
                      >
                        이 도로만
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {dataNote && <p className="hint">{dataNote}</p>}
      <RouteSummary route={route} onStepClick={onFocusLocation} />
      <p className="hint muted">
        국도(예: 2번국도)는 국토교통부 일반국도 도로중심선 공식 데이터를 우선하고,
        고속도로는 EX 노선 목록(이름/번호) + OSM Overpass geometry를 사용합니다.
        그 외 도로명은 Overpass → Nominatim 순입니다. 공식 선형이 있으면 그
        geometry를 그리고, 없으면 시점·종점을 OSRM으로 연결합니다. 여러 도로를
        체인으로 이어 붙이면 방향에 맞게 정렬하고, 간격이 크면 연결 경로를
        삽입합니다.
      </p>
    </div>
  )
}
