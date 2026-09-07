import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react'
import { searchExpressways, isExpresswayQuery } from '../api/ex'
import {
  isNationalRoadQuery,
  searchNationalRoads,
} from '../api/nationalRoads'
import { searchRoadsNominatim } from '../api/nominatim'
import { searchRoadsOverpass } from '../api/overpass'
import { buildChainMarkers, buildChainedRoute } from '../api/roadChain'
import { fetchRoute } from '../api/route'
import type {
  LatLng,
  RoadMatch,
  RouteGapInfo,
  RouteResult,
  RouteStep,
  TravelProfile,
} from '../types'
import { reorderRouteSteps } from '../api/orderStepsAlongRoute'
import { GapList } from './GapList'
import { ProfileToggle } from './ProfileToggle'
import { RouteSummary } from './RouteSummary'

function coordsNear(a: LatLng, b: LatLng, eps = 1e-5): boolean {
  return Math.abs(a.lat - b.lat) < eps && Math.abs(a.lng - b.lng) < eps
}

function connectorCoordsFromRoute(r: RouteResult, from: LatLng, to: LatLng): LatLng[] {
  if (r.trafficSegments?.length) {
    const flat = r.trafficSegments.flatMap((s) => s.coordinates)
    if (flat.length >= 2) return flat
  }
  if (r.lineStrings?.length) {
    const flat = r.lineStrings.flat()
    if (flat.length >= 2) return flat
  }
  if (r.coordinates && r.coordinates.length >= 2) return r.coordinates
  return [from, to]
}

function sameStraightConnector(line: LatLng[], from: LatLng, to: LatLng): boolean {
  if (line.length < 2) return false
  const a = line[0]
  const b = line[line.length - 1]
  return (
    (coordsNear(a, from) && coordsNear(b, to)) ||
    (coordsNear(a, to) && coordsNear(b, from))
  )
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

/** Splice index for connector steps: after the gap, not at end of the list. */
function insertIndexForGap(baseSteps: RouteStep[], gap: RouteGapInfo): number {
  let bestIdx = -1
  let bestDist = Infinity
  for (let i = 0; i < baseSteps.length; i++) {
    const loc = baseSteps[i].location
    if (!loc) continue
    const d = haversineMeters(loc, gap.from)
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  if (bestIdx >= 0) {
    // Insert after the step nearest to the gap start
    return bestIdx + 1
  }
  if (gap.afterSegmentIndex != null) {
    // Fallback when official step locations are missing / sparse
    return Math.min(gap.afterSegmentIndex + 1, baseSteps.length)
  }
  // No locations and no segment hint — only then append
  return baseSteps.length
}

/** Kakao Navi OD endpoint types (출발지/목적지/경유지) + OSRM depart/arrive. */
function isConnectorOdEndpointType(type: string | undefined): boolean {
  const t = (type ?? '').toLowerCase()
  return (
    t === 'depart' ||
    t === 'arrive' ||
    t === '100' ||
    t === '101' ||
    t === '1000'
  )
}

/** Origin/destination wording that should not appear mid-route after 「이어서 연결」. */
function isConnectorOdEndpointText(text: string | undefined): boolean {
  const s = (text ?? '').trim()
  if (!s) return false
  if (/출발지|목적지|도착지/.test(s)) return true
  // Exact OD endpoint labels only — keep real turn text that merely mentions 출발/도착.
  if (s === '출발' || s === '도착') return true
  return false
}

/** Prefer a real road/turn name from filtered connector maneuvers. */
function pickConnectorSummaryText(
  maneuvers: RouteStep[],
  gap: RouteGapInfo,
): { name: string; label: string } {
  for (const s of maneuvers) {
    const name = (s.name ?? '').trim()
    if (!name || isConnectorOdEndpointText(name)) continue
    const label = (s.label ?? '').trim()
    if (label && !isConnectorOdEndpointText(label) && label !== name) {
      return { name, label }
    }
    return { name, label: name }
  }
  for (const s of maneuvers) {
    const label = (s.label ?? '').trim()
    if (!label || isConnectorOdEndpointText(label)) continue
    return { name: label, label }
  }
  const gapLabel = (gap.label ?? '').trim()
  if (gapLabel) return { name: gapLabel, label: gapLabel }
  return { name: '', label: '' }
}

/**
 * Insert one summary connector step at the gap (not the full Kakao/OSRM
 * maneuver list — those would renumber badges into the 40s). OD endpoint
 * types/labels are filtered when picking guidance text.
 */
function appendConnectorSteps(
  baseSteps: RouteStep[],
  conn: RouteResult,
  gap: RouteGapInfo,
): RouteStep[] {
  const maneuvers = (conn.steps ?? []).filter((s) => {
    if (isConnectorOdEndpointType(s.type)) return false
    if (isConnectorOdEndpointText(s.label) || isConnectorOdEndpointText(s.name))
      return false
    return true
  })
  const { name, label } = pickConnectorSummaryText(maneuvers, gap)
  const location =
    gap.from ??
    maneuvers.find((s) => s.location)?.location ??
    (conn.steps ?? []).find((s) => s.location)?.location ??
    conn.coordinates?.[0]
  const summary: RouteStep = {
    type: 'connect',
    name,
    label,
    distanceMeters: conn.distanceMeters,
    durationSeconds: conn.durationSeconds,
    location,
  }
  const insertAt = insertIndexForGap(baseSteps, gap)
  return [
    ...baseSteps.slice(0, insertAt),
    summary,
    ...baseSteps.slice(insertAt),
  ]
}

interface Props {
  profile: TravelProfile
  onProfileChange: (p: TravelProfile) => void
  onMarkersChange: (markers: Array<LatLng & { key: string; label?: string }>) => void
  onRouteChange: (route: RouteResult | null) => void
  onFocusLocation?: (ll: LatLng) => void
  /** Full panel reset (App can clear focus / fit) */
  onReset?: () => void
  /** Notify App when search / geometry / gap connect is busy */
  onBusyChange?: (busy: boolean) => void
}

type ChainAction = 'prepend' | 'append' | 'replace'

export function RoadNamePanel({
  profile,
  onProfileChange,
  onMarkersChange,
  onRouteChange,
  onFocusLocation,
  onReset,
  onBusyChange,
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
  const dragIndexRef = useRef<number | null>(null)
  const chainBeforeDragRef = useRef<RoadMatch[] | null>(null)
  const chainPreviewRef = useRef<RoadMatch[] | null>(null)
  const didDropRef = useRef(false)
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  /** Live reorder preview during drag — do not rebuild route until drop */
  const [chainPreview, setChainPreviewState] = useState<RoadMatch[] | null>(null)

  function setChainPreview(next: RoadMatch[] | null) {
    chainPreviewRef.current = next
    setChainPreviewState(next)
  }
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [connectingAll, setConnectingAll] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const connectAbortRef = useRef<AbortController | null>(null)

  const routingBusy =
    loading || connectingId != null || connectingAll

  useEffect(() => {
    onBusyChange?.(routingBusy)
  }, [routingBusy, onBusyChange])

  // Clear busy only on unmount — cleanup on every routingBusy change
  // incorrectly clears the map loading bar (Strict Mode / dep churn).
  useEffect(() => {
    return () => onBusyChange?.(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    const display = chainPreview ?? chain
    const next = display.filter((_, i) => i !== index)
    setChainPreview(null)
    applyChain(next)
  }

  function resetDrag() {
    dragIndexRef.current = null
    chainBeforeDragRef.current = null
    didDropRef.current = false
    setDraggingIndex(null)
    setChainPreview(null)
  }

  function handleHandleDragStart(e: DragEvent, index: number) {
    if (loading) {
      e.preventDefault()
      return
    }
    didDropRef.current = false
    dragIndexRef.current = index
    chainBeforeDragRef.current = chain
    setChainPreview(chain)
    setDraggingIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))

    const handle = e.currentTarget as HTMLElement
    const chip = handle.closest('.road-chain-chip') as HTMLElement | null
    if (chip) {
      const rect = chip.getBoundingClientRect()
      e.dataTransfer.setDragImage(
        chip,
        Math.max(0, e.clientX - rect.left),
        Math.max(0, e.clientY - rect.top),
      )
    }
  }

  function handleChipDragOver(e: DragEvent, overIndex: number) {
    if (loading || dragIndexRef.current == null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const from = dragIndexRef.current
    if (from === overIndex) return
    const base = chainPreviewRef.current ?? chainBeforeDragRef.current ?? chain
    if (
      from < 0 ||
      overIndex < 0 ||
      from >= base.length ||
      overIndex >= base.length
    ) {
      return
    }
    const next = [...base]
    const [item] = next.splice(from, 1)
    next.splice(overIndex, 0, item)
    setChainPreview(next)
    dragIndexRef.current = overIndex
    setDraggingIndex(overIndex)
  }

  function handleChipDrop(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (loading) {
      resetDrag()
      return
    }
    didDropRef.current = true
    const preview = chainPreviewRef.current ?? chainBeforeDragRef.current
    const before = chainBeforeDragRef.current
    dragIndexRef.current = null
    chainBeforeDragRef.current = null
    setDraggingIndex(null)
    setChainPreview(null)
    if (!preview || !before) return
    const changed =
      preview.length !== before.length ||
      preview.some((m, i) => m.id !== before[i]?.id || m !== before[i])
    if (changed) void applyChain(preview)
  }

  function handleChipDragEnd() {
    if (!didDropRef.current) {
      // Cancelled — restore previous order (chain state untouched)
      setChainPreview(null)
    }
    dragIndexRef.current = null
    chainBeforeDragRef.current = null
    didDropRef.current = false
    setDraggingIndex(null)
  }

  function applyConnectedRoute(next: RouteResult) {
    // useEffect syncs onRouteChange when route state updates
    setRoute(next)
  }

  async function connectGap(gap: RouteGapInfo) {
    if (!route) return
    if (gap.kind !== 'skipped' && gap.kind !== 'straight') return

    connectAbortRef.current?.abort()
    const ac = new AbortController()
    connectAbortRef.current = ac
    setConnectingId(gap.id)
    setConnectError(null)
    try {
      // Official road gaps: drive even in walk mode
      const connectProfile: TravelProfile =
        route.fromOfficialGeometry || route.source === 'official'
          ? 'driving'
          : profile
      const conn = await fetchRoute([gap.from, gap.to], connectProfile, ac.signal)
      if (ac.signal.aborted) return

      const connector = connectorCoordsFromRoute(conn, gap.from, gap.to)
      const prevConnectors = route.connectorLineStrings ?? []
      let nextConnectors: LatLng[][]
      if (gap.kind === 'straight') {
        const replaced = prevConnectors.filter(
          (line) => !sameStraightConnector(line, gap.from, gap.to),
        )
        nextConnectors = [...replaced, connector]
      } else {
        nextConnectors = [...prevConnectors, connector]
      }

      let distanceMeters = route.distanceMeters
      let durationSeconds = route.durationSeconds
      if (gap.kind === 'straight') {
        const straightDur = (gap.gapMeters / 1000 / 60) * 3600
        distanceMeters = distanceMeters - gap.gapMeters + conn.distanceMeters
        durationSeconds = durationSeconds - straightDur + conn.durationSeconds
      } else {
        distanceMeters += conn.distanceMeters
        durationSeconds += conn.durationSeconds
      }

      const gaps = (route.gaps ?? []).map((g) =>
        g.id === gap.id ? { ...g, kind: 'routed' as const } : g,
      )

      const steps = appendConnectorSteps(route.steps, conn, gap)

      const mergedTraffic =
        conn.trafficSegments?.length
          ? [...(route.trafficSegments ?? []), ...conn.trafficSegments]
          : route.trafficSegments

      const nextRoute = reorderRouteSteps({
        ...route,
        connectorLineStrings: nextConnectors,
        trafficSegments: mergedTraffic,
        distanceMeters,
        durationSeconds,
        gaps,
        steps,
      })
      applyConnectedRoute(nextRoute)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setConnectError((e as Error).message || '구간 연결에 실패했습니다.')
    } finally {
      if (!ac.signal.aborted) setConnectingId(null)
    }
  }

  async function connectAllGaps() {
    if (!route?.gaps?.length) return
    const targets = [...route.gaps]
      .filter((g) => g.kind === 'skipped' || g.kind === 'straight')
      .sort((a, b) => {
        const ai = a.afterSegmentIndex
        const bi = b.afterSegmentIndex
        if (ai != null && bi != null && ai !== bi) return ai - bi
        if (ai != null && bi == null) return -1
        if (ai == null && bi != null) return 1
        return a.gapMeters - b.gapMeters
      })
      .slice(0, 10)
    if (!targets.length) return

    setConnectingAll(true)
    setConnectError(null)
    try {
      let current = route
      for (const gap of targets) {
        // Re-read kind from latest route (may already be connected)
        const live = current.gaps?.find((g) => g.id === gap.id)
        if (!live || (live.kind !== 'skipped' && live.kind !== 'straight')) {
          continue
        }
        connectAbortRef.current?.abort()
        const ac = new AbortController()
        connectAbortRef.current = ac
        setConnectingId(live.id)
        try {
          const connectProfile: TravelProfile =
            current.fromOfficialGeometry || current.source === 'official'
              ? 'driving'
              : profile
          const conn = await fetchRoute(
            [live.from, live.to],
            connectProfile,
            ac.signal,
          )
          if (ac.signal.aborted) return

          const connector = connectorCoordsFromRoute(conn, live.from, live.to)
          const prevConnectors = current.connectorLineStrings ?? []
          let nextConnectors: LatLng[][]
          if (live.kind === 'straight') {
            const replaced = prevConnectors.filter(
              (line) => !sameStraightConnector(line, live.from, live.to),
            )
            nextConnectors = [...replaced, connector]
          } else {
            nextConnectors = [...prevConnectors, connector]
          }

          let distanceMeters = current.distanceMeters
          let durationSeconds = current.durationSeconds
          if (live.kind === 'straight') {
            const straightDur = (live.gapMeters / 1000 / 60) * 3600
            distanceMeters =
              distanceMeters - live.gapMeters + conn.distanceMeters
            durationSeconds =
              durationSeconds - straightDur + conn.durationSeconds
          } else {
            distanceMeters += conn.distanceMeters
            durationSeconds += conn.durationSeconds
          }

          const gaps = (current.gaps ?? []).map((g) =>
            g.id === live.id ? { ...g, kind: 'routed' as const } : g,
          )
          const steps = appendConnectorSteps(current.steps, conn, live)
          const mergedTraffic =
            conn.trafficSegments?.length
              ? [...(current.trafficSegments ?? []), ...conn.trafficSegments]
              : current.trafficSegments

          current = reorderRouteSteps({
            ...current,
            connectorLineStrings: nextConnectors,
            trafficSegments: mergedTraffic,
            distanceMeters,
            durationSeconds,
            gaps,
            steps,
          })
          applyConnectedRoute(current)
        } catch (e) {
          if ((e as Error).name === 'AbortError') return
          setConnectError(
            (e as Error).message || '일괄 연결 중 오류가 발생했습니다.',
          )
          break
        }
      }
    } finally {
      setConnectingId(null)
      setConnectingAll(false)
    }
  }

  function clearChain() {
    applyChain([])
  }

  function clearAll() {
    abortRef.current?.abort()
    abortRef.current = null
    connectAbortRef.current?.abort()
    connectAbortRef.current = null
    setRoadText('')
    setMatches([])
    setChain([])
    setActionTargetId(null)
    setRoute(null)
    setError(null)
    setDataNote(null)
    setConnectError(null)
    setConnectingId(null)
    setConnectingAll(false)
    setLoading(false)
    setChainPreview(null)
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
              '국토교통부 일반국도 도로중심선(공식) geometry를 사용합니다. 구간 사이 짧은 끊김은 길찾기(카카오/OSRM, 상한 있음)로 잇고, 긴 간격은 비워 둡니다.',
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
        {route != null && (
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
          <ol
            className="road-chain-list"
            onDragOver={(e) => {
              if (dragIndexRef.current == null) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
            }}
            onDrop={handleChipDrop}
          >
            {(chainPreview ?? chain).map((m, i) => {
              const chipClass = [
                'road-chain-chip',
                draggingIndex === i ? 'dragging' : '',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <li
                  key={`${m.id}-${i}`}
                  className={chipClass}
                  onDragOver={(e) => handleChipDragOver(e, i)}
                  onDrop={handleChipDrop}
                  onDragEnd={handleChipDragEnd}
                >
                  <span
                    className="road-chain-drag-handle"
                    draggable={!loading}
                    onDragStart={(e) => handleHandleDragStart(e, i)}
                    aria-label="순서 변경"
                    title="드래그하여 순서 변경"
                  >
                    ⋮⋮
                  </span>
                  <span className="road-chain-chip-label">
                    {i + 1}. {m.name}
                  </span>
                  <button
                    type="button"
                    className="road-chain-remove"
                    aria-label={`${m.name} 제거`}
                    onClick={() => removeAt(i)}
                    disabled={loading || chainPreview != null}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDragStart={(e) => e.preventDefault()}
                  >
                    ×
                  </button>
                </li>
              )
            })}
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
      {connectError && <p className="error">{connectError}</p>}
      {dataNote && <p className="hint">{dataNote}</p>}
      {route?.gaps && route.gaps.length > 0 && (
        <GapList
          gaps={route.gaps}
          onFocusLocation={onFocusLocation}
          onConnectGap={connectGap}
          connectingId={connectingId}
          onConnectAllGaps={connectAllGaps}
          connectingAll={connectingAll}
        />
      )}
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
