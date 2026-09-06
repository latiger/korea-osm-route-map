export type TravelProfile = 'driving' | 'walking'
export type AppMode = 'od' | 'road' | 'waypoints'

export interface LatLng {
  lat: number
  lng: number
}

export interface GeocodeResult {
  id: string
  label: string
  lat: number
  lng: number
  type?: string
}

export interface RoadMatch {
  id: string
  name: string
  label: string
  start: LatLng
  end: LatLng
  /** Single continuous path (legacy / OSRM / longest official segment) */
  geometry?: LatLng[]
  /**
   * Preferred for official MultiLineString roads: each entry is one polyline.
   * Draw these separately — do not concatenate (creates jumper spaghetti).
   */
  lineStrings?: LatLng[][]
  /** Data provenance for 도로명 mode */
  source?: 'molit' | 'ex' | 'overpass' | 'nominatim'
  /** Official / estimated length in meters when known */
  lengthMeters?: number
  /** EX route number (padded) when from expressway index */
  exRouteNo?: string
  /** When true, geometry/start/end are placeholders — use Overpass */
  needsGeometryFallback?: boolean
  /** Managing agencies from MOLIT when available */
  agencies?: string[]
}

export interface RouteStep {
  /** OSRM maneuver.type */
  type: string
  /** OSRM maneuver.modifier (left, right, straight, …) */
  modifier?: string
  /** Korean label for the maneuver */
  label: string
  /** Road / street name from OSRM (may be English) */
  name: string
  distanceMeters: number
  durationSeconds: number
  location?: LatLng
}

export interface RouteResult {
  /**
   * Single path for markers / FitBounds fallback / OSRM routes.
   * For official MultiLineString, prefer `lineStrings` for drawing.
   */
  coordinates?: LatLng[]
  /**
   * Preferred drawing path for official roads: one Polyline per entry.
   */
  lineStrings?: LatLng[][]
  distanceMeters: number
  durationSeconds: number
  steps: RouteStep[]
  /** When drawn from official centerline rather than OSRM */
  fromOfficialGeometry?: boolean
  /** Kakao Navi per-road segments colored by traffic_state */
  trafficSegments?: RouteSegment[]
  /** Routing / geometry provenance */
  source?: 'kakao' | 'osrm' | 'official'
}

export type TrafficState = 0 | 1 | 2 | 3 | 4 | 6

export interface RouteSegment {
  coordinates: LatLng[]
  trafficState: number
  trafficSpeed?: number
  name?: string
}
