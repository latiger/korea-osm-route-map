import { useState } from 'react'
import {
  formatDistance,
  formatDuration,
  maneuverSymbol,
} from '../api/osrm'
import type { RouteResult } from '../types'

interface Props {
  route: RouteResult | null
}

export function RouteSummary({ route }: Props) {
  const [open, setOpen] = useState(true)

  if (!route) return null

  const list = route.steps ?? []

  return (
    <div className="route-summary" aria-live="polite">
      <div className="route-summary-totals">
        <span>
          <strong>거리</strong> {formatDistance(route.distanceMeters)}
        </span>
        <span>
          <strong>소요</strong> {formatDuration(route.durationSeconds)}
          {route.fromOfficialGeometry ? ' (approx)' : ''}
        </span>
        {route.fromOfficialGeometry && (
          <span className="hint muted">official centerline geometry</span>
        )}
        {list.length > 0 && (
          <button
            type="button"
            className="route-steps-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '경로 접기' : `경로 ${list.length}단계`}
          </button>
        )}
      </div>

      {open && list.length > 0 && (
        <ol className="route-steps" aria-label="경로 단계">
          {list.map((step, i) => {
            const symbol = maneuverSymbol(step.type, step.modifier)
            const road =
              step.name ||
              (step.type === 'arrive'
                ? '도착지'
                : step.type === 'depart'
                  ? '출발지'
                  : '도로')
            const dist =
              step.distanceMeters > 0
                ? formatDistance(step.distanceMeters)
                : null
            const dur =
              step.durationSeconds >= 1
                ? formatDuration(step.durationSeconds)
                : null
            const meta = [dist, dur].filter(Boolean).join(' · ')

            return (
              <li
                key={`${i}-${step.type}-${step.name}`}
                className="route-step"
              >
                <span className="route-step-symbol" aria-hidden>
                  {symbol}
                </span>
                <div className="route-step-body">
                  <span className="route-step-main">
                    <span className="route-step-label">{step.label}</span>
                    <span className="route-step-sep"> · </span>
                    <span className="route-step-name">{road}</span>
                  </span>
                  {meta ? (
                    <span className="route-step-meta">{meta}</span>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
