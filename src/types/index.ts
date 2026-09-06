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
  geometry?: LatLng[]
  /** Data provenance for 도로명 mode */
  source?: 'molit' | 'ex' | 'overpass' | 'nominatim'
  /** Official / estimated length in meters when known */
  lengthMeters?: number
  /** EX route number (padded) when from expressway index */
  exRouteNo?: string
  /** When true, geometry/start/end are placeholders — use Overpass */
  needsGeometryFallback?: boolean
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
  coordinates: LatLng[]
  distanceMeters: number
  durationSeconds: number
  steps: RouteStep[]
  /** When drawn from official centerline rather than OSRM */
  fromOfficialGeometry?: boolean
}
