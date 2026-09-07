/// <reference types="vite/client" />

/** Injected from NAVER_MAP_CLIENT_ID via vite define (public Maps JS id). */
declare const __NAVER_MAP_CLIENT_ID__: string

interface Window {
  naver?: typeof naver
}

/** Minimal Naver Maps JS typings used by NaverMapCanvas. */
declare namespace naver.maps {
  class Point {
    constructor(x: number, y: number)
    x: number
    y: number
  }
  class LatLng {
    constructor(lat: number, lng: number)
    lat(): number
    lng(): number
  }
  class LatLngBounds {
    constructor(sw?: LatLng, ne?: LatLng)
    extend(latlng: LatLng): LatLngBounds
    isEmpty(): boolean
  }
  class Map {
    constructor(
      el: string | HTMLElement,
      options?: {
        center?: LatLng
        zoom?: number
        mapTypeControl?: boolean
        zoomControl?: boolean
        zoomControlOptions?: { position?: Position }
      },
    )
    setCenter(latlng: LatLng): void
    getZoom(): number
    setZoom(zoom: number, useEffect?: boolean): void
    fitBounds(
      bounds: LatLngBounds,
      margin?: number | { top?: number; right?: number; bottom?: number; left?: number },
    ): void
    morph(latlng: LatLng, zoom?: number, options?: { duration?: number }): void
    getElement(): HTMLElement
    destroy(): void
  }
  class Marker {
    constructor(options: {
      map?: Map | null
      position: LatLng
      title?: string
      icon?: unknown
      zIndex?: number
      clickable?: boolean
    })
    setMap(map: Map | null): void
  }
  class Polyline {
    constructor(options: {
      map?: Map | null
      path: LatLng[]
      strokeColor?: string
      strokeWeight?: number
      strokeOpacity?: number
      strokeLineCap?: string
      strokeLineJoin?: string
      zIndex?: number
    })
    setMap(map: Map | null): void
  }
  class Circle {
    constructor(options: {
      map?: Map | null
      center: LatLng
      radius: number
      strokeColor?: string
      strokeWeight?: number
      strokeOpacity?: number
      fillColor?: string
      fillOpacity?: number
      zIndex?: number
    })
    setMap(map: Map | null): void
  }
  enum Position {
    TOP_LEFT,
    TOP_RIGHT,
    LEFT_TOP,
  }
  namespace Event {
    function addListener(
      target: Map,
      eventName: string,
      listener: (e: { coord?: LatLng; latlng?: LatLng }) => void,
    ): { remove: () => void } | number
    function removeListener(listener: unknown): void
  }
}
