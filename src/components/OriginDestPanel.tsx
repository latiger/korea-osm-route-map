import { useEffect, useRef, useState, type FormEvent } from 'react'
import { geocodeKoreaPreferKakao as geocodeKorea } from '../api/geocode'
import { fetchRoute } from '../api/osrm'
import type { GeocodeResult, LatLng, RouteResult, TravelProfile } from '../types'
import { ProfileToggle } from './ProfileToggle'
import { RouteSummary } from './RouteSummary'
import { useDebouncedCallback } from '../hooks/useDebouncedCallback'

interface Props {
  profile: TravelProfile
  onProfileChange: (p: TravelProfile) => void
  onMarkersChange: (markers: Array<LatLng & { key: string; label?: string }>) => void
  onRouteChange: (route: RouteResult | null) => void
}

const AMBIGUOUS_HINT = '동명이 여러 곳입니다. 목록에서 선택해 주세요.'

export function OriginDestPanel({
  profile,
  onProfileChange,
  onMarkersChange,
  onRouteChange,
}: Props) {
  const [originText, setOriginText] = useState('서울역')
  const [destText, setDestText] = useState('광화문')
  const [originHits, setOriginHits] = useState<GeocodeResult[]>([])
  const [destHits, setDestHits] = useState<GeocodeResult[]>([])
  const [origin, setOrigin] = useState<GeocodeResult | null>(null)
  const [dest, setDest] = useState<GeocodeResult | null>(null)
  /** After submit with multiple hits: keep picker visible (suggest.always) until pick */
  const [originPickRequired, setOriginPickRequired] = useState(false)
  const [destPickRequired, setDestPickRequired] = useState(false)
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const originRef = useRef<GeocodeResult | null>(null)
  const destRef = useRef<GeocodeResult | null>(null)
  originRef.current = origin
  destRef.current = dest

  const searchOrigin = useDebouncedCallback(async (q: string) => {
    if (!q.trim()) {
      setOriginHits([])
      return
    }
    try {
      const hits = await geocodeKorea(q)
      setOriginHits(hits)
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
      const hits = await geocodeKorea(q)
      setDestHits(hits)
    } catch {
      setDestHits([])
    }
  }, 450)

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
  }, [origin, dest, route, onMarkersChange, onRouteChange])

  async function computeRoute(o: GeocodeResult, d: GeocodeResult, p: TravelProfile) {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)
    setError(null)
    try {
      const r = await fetchRoute(
        [
          { lat: o.lat, lng: o.lng },
          { lat: d.lat, lng: d.lng },
        ],
        p,
        ac.signal,
      )
      setRoute(r)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      setRoute(null)
      setError((e as Error).message || '경로 계산 중 오류가 발생했습니다.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (origin && dest) {
      void computeRoute(origin, dest, profile)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])

  function pickOrigin(h: GeocodeResult) {
    setOrigin(h)
    setOriginText(h.label)
    setOriginHits([])
    setOriginPickRequired(false)
    const d = destRef.current
    if (d) void computeRoute(h, d, profile)
  }

  function pickDest(h: GeocodeResult) {
    setDest(h)
    setDestText(h.label)
    setDestHits([])
    setDestPickRequired(false)
    const o = originRef.current
    if (o) void computeRoute(o, h, profile)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    setOriginPickRequired(false)
    setDestPickRequired(false)
    try {
      let o = origin
      let d = dest
      let needOriginPick = false
      let needDestPick = false

      if (!o || o.label !== originText) {
        const hits = await geocodeKorea(originText)
        setOriginHits(hits)
        if (!hits.length) throw new Error('출발지를 찾을 수 없습니다.')
        if (hits.length === 1) {
          o = hits[0]
          setOrigin(o)
          setOriginText(o.label)
          setOriginHits([])
        } else {
          o = null
          setOrigin(null)
          needOriginPick = true
          setOriginPickRequired(true)
        }
      }

      if (!d || d.label !== destText) {
        const hits = await geocodeKorea(destText)
        setDestHits(hits)
        if (!hits.length) throw new Error('도착지를 찾을 수 없습니다.')
        if (hits.length === 1) {
          d = hits[0]
          setDest(d)
          setDestText(d.label)
          setDestHits([])
        } else {
          d = null
          setDest(null)
          needDestPick = true
          setDestPickRequired(true)
        }
      }

      if (needOriginPick || needDestPick) {
        setRoute(null)
        setError(AMBIGUOUS_HINT)
        return
      }

      if (o && d) await computeRoute(o, d, profile)
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
      <form onSubmit={handleSubmit} className="stack">
        <ProfileToggle value={profile} onChange={onProfileChange} disabled={loading} />
        <label className="field">
          <span>출발</span>
          <input
            value={originText}
            onChange={(e) => {
              setOriginText(e.target.value)
              setOrigin(null)
              setOriginPickRequired(false)
              searchOrigin(e.target.value)
            }}
            placeholder="예: 서울역, 오룡리"
            autoComplete="off"
          />
          {originHits.length > 1 && !origin && (
            <p className="hint field-hint">{originHits.length}곳 후보</p>
          )}
          {showOriginSuggest && (
            <ul className={originPickRequired ? 'suggest always' : 'suggest'}>
              {originHits.map((h) => (
                <li key={h.id}>
                  <button type="button" onClick={() => pickOrigin(h)}>
                    {h.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </label>
        <label className="field">
          <span>도착</span>
          <input
            value={destText}
            onChange={(e) => {
              setDestText(e.target.value)
              setDest(null)
              setDestPickRequired(false)
              searchDest(e.target.value)
            }}
            placeholder="예: 광화문, 오룡리"
            autoComplete="off"
          />
          {destHits.length > 1 && !dest && (
            <p className="hint field-hint">{destHits.length}곳 후보</p>
          )}
          {showDestSuggest && (
            <ul className={destPickRequired ? 'suggest always' : 'suggest'}>
              {destHits.map((h) => (
                <li key={h.id}>
                  <button type="button" onClick={() => pickDest(h)}>
                    {h.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </label>
        <button type="submit" className="primary" disabled={loading}>
          {loading ? '경로 계산 중…' : '경로 찾기'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <RouteSummary route={route} />
    </div>
  )
}
