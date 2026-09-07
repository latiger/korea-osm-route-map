import { useEffect, useRef, useState } from 'react'
import {
  MapContainer,
  TileLayer,
  Marker,
  CircleMarker,
  Polyline,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import L from 'leaflet'
import { trafficStateColor } from '../api/kakaoNavi'
import type { LatLng, PlaceMode, RouteSegment } from '../types'

export const SEOUL_CENTER: LatLng = { lat: 37.5665, lng: 126.978 }
export const DEFAULT_ZOOM = 12

const ROUTE_STYLE = { color: '#2563eb', weight: 5, opacity: 0.85 }
/** Straight 2-point gap fallback — dashed slate */
const CONNECTOR_FALLBACK_STYLE = {
  color: '#64748b',
  weight: 4,
  opacity: 0.85,
  dashArray: '6 8',
  lineCap: 'round' as const,
  lineJoin: 'round' as const,
}
/** Routed gap bridge (Kakao/OSRM polyline with >2 points) — solid amber */
const CONNECTOR_ROUTED_STYLE = {
  color: '#f59e0b',
  weight: 5,
  opacity: 0.9,
  lineCap: 'round' as const,
  lineJoin: 'round' as const,
}
const TRAFFIC_WEIGHT = 6
const FOCUS_ZOOM = 18

type MarkerRole = 'start' | 'end' | 'via'

function roleFromKey(key: string): MarkerRole {
  if (key === 'origin' || key === 'chain-start') return 'start'
  if (key === 'dest' || key === 'chain-end') return 'end'
  return 'via'
}

function badgeIcon(role: MarkerRole, label: string) {
  const wide = role === 'start' || role === 'end'
  const w = wide ? 48 : 26
  const h = wide ? 32 : 26
  return L.divIcon({
    className: 'marker-icon',
    html: `<div class="marker-badge ${role}">${label}</div>`,
    iconSize: [w, h],
    iconAnchor: [w / 2, h / 2],
  })
}

function stepBadgeIcon(n: number, compact: boolean) {
  const size = compact ? 18 : 22
  const cls = compact ? 'step-map-badge compact' : 'step-map-badge'
  return L.divIcon({
    className: 'marker-icon step-marker-icon',
    html: `<div class="${cls}">${n}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

function markerIconForKey(key: string, index: number) {
  const role = roleFromKey(key)
  if (role === 'start') return badgeIcon('start', '출발')
  if (role === 'end') return badgeIcon('end', '도착')
  if (key.startsWith('via-')) {
    const n = Number(key.slice('via-'.length)) + 1
    return badgeIcon(
      'via',
      String(Number.isFinite(n) && n > 0 ? n : index + 1),
    )
  }
  if (key.startsWith('chain-junction-')) {
    const n = Number(key.slice('chain-junction-'.length)) + 1
    return badgeIcon(
      'via',
      String(Number.isFinite(n) && n > 0 ? n : index + 1),
    )
  }
  return badgeIcon('via', String(index + 1))
}

function FitBounds({
  points,
  route,
  fitRevision = 0,
}: {
  points: LatLng[]
  route: LatLng[]
  fitRevision?: number
}) {
  const map = useMap()
  const key = JSON.stringify([
    points.map((p) => [p.lat, p.lng]),
    route.map((p) => [p.lat, p.lng]),
  ])
  useEffect(() => {
    // Prefer real route geometry; otherwise fit only when ≥2 markers.
    // Single OD point must not zoom/pan (setView / fitBounds).
    let toFit: LatLng[]
    if (route.length >= 2) {
      toFit = [...route, ...points]
    } else if (points.length >= 2) {
      toFit = points
    } else {
      return
    }
    const bounds = L.latLngBounds(
      toFit.map((p) => [p.lat, p.lng] as [number, number]),
    )
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key, fitRevision])
  return null
}

function FlyTo({
  focus,
  onFlew,
}: {
  focus?: LatLng | null
  onFlew?: (ll: LatLng) => void
}) {
  const map = useMap()
  useEffect(() => {
    if (!focus) return
    map.flyTo([focus.lat, focus.lng], FOCUS_ZOOM, { duration: 0.6 })
    onFlew?.(focus)
  }, [map, focus, onFlew])
  return null
}

function ClickHandler({
  enabled,
  onClick,
}: {
  enabled: boolean
  onClick: (ll: LatLng) => void
}) {
  useMapEvents({
    click(e) {
      if (!enabled) return
      onClick({ lat: e.latlng.lat, lng: e.latlng.lng })
    },
  })
  return null
}

/** Leaflet control: 출발 / 도착 / 경유지 place-mode toggles under zoom. */
function PlaceModeControl({
  visible,
  placeMode,
  onPlaceModeChange,
}: {
  visible: boolean
  placeMode: PlaceMode | null
  onPlaceModeChange: (mode: PlaceMode | null) => void
}) {
  const map = useMap()
  const placeModeRef = useRef(placeMode)
  const onChangeRef = useRef(onPlaceModeChange)
  const buttonsRef = useRef<Partial<Record<PlaceMode, HTMLAnchorElement>>>({})

  placeModeRef.current = placeMode
  onChangeRef.current = onPlaceModeChange

  // Create/add the control once when visible — do not remount on placeMode changes.
  useEffect(() => {
    if (!visible) {
      map.getContainer().classList.remove('placing')
      buttonsRef.current = {}
      return
    }

    const roles: { role: PlaceMode; label: string }[] = [
      { role: 'origin', label: '출발' },
      { role: 'dest', label: '도착' },
      { role: 'via', label: '경유지' },
    ]
    const buttons: Partial<Record<PlaceMode, HTMLAnchorElement>> = {}

    const control = new (L.Control.extend({
      options: { position: 'topleft' as L.ControlPosition },
      onAdd() {
        const wrap = L.DomUtil.create(
          'div',
          'leaflet-bar place-mode-control',
        )
        L.DomEvent.disableClickPropagation(wrap)
        L.DomEvent.disableScrollPropagation(wrap)

        for (const { role, label } of roles) {
          const btn = L.DomUtil.create('a', 'place-mode-btn', wrap) as HTMLAnchorElement
          btn.href = '#'
          btn.role = 'button'
          btn.title = `${label} 지도에서 지정`
          btn.setAttribute('aria-label', `${label} 지도에서 지정`)
          btn.setAttribute('aria-pressed', 'false')
          btn.dataset.role = role
          btn.textContent = label
          L.DomEvent.on(btn, 'click', (ev) => {
            L.DomEvent.preventDefault(ev)
            L.DomEvent.stopPropagation(ev)
            const current = placeModeRef.current
            onChangeRef.current(current === role ? null : role)
          })
          buttons[role] = btn
        }

        return wrap
      },
    }))()

    map.addControl(control)
    buttonsRef.current = buttons

    // Sync active state for current placeMode after mount
    const current = placeModeRef.current
    for (const { role } of roles) {
      const btn = buttons[role]
      if (!btn) continue
      const active = current === role
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-pressed', active ? 'true' : 'false')
    }

    return () => {
      map.removeControl(control)
      buttonsRef.current = {}
    }
  }, [map, visible])

  // Update .active / aria-pressed when placeMode changes — without remounting control.
  useEffect(() => {
    const buttons = buttonsRef.current
    for (const role of ['origin', 'dest', 'via'] as PlaceMode[]) {
      const btn = buttons[role]
      if (!btn) continue
      const active = placeMode === role
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-pressed', active ? 'true' : 'false')
    }
  }, [placeMode])

  useEffect(() => {
    const el = map.getContainer()
    if (visible && placeMode) el.classList.add('placing')
    else el.classList.remove('placing')
    return () => {
      el.classList.remove('placing')
    }
  }, [map, visible, placeMode])

  return null
}

export interface MapCanvasProps {
  markers?: Array<LatLng & { key: string; label?: string }>
  /** Single polyline (OSRM / fallback) */
  route?: LatLng[]
  /**
   * Official MultiLineString roads: draw each entry as its own Polyline.
   * When present and non-empty, drawn as blue polylines (alongside trafficSegments).
   */
  routeLineStrings?: LatLng[][]
  /**
   * Gap bridges between official MultiLineString parts.
   * 2-point lines = dashed straight fallback; >2 points = solid routed path.
   */
  connectorLineStrings?: LatLng[][]
  /** Kakao traffic-colored road segments (preferred when present) */
  trafficSegments?: RouteSegment[]
  /** When set, map clicks place OD points (keep armed until toggled off) */
  placeMode?: PlaceMode | null
  onPlaceModeChange?: (mode: PlaceMode | null) => void
  /** Show place-mode toolbar (od mode only) */
  showPlaceControls?: boolean
  onMapPlace?: (role: PlaceMode, ll: LatLng) => void
  /** Pan/zoom target from route-step click */
  focus?: LatLng | null
  /** Bump to re-run FitBounds (restore full-route view) */
  fitRevision?: number
  /** Numbered route-step markers matching RouteSummary list indices */
  stepMarkers?: Array<{ n: number; lat: number; lng: number; label?: string }>
}

export function MapCanvas({
  markers = [],
  route = [],
  routeLineStrings,
  connectorLineStrings,
  trafficSegments,
  placeMode = null,
  onPlaceModeChange,
  showPlaceControls = false,
  onMapPlace,
  focus = null,
  fitRevision = 0,
  stepMarkers = [],
}: MapCanvasProps) {
  const [highlight, setHighlight] = useState<LatLng | null>(null)

  useEffect(() => {
    if (!highlight) return
    const t = window.setTimeout(() => setHighlight(null), 2200)
    return () => window.clearTimeout(t)
  }, [highlight])

  const fitPoints = markers.map((m) => ({ lat: m.lat, lng: m.lng }))

  const traffic =
    trafficSegments?.filter((s) => s.coordinates.length > 1) ?? []
  const useTraffic = traffic.length > 0
  const multi = routeLineStrings?.filter((line) => line.length > 1) ?? []
  const useMulti = multi.length > 0
  const connectors =
    connectorLineStrings?.filter((line) => line.length > 1) ?? []
  const fitRoute = [
    ...(useTraffic ? traffic.flatMap((s) => s.coordinates) : []),
    ...(useMulti ? multi.flat() : []),
    ...connectors.flat(),
    ...(!useTraffic && !useMulti ? route : []),
  ]

  return (
    <MapContainer
      center={[SEOUL_CENTER.lat, SEOUL_CENTER.lng]}
      zoom={DEFAULT_ZOOM}
      className="map-canvas"
      scrollWheelZoom
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <PlaceModeControl
        visible={showPlaceControls}
        placeMode={placeMode}
        onPlaceModeChange={(m) => onPlaceModeChange?.(m)}
      />
      <ClickHandler
        enabled={showPlaceControls && placeMode != null}
        onClick={(ll) => {
          if (!placeMode) return
          onMapPlace?.(placeMode, ll)
        }}
      />
      <FitBounds points={fitPoints} route={fitRoute} fitRevision={fitRevision} />
      <FlyTo focus={focus} onFlew={setHighlight} />
      {markers.map((m, i) => (
        <Marker
          key={m.key}
          position={[m.lat, m.lng]}
          title={m.label}
          icon={markerIconForKey(m.key, i)}
          zIndexOffset={600}
        />
      ))}
      {stepMarkers.map((s) => (
        <Marker
          key={`step-${s.n}-${s.lat}-${s.lng}`}
          position={[s.lat, s.lng]}
          title={s.label ? `${s.n}. ${s.label}` : String(s.n)}
          icon={stepBadgeIcon(s.n, stepMarkers.length > 40)}
          zIndexOffset={500}
          interactive={false}
        />
      ))}
      {highlight && (
        <CircleMarker
          center={[highlight.lat, highlight.lng]}
          radius={12}
          pathOptions={{
            color: '#38bdf8',
            fillColor: '#38bdf8',
            fillOpacity: 0.35,
            weight: 2,
          }}
        />
      )}
      {useMulti &&
        multi.map((line, i) => (
          <Polyline
            key={`route-line-${i}`}
            positions={line.map((p) => [p.lat, p.lng] as [number, number])}
            pathOptions={ROUTE_STYLE}
          />
        ))}
      {connectors.map((line, i) => (
        <Polyline
          key={`connector-line-${i}`}
          positions={line.map((p) => [p.lat, p.lng] as [number, number])}
          pathOptions={
            line.length > 2 ? CONNECTOR_ROUTED_STYLE : CONNECTOR_FALLBACK_STYLE
          }
        />
      ))}
      {useTraffic &&
        traffic.map((seg, i) => (
          <Polyline
            key={`traffic-seg-${i}`}
            positions={seg.coordinates.map(
              (p) => [p.lat, p.lng] as [number, number],
            )}
            pathOptions={{
              color: trafficStateColor(seg.trafficState),
              weight: TRAFFIC_WEIGHT,
              opacity: 0.9,
              lineCap: 'round',
              lineJoin: 'round',
            }}
          />
        ))}
      {!useTraffic && !useMulti && route.length > 1 && (
        <Polyline
          positions={route.map((p) => [p.lat, p.lng] as [number, number])}
          pathOptions={ROUTE_STYLE}
        />
      )}
    </MapContainer>
  )
}
