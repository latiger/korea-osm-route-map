import { formatDistance, formatDuration } from '../api/osrm'
import type { RouteResult } from '../types'

interface Props {
  route: RouteResult | null
}

export function RouteSummary({ route }: Props) {
  if (!route) return null
  return (
    <div className="route-summary" aria-live="polite">
      <span>
        <strong>거리</strong> {formatDistance(route.distanceMeters)}
      </span>
      <span>
        <strong>소요</strong> {formatDuration(route.durationSeconds)}
      </span>
    </div>
  )
}
