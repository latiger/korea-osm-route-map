import { useEffect, useMemo, useRef, useState } from 'react'
import { trafficStateColor } from '../api/kakaoNavi'
import {
  dropOpenWaterPieces,
  distanceToPolylinesMeters,
  haversineMeters,
  looksLikeOpenWaterChord,
  splitPolylineOnJumps,
  STEP_MARKER_MAX_DIST_M,
} from '../api/openWaterFilter'
import type { LatLng, RouteSegment } from '../types'
import type { MapCanvasProps } from './mapCanvasTypes'

const SEOUL_CENTER: LatLng = { lat: 37.5665, lng: 126.978 }
const DEFAULT_ZOOM = 12
const STEP_FOCUS_MAX_ZOOM = 16

const ROUTE_STYLE = { color: '#2563eb', weight: 5, opacity: 0.85 }
const TRAFFIC_WEIGHT = 6
const TRAFFIC_GAP_BRIDGE_M = 30
const TRAFFIC_GAP_BRIDGE_MAX_M = 500
const FOCUS_NEAR_EQUAL_M = 50

function latLngDist2(a: LatLng, b: LatLng): number {
  const dLat = a.lat - b.lat
  const dLng = a.lng - b.lng
  return dLat * dLat + dLng * dLng
}

type TrafficGapBridge = { from: LatLng; to: LatLng; color: string }

function buildTrafficGapBridges(traffic: RouteSegment[]): TrafficGapBridge[] {
  const bridges: TrafficGapBridge[] = []
  for (let i = 0; i < traffic.length - 1; i++) {
    const segA = traffic[i]!
    const segB = traffic[i + 1]!
    const aEnd = segA.coordinates[segA.coordinates.length - 1]
    const bStart = segB.coordinates[0]
    if (!aEnd || !bStart) continue
    const d = haversineMeters(aEnd, bStart)
    if (d <= TRAFFIC_GAP_BRIDGE_M || d > TRAFFIC_GAP_BRIDGE_MAX_M) continue
    bridges.push({
      from: aEnd,
      to: bStart,
      color: trafficStateColor(segA.trafficState),
    })
  }
  return bridges
}

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
    const start = coords[0]!
    const end = coords[coords.length - 1]!
    const d = Math.min(latLngDist2(ref, start), latLngDist2(ref, end))
    if (d < bestDist) {
      bestDist = d
      bestSeg = seg
    }
  }
  if (bestSeg) return trafficStateColor(bestSeg.trafficState)
  const fallback = traffic[0] ?? traffic[traffic.length - 1]
  return fallback
    ? trafficStateColor(fallback.trafficState)
    : ROUTE_STYLE.color
}

function drawableConnectors(lines: LatLng[][] | undefined): LatLng[][] {
  if (!lines?.length) return []
  return lines.filter((line) => line.length > 2)
}

type MarkerRole = 'start' | 'end' | 'via'

function roleFromKey(key: string): MarkerRole {
  if (key === 'origin' || key === 'chain-start') return 'start'
  if (key === 'dest' || key === 'chain-end') return 'end'
  return 'via'
}

function markerLabelForKey(key: string, index: number): string {
  const role = roleFromKey(key)
  if (role === 'start') return '출발'
  if (role === 'end') return '도착'
  if (key.startsWith('via-')) {
    const n = Number(key.slice('via-'.length)) + 1
    return String(Number.isFinite(n) && n > 0 ? n : index + 1)
  }
  if (key.startsWith('chain-junction-')) {
    const n = Number(key.slice('chain-junction-'.length)) + 1
    return String(Number.isFinite(n) && n > 0 ? n : index + 1)
  }
  return String(index + 1)
}

function badgeHtml(role: MarkerRole, label: string): string {
  return `<div class="marker-badge ${role}">${label}</div>`
}

function stepBadgeHtml(n: number, compact: boolean): string {
  const cls = compact ? 'step-map-badge compact' : 'step-map-badge'
  return `<div class="${cls}">${n}</div>`
}

function toNaverLatLng(p: LatLng): naver.maps.LatLng {
  return new naver.maps.LatLng(p.lat, p.lng)
}

function pathToNaver(path: LatLng[]): naver.maps.LatLng[] {
  return path.map(toNaverLatLng)
}

export function isNaverMapsReady(): boolean {
  return typeof window !== 'undefined' && !!window.naver?.maps?.Map
}

export function getNaverMapClientId(): string {
  try {
    return typeof __NAVER_MAP_CLIENT_ID__ === 'string'
      ? __NAVER_MAP_CLIENT_ID__
      : ''
  } catch {
    return ''
  }
}

/**
 * Naver Dynamic Map canvas — primary basemap when Maps JS is loaded.
 */
export function NaverMapCanvas({
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
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<naver.maps.Map | null>(null)
  const overlaysRef = useRef<Array<{ setMap: (m: null) => void }>>([])
  const clickListenerRef = useRef<unknown>(null)
  const [highlights, setHighlights] = useState<LatLng[]>([])
  const placeModeRef = useRef(placeMode)
  placeModeRef.current = placeMode

  const trafficRaw =
    trafficSegments?.filter((s) => s.coordinates.length > 1) ?? []
  const traffic = trafficRaw.filter(
    (s) => !looksLikeOpenWaterChord(s.coordinates, s.name),
  )
  const useTraffic = traffic.length > 0
  const multi = routeLineStrings?.filter((line) => line.length > 1) ?? []
  const useMulti = multi.length > 0
  const connectorsRaw = drawableConnectors(connectorLineStrings)
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
  const gapBridges = (useTraffic ? buildTrafficGapBridges(traffic) : []).filter(
    (b) => !looksLikeOpenWaterChord([b.from, b.to]),
  )
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
  const connectorPieces = connectorsRaw.flatMap((line, i) =>
    dropOpenWaterPieces(splitPolylineOnJumps(line)).map((piece, j) => ({
      key: `connector-line-${i}-${j}`,
      piece,
      sourceLine: line,
    })),
  )
  const drawableForSteps: LatLng[][] = useMemo(
    () => [
      ...trafficPieces.map((s) => s.piece),
      ...multiPieces.map((m) => m.piece),
      ...routePieces,
      ...connectorPieces.map((c) => c.piece),
      ...gapBridges.map((b) => [b.from, b.to]),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trafficSegments, routeLineStrings, connectorLineStrings, route],
  )
  const visibleStepMarkers =
    drawableForSteps.length === 0
      ? stepMarkers
      : stepMarkers.filter(
          (s) =>
            distanceToPolylinesMeters(
              { lat: s.lat, lng: s.lng },
              drawableForSteps,
            ) <= STEP_MARKER_MAX_DIST_M,
        )
  const fitRoute = [
    ...trafficPieces.flatMap((s) => s.piece),
    ...multiPieces.flatMap((m) => m.piece),
    ...connectorPieces.flatMap((c) => c.piece),
    ...routePieces.flat(),
    ...gapBridges.flatMap((b) => [b.from, b.to]),
  ]
  const fitPoints = markers.map((m) => ({ lat: m.lat, lng: m.lng }))

  // Init map once
  useEffect(() => {
    if (!containerRef.current || !isNaverMapsReady()) return
    if (mapRef.current) return
    const map = new naver.maps.Map(containerRef.current, {
      center: toNaverLatLng(SEOUL_CENTER),
      zoom: DEFAULT_ZOOM,
      mapTypeControl: false,
      zoomControl: true,
      zoomControlOptions: { position: naver.maps.Position.TOP_LEFT },
    })
    mapRef.current = map
    return () => {
      clearOverlays()
      if (clickListenerRef.current) {
        naver.maps.Event.removeListener(clickListenerRef.current)
        clickListenerRef.current = null
      }
      map.destroy()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function clearOverlays() {
    for (const o of overlaysRef.current) {
      try {
        o.setMap(null)
      } catch {
        /* ignore */
      }
    }
    overlaysRef.current = []
  }

  // Place-mode click
  useEffect(() => {
    const map = mapRef.current
    if (!map || !isNaverMapsReady()) return
    if (clickListenerRef.current) {
      naver.maps.Event.removeListener(clickListenerRef.current)
      clickListenerRef.current = null
    }
    if (!(showPlaceControls && placeMode != null)) {
      map.getElement().classList.remove('placing')
      return
    }
    map.getElement().classList.add('placing')
    clickListenerRef.current = naver.maps.Event.addListener(
      map,
      'click',
      (e) => {
        const role = placeModeRef.current
        if (!role) return
        const coord = e.coord ?? e.latlng
        if (!coord) return
        onMapPlace?.(role, { lat: coord.lat(), lng: coord.lng() })
      },
    )
    return () => {
      if (clickListenerRef.current) {
        naver.maps.Event.removeListener(clickListenerRef.current)
        clickListenerRef.current = null
      }
      map.getElement().classList.remove('placing')
    }
  }, [showPlaceControls, placeMode, onMapPlace])

  // Draw overlays
  useEffect(() => {
    const map = mapRef.current
    if (!map || !isNaverMapsReady()) return
    clearOverlays()

    const addPoly = (
      path: LatLng[],
      color: string,
      weight: number,
      opacity: number,
      zIndex = 100,
    ) => {
      if (path.length < 2) return
      const pl = new naver.maps.Polyline({
        map,
        path: pathToNaver(path),
        strokeColor: color,
        strokeWeight: weight,
        strokeOpacity: opacity,
        strokeLineCap: 'round',
        strokeLineJoin: 'round',
        zIndex,
      })
      overlaysRef.current.push(pl)
    }

    for (const piece of routePieces) {
      addPoly(
        piece,
        routeUnderlayColor,
        useTraffic ? TRAFFIC_WEIGHT : ROUTE_STYLE.weight,
        useTraffic ? 0.75 : ROUTE_STYLE.opacity,
        90,
      )
    }
    for (const { piece } of multiPieces) {
      addPoly(
        piece,
        routeUnderlayColor,
        useTraffic ? TRAFFIC_WEIGHT : ROUTE_STYLE.weight,
        useTraffic ? 0.75 : ROUTE_STYLE.opacity,
        95,
      )
    }
    for (const { piece, sourceLine } of connectorPieces) {
      addPoly(
        piece,
        connectorColor(sourceLine, traffic),
        useTraffic ? TRAFFIC_WEIGHT : ROUTE_STYLE.weight,
        useTraffic ? 0.9 : ROUTE_STYLE.opacity,
        100,
      )
    }
    for (const b of gapBridges) {
      addPoly([b.from, b.to], b.color, TRAFFIC_WEIGHT, 0.9, 105)
    }
    for (const { piece, trafficState } of trafficPieces) {
      addPoly(
        piece,
        trafficStateColor(trafficState),
        TRAFFIC_WEIGHT,
        0.9,
        110,
      )
    }

    markers.forEach((m, i) => {
      const role = roleFromKey(m.key)
      const label = markerLabelForKey(m.key, i)
      const wide = role === 'start' || role === 'end'
      const marker = new naver.maps.Marker({
        map,
        position: toNaverLatLng(m),
        title: m.label,
        zIndex: 600,
        icon: {
          content: badgeHtml(role, label),
          anchor: new naver.maps.Point(wide ? 24 : 13, wide ? 16 : 13),
        } as unknown as object,
      })
      overlaysRef.current.push(marker)
    })

    const compact = visibleStepMarkers.length > 40
    for (const s of visibleStepMarkers) {
      const marker = new naver.maps.Marker({
        map,
        position: new naver.maps.LatLng(s.lat, s.lng),
        title: s.label ? `${s.n}. ${s.label}` : String(s.n),
        zIndex: 500,
        clickable: false,
        icon: {
          content: stepBadgeHtml(s.n, compact),
          anchor: new naver.maps.Point(compact ? 9 : 11, compact ? 9 : 11),
        } as unknown as object,
      })
      overlaysRef.current.push(marker)
    }

    highlights.forEach((h, i) => {
      const circle = new naver.maps.Circle({
        map,
        center: toNaverLatLng(h),
        radius: i === 0 ? 40 : 28,
        strokeColor: i === 0 ? '#f59e0b' : '#38bdf8',
        strokeWeight: 2,
        strokeOpacity: 0.9,
        fillColor: i === 0 ? '#f59e0b' : '#38bdf8',
        fillOpacity: 0.35,
        zIndex: 550,
      })
      overlaysRef.current.push(circle)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    markers,
    route,
    routeLineStrings,
    connectorLineStrings,
    trafficSegments,
    stepMarkers,
    highlights,
  ])

  // Fit bounds
  useEffect(() => {
    const map = mapRef.current
    if (!map || !isNaverMapsReady()) return
    let toFit: LatLng[]
    if (fitRoute.length >= 2) toFit = [...fitRoute, ...fitPoints]
    else if (fitPoints.length >= 2) toFit = fitPoints
    else return
    const bounds = new naver.maps.LatLngBounds(
      toNaverLatLng(toFit[0]!),
      toNaverLatLng(toFit[0]!),
    )
    for (const p of toFit) bounds.extend(toNaverLatLng(p))
    map.fitBounds(bounds, { top: 48, right: 48, bottom: 48, left: 48 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRevision, markers, route, routeLineStrings, trafficSegments])

  // Focus view
  useEffect(() => {
    const map = mapRef.current
    if (!map || !focus?.points?.length || !isNaverMapsReady()) return
    const points = focus.points
    const maxZoom = focus.maxZoom ?? STEP_FOCUS_MAX_ZOOM
    setHighlights(points)

    if (points.length === 1) {
      map.morph(toNaverLatLng(points[0]!), maxZoom, { duration: 600 })
      return
    }
    const bounds = new naver.maps.LatLngBounds(
      toNaverLatLng(points[0]!),
      toNaverLatLng(points[0]!),
    )
    for (const p of points) bounds.extend(toNaverLatLng(p))
    const spanM = haversineMeters(points[0]!, points[points.length - 1]!)
    if (spanM < FOCUS_NEAR_EQUAL_M) {
      map.morph(toNaverLatLng(points[0]!), maxZoom, { duration: 600 })
      return
    }
    map.fitBounds(bounds, { top: 72, right: 72, bottom: 72, left: 72 })
    // Naver fitBounds doesn't take maxZoom; clamp afterward
    window.setTimeout(() => {
      try {
        const z = (map as unknown as { getZoom?: () => number }).getZoom?.()
        if (typeof z === 'number' && z > maxZoom) map.setZoom(maxZoom, true)
      } catch {
        /* ignore */
      }
    }, 100)
  }, [focus])

  useEffect(() => {
    if (!highlights.length) return
    const t = window.setTimeout(() => setHighlights([]), 2200)
    return () => window.clearTimeout(t)
  }, [highlights])

  return (
    <div className="map-canvas naver-map-canvas" ref={containerRef}>
      {showPlaceControls && (
        <div className="naver-place-mode-control leaflet-bar place-mode-control">
          {([
            ['origin', '출발'],
            ['dest', '도착'],
            ['via', '경유지'],
          ] as const).map(([role, label]) => (
            <button
              key={role}
              type="button"
              className={`place-mode-btn${placeMode === role ? ' active' : ''}`}
              aria-pressed={placeMode === role}
              title={`${label} 지도에서 지정`}
              onClick={() =>
                onPlaceModeChange?.(placeMode === role ? null : role)
              }
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

