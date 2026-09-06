import { useEffect, useState } from 'react'
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
import type { LatLng, RouteSegment } from '../types'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

// Fix default marker icons under Vite
const DefaultIcon = L.icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})
L.Marker.prototype.options.icon = DefaultIcon

export const SEOUL_CENTER: LatLng = { lat: 37.5665, lng: 126.978 }
export const DEFAULT_ZOOM = 12

const ROUTE_STYLE = { color: '#2563eb', weight: 5, opacity: 0.85 }
const TRAFFIC_WEIGHT = 6
const FOCUS_ZOOM = 18

const waypointIcon = (n: number) =>
  L.divIcon({
    className: 'waypoint-marker',
    html: `<div class="waypoint-badge">${n}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  })

function FitBounds({
  points,
  route,
  fitRevision = 0,
}: {
  points: LatLng[]
  route: LatLng[]
  /** Bump to re-run fitBounds (e.g. restore full route after step focus) */
  fitRevision?: number
}) {
  const map = useMap()
  // Content key so new array refs on focus re-renders do not re-fit (and undo FlyTo)
  const key = JSON.stringify([
    points.map((p) => [p.lat, p.lng]),
    route.map((p) => [p.lat, p.lng]),
  ])
  useEffect(() => {
    const all = [...points, ...route]
    if (all.length === 0) return
    if (all.length === 1) {
      map.setView([all[0].lat, all[0].lng], 14)
      return
    }
    const bounds = L.latLngBounds(all.map((p) => [p.lat, p.lng] as [number, number]))
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16 })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- points/route via key; fitRevision forces re-fit
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

export interface MapCanvasProps {
  markers?: Array<LatLng & { key: string; label?: string }>
  waypoints?: LatLng[]
  /** Single polyline (OSRM / fallback) */
  route?: LatLng[]
  /**
   * Official MultiLineString roads: draw each entry as its own Polyline.
   * When present and non-empty, drawn as blue polylines (alongside trafficSegments).
   */
  routeLineStrings?: LatLng[][]
  /** Kakao traffic-colored road segments (preferred when present) */
  trafficSegments?: RouteSegment[]
  clickToAddWaypoints?: boolean
  onMapClick?: (ll: LatLng) => void
  /** Pan/zoom target from route-step click */
  focus?: LatLng | null
  /** Bump to re-run FitBounds (restore full-route view) */
  fitRevision?: number
}

export function MapCanvas({
  markers = [],
  waypoints = [],
  route = [],
  routeLineStrings,
  trafficSegments,
  clickToAddWaypoints = false,
  onMapClick,
  focus = null,
  fitRevision = 0,
}: MapCanvasProps) {
  const [highlight, setHighlight] = useState<LatLng | null>(null)

  useEffect(() => {
    if (!highlight) return
    const t = window.setTimeout(() => setHighlight(null), 2200)
    return () => window.clearTimeout(t)
  }, [highlight])

  const fitPoints = [
    ...markers.map((m) => ({ lat: m.lat, lng: m.lng })),
    ...waypoints,
  ]

  const traffic =
    trafficSegments?.filter((s) => s.coordinates.length > 1) ?? []
  const useTraffic = traffic.length > 0
  const multi =
    routeLineStrings?.filter((line) => line.length > 1) ?? []
  // Draw lineStrings even when trafficSegments exist (chained official roads
  // + Kakao connectors). Previously traffic hid multi-polylines.
  const useMulti = multi.length > 0
  const fitRoute = [
    ...(useTraffic ? traffic.flatMap((s) => s.coordinates) : []),
    ...(useMulti ? multi.flat() : []),
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
      <ClickHandler
        enabled={clickToAddWaypoints}
        onClick={(ll) => onMapClick?.(ll)}
      />
      <FitBounds points={fitPoints} route={fitRoute} fitRevision={fitRevision} />
      <FlyTo focus={focus} onFlew={setHighlight} />
      {markers.map((m) => (
        <Marker key={m.key} position={[m.lat, m.lng]} title={m.label} />
      ))}
      {waypoints.map((w, i) => (
        <Marker
          key={`wp-${i}-${w.lat}-${w.lng}`}
          position={[w.lat, w.lng]}
          icon={waypointIcon(i + 1)}
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
