import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import {
  geocodeKoreaPreferKakao as geocodeKorea,
} from '../api/geocode'
import { fetchRoute } from '../api/route'
import type {
  GeocodeResult,
  LatLng,
  PlaceMode,
  RouteResult,
  TravelProfile,
} from '../types'
import { ProfileToggle } from './ProfileToggle'
import { RouteSummary } from './RouteSummary'
import { useDebouncedCallback } from '../hooks/useDebouncedCallback'

export interface ViaSlot {
  id: string
  text: string
  place: GeocodeResult | null
  hits: GeocodeResult[]
  pickRequired: boolean
}

export interface MapResolvedPick {
  role: PlaceMode
  result: GeocodeResult
  nonce: number
}

interface Props {
  profile: TravelProfile
  onProfileChange: (p: TravelProfile) => void
  onMarkersChange: (
    markers: Array<LatLng & { key: string; label?: string }>,
  ) => void
  onRouteChange: (route: RouteResult | null) => void
  onFocusLocation?: (ll: LatLng) => void
  /** Full panel reset (App can clear focus / placeMode / fit) */
  onReset?: () => void
  /** Map place-mode pick after reverse-geocode (App → panel) */
  mapPick?: MapResolvedPick | null
  /** Armed map place-mode (출발/도착/경유) for row highlight */
  placeMode?: PlaceMode | null
}

const AMBIGUOUS_HINT = '동명이 여러 곳입니다. 목록에서 선택해 주세요.'

function newViaId(): string {
  return `via-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function OriginDestPanel({
  profile,
  onProfileChange,
  onMarkersChange,
  onRouteChange,
  onFocusLocation,
  onReset,
  mapPick = null,
  placeMode = null,
}: Props) {
  const [originText, setOriginText] = useState('서울역')
  const [destText, setDestText] = useState('광화문')
  const [originHits, setOriginHits] = useState<GeocodeResult[]>([])
  const [destHits, setDestHits] = useState<GeocodeResult[]>([])
  const [origin, setOrigin] = useState<GeocodeResult | null>(null)
  const [dest, setDest] = useState<GeocodeResult | null>(null)
  const [originPickRequired, setOriginPickRequired] = useState(false)
  const [destPickRequired, setDestPickRequired] = useState(false)
  const [vias, setVias] = useState<ViaSlot[]>([])
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const originRef = useRef<GeocodeResult | null>(null)
  const destRef = useRef<GeocodeResult | null>(null)
  const viasRef = useRef<ViaSlot[]>([])
  const lastPickNonce = useRef(0)
  const formId = useId()
  originRef.current = origin
  destRef.current = dest
  viasRef.current = vias

  const searchOrigin = useDebouncedCallback(async (q: string) => {
    if (!q.trim()) {
      setOriginHits([])
      return
    }
    try {
      setOriginHits(await geocodeKorea(q))
    } catch {
      setOriginHits([])
    }
  }, 450)

  const searchDest = useDebouncedCallback(async (q: string) => {
    if (!q.trim()) {
      setDestHits([])
      return
    }
    try {
      setDestHits(await geocodeKorea(q))
    } catch {
      setDestHits([])
    }
  }, 450)

  const searchVia = useDebouncedCallback(
    async (payload: { id: string; q: string }) => {
      const { id, q } = payload
      if (!q.trim()) {
        setVias((prev) =>
          prev.map((v) => (v.id === id ? { ...v, hits: [] } : v)),
        )
        return
      }
      try {
        const hits = await geocodeKorea(q)
        setVias((prev) =>
          prev.map((v) => (v.id === id ? { ...v, hits } : v)),
        )
      } catch {
        setVias((prev) =>
          prev.map((v) => (v.id === id ? { ...v, hits: [] } : v)),
        )
      }
    },
    450,
  )

  function filledVias(list: ViaSlot[]): GeocodeResult[] {
    return list.filter((v) => v.place).map((v) => v.place!)
  }

  async function computeRoute(
    o: GeocodeResult,
    d: GeocodeResult,
    viaPlaces: GeocodeResult[],
    p: TravelProfile,
  ) {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)
    setError(null)
    try {
      const points = [
        { lat: o.lat, lng: o.lng },
        ...viaPlaces.map((v) => ({ lat: v.lat, lng: v.lng })),
        { lat: d.lat, lng: d.lng },
      ]
      const r = await fetchRoute(points, p, ac.signal)
      setRoute(r)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setRoute(null)
      setError((e as Error).message || '경로 계산 중 오류가 발생했습니다.')
    } finally {
      setLoading(false)
    }
  }

  function maybeRoute(
    o: GeocodeResult | null = originRef.current,
    d: GeocodeResult | null = destRef.current,
    viaList: ViaSlot[] = viasRef.current,
  ) {
    if (o && d) {
      void computeRoute(o, d, filledVias(viaList), profile)
    } else {
      setRoute(null)
    }
  }

  useEffect(() => {
    const markers: Array<LatLng & { key: string; label?: string }> = []
    if (origin) {
      markers.push({
        key: 'origin',
        lat: origin.lat,
        lng: origin.lng,
        label: origin.label,
      })
    }
    vias.forEach((v, i) => {
      if (!v.place) return
      markers.push({
        key: `via-${i}`,
        lat: v.place.lat,
        lng: v.place.lng,
        label: v.place.label,
      })
    })
    if (dest) {
      markers.push({
        key: 'dest',
        lat: dest.lat,
        lng: dest.lng,
        label: dest.label,
      })
    }
    onMarkersChange(markers)
    onRouteChange(route)
  }, [origin, dest, vias, route, onMarkersChange, onRouteChange])

  useEffect(() => {
    if (origin && dest) {
      void computeRoute(origin, dest, filledVias(vias), profile)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])

  // Apply map place-mode picks from App
  useEffect(() => {
    if (!mapPick || mapPick.nonce === lastPickNonce.current) return
    lastPickNonce.current = mapPick.nonce
    const { role, result } = mapPick
    if (role === 'origin') {
      setOrigin(result)
      setOriginText(result.label)
      setOriginHits([])
      setOriginPickRequired(false)
      maybeRoute(result, destRef.current, viasRef.current)
    } else if (role === 'dest') {
      setDest(result)
      setDestText(result.label)
      setDestHits([])
      setDestPickRequired(false)
      maybeRoute(originRef.current, result, viasRef.current)
    } else if (role === 'via') {
      const slot: ViaSlot = {
        id: newViaId(),
        text: result.label,
        place: result,
        hits: [],
        pickRequired: false,
      }
      setVias((prev) => {
        const next = [...prev, slot]
        maybeRoute(originRef.current, destRef.current, next)
        return next
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapPick])

  function pickOrigin(h: GeocodeResult) {
    setOrigin(h)
    setOriginText(h.label)
    setOriginHits([])
    setOriginPickRequired(false)
    maybeRoute(h, destRef.current, viasRef.current)
  }

  function pickDest(h: GeocodeResult) {
    setDest(h)
    setDestText(h.label)
    setDestHits([])
    setDestPickRequired(false)
    maybeRoute(originRef.current, h, viasRef.current)
  }

  function pickVia(id: string, h: GeocodeResult) {
    setVias((prev) => {
      const next = prev.map((v) =>
        v.id === id
          ? {
              ...v,
              place: h,
              text: h.label,
              hits: [],
              pickRequired: false,
            }
          : v,
      )
      maybeRoute(originRef.current, destRef.current, next)
      return next
    })
  }

  function swapOd() {
    const nextOriginText = destText
    const nextDestText = originText
    const nextOrigin = dest
    const nextDest = origin
    const nextOriginHits = destHits
    const nextDestHits = originHits
    const nextOriginPick = destPickRequired
    const nextDestPick = originPickRequired

    setOriginText(nextOriginText)
    setDestText(nextDestText)
    setOrigin(nextOrigin)
    setDest(nextDest)
    setOriginHits(nextOriginHits)
    setDestHits(nextDestHits)
    setOriginPickRequired(nextOriginPick)
    setDestPickRequired(nextDestPick)

    // Vias stay in order between swapped OD
    if (nextOrigin && nextDest) {
      void computeRoute(
        nextOrigin,
        nextDest,
        filledVias(viasRef.current),
        profile,
      )
    } else {
      setRoute(null)
    }
  }

  function addVia() {
    setVias((prev) => [
      ...prev,
      {
        id: newViaId(),
        text: '',
        place: null,
        hits: [],
        pickRequired: false,
      },
    ])
  }

  function removeVia(id: string) {
    setVias((prev) => {
      const next = prev.filter((v) => v.id !== id)
      maybeRoute(originRef.current, destRef.current, next)
      return next
    })
  }

  async function resolveField(
    text: string,
    current: GeocodeResult | null,
  ): Promise<{
    place: GeocodeResult | null
    hits: GeocodeResult[]
    needPick: boolean
    emptyError?: string
  }> {
    if (current && current.label === text) {
      return { place: current, hits: [], needPick: false }
    }
    const hits = await geocodeKorea(text)
    if (!hits.length) {
      return {
        place: null,
        hits: [],
        needPick: false,
        emptyError: '장소를 찾을 수 없습니다.',
      }
    }
    if (hits.length === 1) {
      return { place: hits[0], hits: [], needPick: false }
    }
    return { place: null, hits, needPick: true }
  }

  function clearAll() {
    abortRef.current?.abort()
    abortRef.current = null
    setOriginText('')
    setDestText('')
    setOriginHits([])
    setDestHits([])
    setOrigin(null)
    setDest(null)
    setOriginPickRequired(false)
    setDestPickRequired(false)
    setVias([])
    setRoute(null)
    setError(null)
    setLoading(false)
    onMarkersChange([])
    onRouteChange(null)
    onReset?.()
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    setOriginPickRequired(false)
    setDestPickRequired(false)
    try {
      const oRes = await resolveField(originText, origin)
      const dRes = await resolveField(destText, dest)

      if (oRes.emptyError) throw new Error('출발지를 찾을 수 없습니다.')
      if (dRes.emptyError) throw new Error('도착지를 찾을 수 없습니다.')

      setOrigin(oRes.place)
      setDest(dRes.place)
      setOriginHits(oRes.hits)
      setDestHits(dRes.hits)
      setOriginPickRequired(oRes.needPick)
      setDestPickRequired(dRes.needPick)
      if (oRes.place) setOriginText(oRes.place.label)
      if (dRes.place) setDestText(dRes.place.label)

      // Resolve vias that have text
      let nextVias = [...vias]
      let viaNeedPick = false
      for (let i = 0; i < nextVias.length; i++) {
        const slot = nextVias[i]
        if (!slot.text.trim()) {
          nextVias[i] = { ...slot, place: null, hits: [], pickRequired: false }
          continue
        }
        const r = await resolveField(slot.text, slot.place)
        if (r.emptyError) {
          throw new Error(`경유 ${i + 1}을(를) 찾을 수 없습니다.`)
        }
        nextVias[i] = {
          ...slot,
          place: r.place,
          hits: r.hits,
          pickRequired: r.needPick,
          text: r.place ? r.place.label : slot.text,
        }
        if (r.needPick) viaNeedPick = true
      }
      setVias(nextVias)

      if (oRes.needPick || dRes.needPick || viaNeedPick) {
        setRoute(null)
        setError(AMBIGUOUS_HINT)
        return
      }

      if (oRes.place && dRes.place) {
        await computeRoute(
          oRes.place,
          dRes.place,
          filledVias(nextVias),
          profile,
        )
      }
    } catch (err) {
      setRoute(null)
      setError((err as Error).message || '검색 중 오류가 발생했습니다.')
    } finally {
      setLoading(false)
    }
  }

  const showOriginSuggest = originHits.length > 0 && !origin
  const showDestSuggest = destHits.length > 0 && !dest

  return (
    <div className="panel">
      <form onSubmit={handleSubmit} className="stack" id={formId}>
        <ProfileToggle
          value={profile}
          onChange={onProfileChange}
          disabled={loading}
        />

        <div className="kakao-od">
          <div className="kakao-od-rows">
            {/* 출발 */}
            <div
              className={`kakao-od-place kakao-od-row${placeMode === 'origin' ? ' active' : ''}`}
            >
              <div className="kakao-od-spine">
                <span className="kakao-od-dot origin" aria-hidden />
                <span className="kakao-od-rail" aria-hidden />
              </div>
              <div className="kakao-od-field">
                <input
                  className="kakao-od-input"
                  value={originText}
                  onChange={(e) => {
                    setOriginText(e.target.value)
                    setOrigin(null)
                    setOriginPickRequired(false)
                    searchOrigin(e.target.value)
                  }}
                  placeholder="출발지를 입력하세요"
                  aria-label="출발지"
                  autoComplete="off"
                />
                {originHits.length > 1 && !origin && (
                  <p className="hint field-hint">{originHits.length}곳 후보</p>
                )}
                {showOriginSuggest && (
                  <ul
                    className={
                      originPickRequired ? 'suggest always' : 'suggest'
                    }
                  >
                    {originHits.map((h) => (
                      <li key={h.id}>
                        <button type="button" onClick={() => pickOrigin(h)}>
                          {h.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* swap on spine + 경유 추가 between origin and dest */}
            <div className="kakao-od-place kakao-od-mid">
              <div className="kakao-od-spine">
                <button
                  type="button"
                  className="kakao-od-swap"
                  title="출발 ↔ 도착 바꾸기"
                  aria-label="출발과 도착 바꾸기"
                  onClick={swapOd}
                  disabled={loading}
                >
                  ⇕
                </button>
                <span className="kakao-od-rail" aria-hidden />
              </div>
              <div className="kakao-od-field kakao-od-mid-actions">
                <button
                  type="button"
                  className="kakao-od-add-via"
                  title="경유지 추가"
                  aria-label="경유지 추가"
                  onClick={addVia}
                  disabled={loading}
                >
                  + 경유 추가
                </button>
              </div>
            </div>

            {/* 경유 0..n */}
            {vias.map((v, i) => {
              const showSuggest = v.hits.length > 0 && !v.place
              return (
                <div
                  key={v.id}
                  className={`kakao-od-place kakao-od-via kakao-od-row${placeMode === 'via' ? ' active' : ''}`}
                >
                  <div className="kakao-od-spine">
                    <span className="kakao-od-dot via" aria-hidden />
                    <span className="kakao-od-rail" aria-hidden />
                  </div>
                  <div className="kakao-od-field">
                    <div className="kakao-od-via-input-row">
                      <input
                        className="kakao-od-input"
                        value={v.text}
                        onChange={(e) => {
                          const text = e.target.value
                          setVias((prev) =>
                            prev.map((slot) =>
                              slot.id === v.id
                                ? {
                                    ...slot,
                                    text,
                                    place: null,
                                    pickRequired: false,
                                  }
                                : slot,
                            ),
                          )
                          searchVia({ id: v.id, q: text })
                        }}
                        placeholder="경유지를 입력하세요"
                        aria-label={`경유지 ${i + 1}`}
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className="kakao-od-via-remove"
                        title="경유지 삭제"
                        aria-label={`경유 ${i + 1} 삭제`}
                        onClick={() => removeVia(v.id)}
                      >
                        ×
                      </button>
                    </div>
                    {v.hits.length > 1 && !v.place && (
                      <p className="hint field-hint">{v.hits.length}곳 후보</p>
                    )}
                    {showSuggest && (
                      <ul
                        className={
                          v.pickRequired ? 'suggest always' : 'suggest'
                        }
                      >
                        {v.hits.map((h) => (
                          <li key={h.id}>
                            <button
                              type="button"
                              onClick={() => pickVia(v.id, h)}
                            >
                              {h.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )
            })}

            {/* 도착 */}
            <div
              className={`kakao-od-place kakao-od-dest kakao-od-row${placeMode === 'dest' ? ' active' : ''}`}
            >
              <div className="kakao-od-spine">
                <span className="kakao-od-dot dest" aria-hidden />
              </div>
              <div className="kakao-od-field">
                <input
                  className="kakao-od-input"
                  value={destText}
                  onChange={(e) => {
                    setDestText(e.target.value)
                    setDest(null)
                    setDestPickRequired(false)
                    searchDest(e.target.value)
                  }}
                  placeholder="도착지를 입력하세요"
                  aria-label="도착지"
                  autoComplete="off"
                />
                {destHits.length > 1 && !dest && (
                  <p className="hint field-hint">{destHits.length}곳 후보</p>
                )}
                {showDestSuggest && (
                  <ul
                    className={
                      destPickRequired ? 'suggest always' : 'suggest'
                    }
                  >
                    {destHits.map((h) => (
                      <li key={h.id}>
                        <button type="button" onClick={() => pickDest(h)}>
                          {h.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>

        <button type="submit" className="primary" disabled={loading}>
          {loading ? '경로 계산 중…' : '경로 찾기'}
        </button>
        {(route != null ||
          origin != null ||
          dest != null ||
          vias.length > 0 ||
          originText.trim() !== '' ||
          destText.trim() !== '') && (
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
      {error && <p className="error">{error}</p>}
      <RouteSummary route={route} onStepClick={onFocusLocation} />
    </div>
  )
}
