import { useCallback, useState } from 'react'
import { MapCanvas } from './components/MapCanvas'
import { ModeTabs } from './components/ModeTabs'
import { OriginDestPanel } from './components/OriginDestPanel'
import { RoadNamePanel } from './components/RoadNamePanel'
import { WaypointsPanel } from './components/WaypointsPanel'
import type { AppMode, LatLng, RouteResult, TravelProfile } from './types'
import 'leaflet/dist/leaflet.css'
import './App.css'

function App() {
  const [mode, setMode] = useState<AppMode>('od')
  const [profile, setProfile] = useState<TravelProfile>('driving')
  const [markers, setMarkers] = useState<
    Array<LatLng & { key: string; label?: string }>
  >([])
  const [waypoints, setWaypoints] = useState<LatLng[]>([])
  const [route, setRoute] = useState<RouteResult | null>(null)

  const onMarkersChange = useCallback(
    (m: Array<LatLng & { key: string; label?: string }>) => setMarkers(m),
    [],
  )
  const onRouteChange = useCallback((r: RouteResult | null) => setRoute(r), [])

  function handleModeChange(m: AppMode) {
    setMode(m)
    setMarkers([])
    setRoute(null)
    if (m !== 'waypoints') setWaypoints([])
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>한국 OSM 경로 지도</h1>
          <p className="subtitle">
            OpenStreetMap · OSRM · Nominatim 키리스 프로토타입
          </p>
        </div>
        <ModeTabs mode={mode} onChange={handleModeChange} />
      </header>

      <div className="layout">
        <aside className="sidebar">
          {mode === 'od' && (
            <OriginDestPanel
              profile={profile}
              onProfileChange={setProfile}
              onMarkersChange={onMarkersChange}
              onRouteChange={onRouteChange}
            />
          )}
          {mode === 'road' && (
            <RoadNamePanel
              profile={profile}
              onProfileChange={setProfile}
              onMarkersChange={onMarkersChange}
              onRouteChange={onRouteChange}
            />
          )}
          {mode === 'waypoints' && (
            <WaypointsPanel
              profile={profile}
              onProfileChange={setProfile}
              waypoints={waypoints}
              onWaypointsChange={setWaypoints}
              onRouteChange={onRouteChange}
            />
          )}
        </aside>

        <main className="map-wrap">
          <MapCanvas
            markers={mode === 'waypoints' ? [] : markers}
            waypoints={mode === 'waypoints' ? waypoints : []}
            route={route?.coordinates ?? []}
            clickToAddWaypoints={mode === 'waypoints'}
            onMapClick={(ll) => {
              if (mode !== 'waypoints') return
              setWaypoints((prev) => [...prev, ll])
            }}
          />
        </main>
      </div>
    </div>
  )
}

export default App
