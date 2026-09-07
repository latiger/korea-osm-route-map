import type { LatLng, MapFocus, PlaceMode, RouteSegment } from '../types'

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
  /** Kakao/Naver traffic-colored road segments (preferred when present) */
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
