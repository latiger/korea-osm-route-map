import { useEffect, useRef, useState } from 'react'
import { fetchRoute } from '../api/osrm'
import type { LatLng, RouteResult, TravelProfile } from '../types'
import { ProfileToggle } from './ProfileToggle'
import { RouteSummary } from './RouteSummary'

interface Props {
  profile: TravelProfile
  onProfileChange: (p: TravelProfile) => void
  waypoints: LatLng[]
  onWaypointsChange: (pts: LatLng[]) => void
  onRouteChange: (route: RouteResult | null) => void
}

export function WaypointsPanel({
  profile,
  onProfileChange,
  waypoints,
  onWaypointsChange,
  onRouteChange,
}: Props) {
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    onRouteChange(route)
  }, [route, onRouteChange])

  useEffect(() => {
    abortRef.current?.abort()
    if (waypoints.length < 2) {
      setRoute(null)
      setError(null)
      setLoading(false)
      return
    }

    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true)
    setError(null)

    void (async () => {
      try {
        const r = await fetchRoute(waypoints, profile, ac.signal)
        setRoute(r)
      } catch (e) {
        if ((e as Error).name === 'AbortError') return
        setRoute(null)
        setError((e as Error).message || '경유 경로 계산 실패')
      } finally {
        setLoading(false)
      }
    })()

    return () => ac.abort()
  }, [waypoints, profile])

  return (
    <div className="panel">
      <div className="stack">
        <ProfileToggle value={profile} onChange={onProfileChange} disabled={loading} />
        <p className="hint">
          지도를 클릭해 경유점을 순서대로 추가하세요. OSRM이 순서대로 도로
          경로를 연결합니다.
        </p>
        <p className="meta">
          경유점 <strong>{waypoints.length}</strong>개
          {loading ? ' · 계산 중…' : ''}
        </p>
        {waypoints.length > 0 && (
          <ol className="wp-list">
            {waypoints.map((w, i) => (
              <li key={`${i}-${w.lat}-${w.lng}`}>
                {i + 1}. {w.lat.toFixed(5)}, {w.lng.toFixed(5)}
              </li>
            ))}
          </ol>
        )}
        <div className="row">
          <button
            type="button"
            className="primary danger"
            onClick={() => {
              onWaypointsChange([])
              setRoute(null)
              setError(null)
            }}
            disabled={waypoints.length === 0}
          >
            초기화
          </button>
          <button
            type="button"
            onClick={() => onWaypointsChange(waypoints.slice(0, -1))}
            disabled={waypoints.length === 0}
          >
            마지막 점 삭제
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <RouteSummary route={route} />
    </div>
  )
}
