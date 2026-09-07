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
import { looksLikeFerryName } from '../api/ferryHints'
import type { LatLng, MapFocus, PlaceMode, RouteSegment } from '../types'

export const SEOUL_CENTER: LatLng = { lat: 37.5665, lng: 126.978 }
export const DEFAULT_ZOOM = 12

const ROUTE_STYLE = { color: '#2563eb', weight: 5, opacity: 0.85 }
const TRAFFIC_WEIGHT = 6
/** Bridge consecutive traffic segments when endpoints are farther than this. */
const TRAFFIC_GAP_BRIDGE_M = 30
/** Only short stitch holes — never long straight chords across the map. */
const TRAFFIC_GAP_BRIDGE_MAX_M = 500
/**
 * Max consecutive-point distance (m) to keep in one drawn polyline piece.
 * Sparse stitch / official holes often jump kilometers — Leaflet would chord those.
 */
const POLYLINE_MAX_JUMP_M = 600
/**
 * Drop long near-straight sparse chords (ferry / open-water stitches) after
 * jump-splitting. Real bridges usually have denser vertices; coastal roads wind.
 */
const OPEN_WATER_MIN_LENGTH_M = 600
const OPEN_WATER_STRAIGHTNESS_MAX = 1.12
const OPEN_WATER_AVG_STEP_M = 200

function latLngDist2(a: LatLng, b: LatLng): number {
  const dLat = a.lat - b.lat
  const dLng = a.lng - b.lng
  return dLat * dLat + dLng * dLng
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

/**
 * Split a polyline into continuous pieces so Leaflet never draws a straight
 * chord across consecutive points farther than maxJumpM apart.
 */
export function splitPolylineOnJumps(
  points: LatLng[],
  maxJumpM: number = POLYLINE_MAX_JUMP_M,
): LatLng[][] {
  if (points.length < 2) return []
  const pieces: LatLng[][] = []
  let current: LatLng[] = [points[0]!]
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!
    const p = points[i]!
    if (haversineMeters(prev, p) > maxJumpM) {
      if (current.length > 1) pieces.push(current)
      current = [p]
    } else {
      current.push(p)
    }
  }
  if (current.length > 1) pieces.push(current)
  return pieces
}

function pathLengthMeters(points: LatLng[]): number {
  let sum = 0
  for (let i = 1; i < points.length; i++) {
    sum += haversineMeters(points[i - 1]!, points[i]!)
  }
  return sum
}

/**
 * Heuristic for ferry / open-water chords between islands:
 * long, near-straight, sparsely sampled — or an explicit ferry name hint.
 * Sinuous coastal roads (path ≫ chord) and dense bridge polylines stay.
 */
export function looksLikeOpenWaterChord(
  points: LatLng[],
  name?: string | null,
): boolean {
  if (looksLikeFerryName(name)) return true
  if (points.length < 2) return false
  const pathLen = pathLengthMeters(points)
  if (pathLen < OPEN_WATER_MIN_LENGTH_M) return false
  const start = points[0]!
  const end = points[points.length - 1]!
  const chord = haversineMeters(start, end)
  if (chord < OPEN_WATER_MIN_LENGTH_M * 0.85) return false
  if (chord <= 0) return false
  const ratio = pathLen / chord
  if (ratio > OPEN_WATER_STRAIGHTNESS_MAX) return false
  const avgStep = pathLen / (points.length - 1)
  if (avgStep < OPEN_WATER_AVG_STEP_M) return false
  return true
}

function dropOpenWaterPieces(
  pieces: LatLng[][],
  name?: string | null,
): LatLng[][] {
  return pieces.filter((piece) => !looksLikeOpenWaterChord(piece, name))
}

type TrafficGapBridge = { from: LatLng; to: LatLng; color: string }

/** Straight bridges for stitch holes between consecutive traffic segments. */
function buildTrafficGapBridges(traffic: RouteSegment[]): TrafficGapBridge[] {
  const bridges: TrafficGapBridge[] = []
  for (let i = 0; i < traffic.length - 1; i++) {
    const segA = traffic[i]!
    const segB = traffic[i + 1]!
    const aEnd = segA.coordinates[segA.coordinates.length - 1]
    const bStart = segB.coordinates[0]
    if (!aEnd || !bStart) continue
    const d = haversineMeters(aEnd, bStart)
    // Short stitch only; long holes are filled in drivingRebuild with real routes.
    if (d <= TRAFFIC_GAP_BRIDGE_M || d > TRAFFIC_GAP_BRIDGE_MAX_M) continue
    bridges.push({
      from: aEnd,
      to: bStart,
      color: trafficStateColor(segA.trafficState),
    })
  }
  return bridges
}

/** Match connector color to nearby traffic segment, else main route blue. */
function connectorColor(line: LatLng[], traffic: RouteSegment[]): string {
  if (traffic.length === 0) return ROUTE_STYLE.color

  const midIdx = Math.floor(line.length / 2)
  const ref = line[midIdx] ?? line[0]
  if (!ref) return ROUTE_STYLE.color

  let bestSeg: RouteSegment | null = null
  let bestDist = Infinity
  for (const seg of traffic) {
    const coords = seg.coordinates
    if (coords.length === 0) continue
    const start = coords[0]
    const end = coords[coords.length - 1]
    const d = Math.min(latLngDist2(ref, start), latLngDist2(ref, end))
    if (d < bestDist) {
      bestDist = d
      bestSeg = seg
    }
  }

  if (bestSeg) return trafficStateColor(bestSeg.trafficState)
  // Fallback: first/last traffic segment color or main blue
  const fallback = traffic[0] ?? traffic[traffic.length - 1]
  return fallback
    ? trafficStateColor(fallback.trafficState)
    : ROUTE_STYLE.color
}

/**
 * Gap connectors share route/traffic color family.
 * Only routed connectors (>2 pts) are drawn on the map; 2-point official
 * straights stay in GapList for 「이어서 연결」 and are not painted.
 */
function connectorPathOptions(
  line: LatLng[],
  traffic: RouteSegment[],
): L.PathOptions {
  const color = connectorColor(line, traffic)
  const useTrafficLook = traffic.length > 0
  return {
    color,
    weight: useTrafficLook ? TRAFFIC_WEIGHT : ROUTE_STYLE.weight,
    opacity: useTrafficLook ? 0.9 : ROUTE_STYLE.opacity,
    lineCap: 'round',
    lineJoin: 'round',
  }
}

/** Draw only real routed connectors; omit 2-point official straight chords. */
function drawableConnectors(lines: LatLng[][] | undefined): LatLng[][] {
  if (!lines?.length) return []
  return lines.filter((line) => line.length > 2)
}
/** Default max zoom for single-point (route step) focus. */
export const STEP_FOCUS_MAX_ZOOM = 16
/** Default max zoom when fitting a gap [from, to] bounds. */
export const GAP_FOCUS_MAX_ZOOM = 14
/** If gap endpoints are closer than this, fly to `from` instead of fitBounds. */
const FOCUS_NEAR_EQUAL_M = 50

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

function FocusView({
  focus,
  onFocused,
}: {
  focus?: MapFocus | null
  onFocused?: (points: LatLng[]) => void
}) {
  const map = useMap()
  useEffect(() => {
    if (!focus?.points?.length) return
    const points = focus.points
    const maxZoom = focus.maxZoom ?? STEP_FOCUS_MAX_ZOOM
    onFocused?.(points)

    if (points.length === 1) {
      const p = points[0]!
      map.flyTo([p.lat, p.lng], maxZoom, { duration: 0.6 })
      return
    }

    const bounds = L.latLngBounds(
      points.map((p) => [p.lat, p.lng] as [number, number]),
    )
    const sw = bounds.getSouthWest()
    const ne = bounds.getNorthEast()
    const spanM = haversineMeters(
      { lat: sw.lat, lng: sw.lng },
      { lat: ne.lat, lng: ne.lng },
    )
    // from≈to (or tiny span): fly to primary point (first = gap.from) at city zoom
    if (spanM < FOCUS_NEAR_EQUAL_M) {
      const p = points[0]!
      map.flyTo([p.lat, p.lng], maxZoom, { duration: 0.6 })
      return
    }
    map.flyToBounds(bounds, {
      padding: [72, 72],
      maxZoom,
      duration: 0.6,
    })
  }, [map, focus, onFocused])
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
   * Only routed (>2 pts) connectors are drawn; 2-point straights stay in GapList.
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
  /** Pan/zoom target from route-step or gap-list click */
  focus?: MapFocus | null
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
  const [highlights, setHighlights] = useState<LatLng[]>([])

  useEffect(() => {
    if (!highlights.length) return
    const t = window.setTimeout(() => setHighlights([]), 2200)
    return () => window.clearTimeout(t)
  }, [highlights])

  const fitPoints = markers.map((m) => ({ lat: m.lat, lng: m.lng }))

  const trafficRaw =
    trafficSegments?.filter((s) => s.coordinates.length > 1) ?? []
  /** Skip whole ferry-named / open-water traffic segments before drawing. */
  const traffic = trafficRaw.filter(
    (s) => !looksLikeOpenWaterChord(s.coordinates, s.name),
  )
  const useTraffic = traffic.length > 0
  const multi = routeLineStrings?.filter((line) => line.length > 1) ?? []
  const useMulti = multi.length > 0
  /** Routed connectors only — never paint 2-point official straight chords. */
  const connectors = drawableConnectors(connectorLineStrings)
  /** Route underlay / single-polyline fallback, split so sparse stitches do not chord. */
  const routePieces = dropOpenWaterPieces(splitPolylineOnJumps(route))
  const multiPieces = useMulti
    ? multi.flatMap((line, i) =>
        dropOpenWaterPieces(splitPolylineOnJumps(line)).map((piece, j) => ({
          key: `route-line-${i}-${j}`,
          piece,
        })),
      )
    : []
  const routeUnderlayColor = useTraffic
    ? connectorColor(route, traffic)
    : ROUTE_STYLE.color
  /** Fill short stitch holes between consecutive traffic pieces. */
  const gapBridges = useTraffic ? buildTrafficGapBridges(traffic) : []
  /** Traffic draw pieces: jump-split then drop open-water chords. */
  const trafficPieces = useTraffic
    ? traffic.flatMap((seg, i) =>
        dropOpenWaterPieces(splitPolylineOnJumps(seg.coordinates), seg.name).map(
          (piece, j) => ({
            key: `traffic-seg-${i}-${j}`,
            piece,
            trafficState: seg.trafficState,
          }),
        ),
      )
    : []
  const fitRoute = [
    ...trafficPieces.flatMap((s) => s.piece),
    ...multiPieces.flatMap((m) => m.piece),
    ...connectors.flat(),
    ...routePieces.flat(),
    ...gapBridges.flatMap((b) => [b.from, b.to]),
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
      <FocusView focus={focus} onFocused={setHighlights} />
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
      {highlights.map((h, i) => (
        <CircleMarker
          key={`focus-hl-${i}-${h.lat}-${h.lng}`}
          center={[h.lat, h.lng]}
          radius={i === 0 ? 14 : 10}
          pathOptions={{
            color: i === 0 ? '#f59e0b' : '#38bdf8',
            fillColor: i === 0 ? '#f59e0b' : '#38bdf8',
            fillOpacity: 0.4,
            weight: 2,
          }}
        />
      ))}
      {routePieces.map((piece, i) => (
        <Polyline
          key={`route-underlay-${i}`}
          positions={piece.map((p) => [p.lat, p.lng] as [number, number])}
          pathOptions={{
            color: routeUnderlayColor,
            weight: useTraffic ? TRAFFIC_WEIGHT : ROUTE_STYLE.weight,
            opacity: useTraffic ? 0.75 : ROUTE_STYLE.opacity,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
      ))}
      {multiPieces.map(({ key, piece }) => (
        <Polyline
          key={key}
          positions={piece.map((p) => [p.lat, p.lng] as [number, number])}
          pathOptions={ROUTE_STYLE}
        />
      ))}
      {connectors.flatMap((line, i) =>
        splitPolylineOnJumps(line).map((piece, j) => (
          <Polyline
            key={`connector-line-${i}-${j}`}
            positions={piece.map((p) => [p.lat, p.lng] as [number, number])}
            pathOptions={connectorPathOptions(line, traffic)}
          />
        )),
      )}
      {gapBridges.map((b, i) => (
        <Polyline
          key={`traffic-gap-bridge-${i}`}
          positions={[
            [b.from.lat, b.from.lng] as [number, number],
            [b.to.lat, b.to.lng] as [number, number],
          ]}
          pathOptions={{
            color: b.color,
            weight: TRAFFIC_WEIGHT,
            opacity: 0.9,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
      ))}
      {trafficPieces.map(({ key, piece, trafficState }) => (
        <Polyline
          key={key}
          positions={piece.map((p) => [p.lat, p.lng] as [number, number])}
          pathOptions={{
            color: trafficStateColor(trafficState),
            weight: TRAFFIC_WEIGHT,
            opacity: 0.9,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
      ))}
    </MapContainer>
  )
}
