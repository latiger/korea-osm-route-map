import { useCallback, useMemo, useState } from 'react'
import { reverseGeocodeKorea } from './api/geocode'
import { MapCanvas } from './components/MapCanvas'
import { ModeTabs } from './components/ModeTabs'
import {
  OriginDestPanel,
  type MapResolvedPick,
} from './components/OriginDestPanel'
import { RoadNamePanel } from './components/RoadNamePanel'
import { significantStepMarkers } from './api/displaySteps'
import type {
  AppMode,
  LatLng,
  PlaceMode,
  RouteResult,
  TravelProfile,
} from './types'
import 'leaflet/dist/leaflet.css'
import './App.css'

function App() {
  const [mode, setMode] = useState<AppMode>('od')
  const [profile, setProfile] = useState<TravelProfile>('driving')
  const [markers, setMarkers] = useState<
    Array<LatLng & { key: string; label?: string }>
  >([])
  const [route, setRoute] = useState<RouteResult | null>(null)
  const [focusLocation, setFocusLocation] = useState<LatLng | null>(null)
  const [fitRevision, setFitRevision] = useState(0)
  const [placeMode, setPlaceMode] = useState<PlaceMode | null>(null)
  const [mapPick, setMapPick] = useState<MapResolvedPick | null>(null)
  const [placing, setPlacing] = useState(false)
  const [panelBusy, setPanelBusy] = useState(false)

  const onBusyChange = useCallback((busy: boolean) => {
    setPanelBusy(busy)
  }, [])

  const mapBusy = panelBusy || placing

  const onMarkersChange = useCallback(
    (m: Array<LatLng & { key: string; label?: string }>) => setMarkers(m),
    [],
  )
  const onRouteChange = useCallback((r: RouteResult | null) => {
    setRoute(r)
    if (r == null) setFocusLocation(null)
  }, [])
  const onFocusLocation = useCallback((ll: LatLng) => {
    setFocusLocation({ lat: ll.lat, lng: ll.lng })
  }, [])

  const onPanelReset = useCallback(() => {
    setFocusLocation(null)
    setPlaceMode(null)
    setMapPick(null)
    setFitRevision((n) => n + 1)
  }, [])

  const showFullRoute = useCallback(() => {
    setFocusLocation(null)
    setFitRevision((n) => n + 1)
  }, [])

  function handleModeChange(m: AppMode) {
    setMode(m)
    setMarkers([])
    setRoute(null)
    setFocusLocation(null)
    setPlaceMode(null)
    setMapPick(null)
    setPanelBusy(false)
  }

  async function handleMapPlace(role: PlaceMode, ll: LatLng) {
    setPlacing(true)
    try {
      const result = await reverseGeocodeKorea(ll)
      setMapPick({ role, result, nonce: Date.now() })
    } catch (e) {
      console.error('reverse geocode failed', e)
      setMapPick({
        role,
        result: {
          id: `coord:${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}`,
          label: `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`,
          lat: ll.lat,
          lng: ll.lng,
          type: 'coordinates',
        },
        nonce: Date.now(),
      })
    } finally {
      setPlacing(false)
    }
  }

  const stepMarkers = useMemo(
    () => significantStepMarkers(route?.steps),
    [route?.steps],
  )

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
              onFocusLocation={onFocusLocation}
              onReset={onPanelReset}
              onBusyChange={onBusyChange}
              mapPick={mapPick}
              placeMode={placeMode}
            />
          )}
          {mode === 'road' && (
            <RoadNamePanel
              profile={profile}
              onProfileChange={setProfile}
              onMarkersChange={onMarkersChange}
              onRouteChange={onRouteChange}
              onFocusLocation={onFocusLocation}
              onReset={onPanelReset}
              onBusyChange={onBusyChange}
            />
          )}
        </aside>

        <main className="map-wrap">
          {mapBusy && (
            <div
              className="map-loading-bar"
              role="progressbar"
              aria-label="경로 불러오는 중"
              aria-busy="true"
            />
          )}
          <MapCanvas
            markers={markers}
            route={route?.coordinates ?? []}
            routeLineStrings={route?.lineStrings}
            connectorLineStrings={route?.connectorLineStrings}
            trafficSegments={route?.trafficSegments}
            showPlaceControls={mode === 'od'}
            placeMode={placeMode}
            onPlaceModeChange={setPlaceMode}
            onMapPlace={(role, ll) => {
              void handleMapPlace(role, ll)
            }}
            focus={focusLocation}
            fitRevision={fitRevision}
            stepMarkers={stepMarkers}
          />
          {placing && (
            <div className="place-status" aria-live="polite">
              장소 검색 중…
            </div>
          )}
          {route?.source === 'kakao' &&
            (route.trafficSegments?.length ?? 0) > 0 && (
              <div className="traffic-legend" aria-label="교통 상태 범례">
                <span className="traffic-legend-title">교통</span>
                <span className="traffic-swatch" data-state="4">
                  원활
                </span>
                <span className="traffic-swatch" data-state="3">
                  서행
                </span>
                <span className="traffic-swatch" data-state="2">
                  지체
                </span>
                <span className="traffic-swatch" data-state="1">
                  정체
                </span>
              </div>
            )}
          {focusLocation != null && (
            <button
              type="button"
              className="show-full-route"
              onClick={showFullRoute}
            >
              전체경로보기
            </button>
          )}
        </main>
      </div>
    </div>
  )
}

export default App
