import { useEffect } from 'react'
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import L from 'leaflet'
import type { LatLng } from '../types'
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
}: {
  points: LatLng[]
  route: LatLng[]
}) {
  const map = useMap()
  useEffect(() => {
    const all = [...points, ...route]
    if (all.length === 0) return
    if (all.length === 1) {
      map.setView([all[0].lat, all[0].lng], 14)
      return
    }
    const bounds = L.latLngBounds(all.map((p) => [p.lat, p.lng] as [number, number]))
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16 })
  }, [map, points, route])
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
  route?: LatLng[]
  clickToAddWaypoints?: boolean
  onMapClick?: (ll: LatLng) => void
}

export function MapCanvas({
  markers = [],
  waypoints = [],
  route = [],
  clickToAddWaypoints = false,
  onMapClick,
}: MapCanvasProps) {
  const fitPoints = [
    ...markers.map((m) => ({ lat: m.lat, lng: m.lng })),
    ...waypoints,
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
      <FitBounds points={fitPoints} route={route} />
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
      {route.length > 1 && (
        <Polyline
          positions={route.map((p) => [p.lat, p.lng] as [number, number])}
          pathOptions={{ color: '#2563eb', weight: 5, opacity: 0.85 }}
        />
      )}
    </MapContainer>
  )
}
