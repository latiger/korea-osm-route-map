import { useEffect, useRef, useState, type FormEvent } from 'react'
import { geocodeKorea } from '../api/nominatim'
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
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      let o = origin
      let d = dest
      if (!o || o.label !== originText) {
        const hits = await geocodeKorea(originText)
        if (!hits.length) throw new Error('출발지를 찾을 수 없습니다.')
        o = hits[0]
        setOrigin(o)
        setOriginHits(hits)
      }
      if (!d || d.label !== destText) {
        const hits = await geocodeKorea(destText)
        if (!hits.length) throw new Error('도착지를 찾을 수 없습니다.')
        d = hits[0]
        setDest(d)
        setDestHits(hits)
      }
      await computeRoute(o, d, profile)
    } catch (err) {
      setRoute(null)
      setError((err as Error).message || '검색 중 오류가 발생했습니다.')
    } finally {
      setLoading(false)
    }
  }

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
              searchOrigin(e.target.value)
            }}
            placeholder="예: 서울역"
            autoComplete="off"
          />
          {originHits.length > 0 && !origin && (
            <ul className="suggest">
              {originHits.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setOrigin(h)
                      setOriginText(h.label)
                      setOriginHits([])
                    }}
                  >
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
              searchDest(e.target.value)
            }}
            placeholder="예: 광화문"
            autoComplete="off"
          />
          {destHits.length > 0 && !dest && (
            <ul className="suggest">
              {destHits.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setDest(h)
                      setDestText(h.label)
                      setDestHits([])
                    }}
                  >
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
