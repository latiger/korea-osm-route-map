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
}
