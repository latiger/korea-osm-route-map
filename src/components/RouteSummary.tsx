import { useState } from 'react'
import {
  formatDistance,
  formatDuration,
  maneuverSymbol,
} from '../api/osrm'
import { significantDisplaySteps } from '../api/displaySteps'
import type { LatLng, RouteResult } from '../types'

interface Props {
  route: RouteResult | null
  onStepClick?: (ll: LatLng) => void
}

/** Kakao Navi numeric OD types — do not map display name to 출발지/도착지. */
function isKakaoOdEndpointType(type: string | undefined): boolean {
  const t = (type ?? '').toLowerCase()
  return t === '100' || t === '101' || t === '1000'
}

function isOdEndpointDisplayText(text: string | undefined): boolean {
  const s = (text ?? '').trim()
  if (!s) return false
  if (/출발지|목적지|도착지/.test(s)) return true
  if (s === '출발' || s === '도착') return true
  return false
}

export function RouteSummary({ route, onStepClick }: Props) {
  const [open, setOpen] = useState(true)

  if (!route) return null

  const list = significantDisplaySteps(route.steps)

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
        {route.source === 'kakao' && (
          <span className="hint muted">교통 반영 (카카오내비)</span>
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
          {list.map((step) => {
            const symbol = maneuverSymbol(step.type, step.modifier)
            const rawName = (step.name ?? '').trim()
            // Prefer filtering OD at source; if type 100/101 leaks through, never
            // show 출발지/목적지 as the road name.
            const name =
              rawName &&
              !(isKakaoOdEndpointType(step.type) && isOdEndpointDisplayText(rawName))
                ? rawName
                : ''
            const road =
              name ||
              (step.type === 'arrive'
                ? '도착지'
                : step.type === 'depart'
                  ? '출발지'
                  : step.type === 'connect'
                    ? '연결 구간'
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
            const loc = step.location
            const clickable = Boolean(loc && onStepClick)

            const body = (
              <>
                <span className="route-step-num" aria-hidden>
                  {step.n}
                </span>
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
              </>
            )

            return (
              <li
                key={`${step.n}-${step.type}-${step.name}`}
                className="route-step"
              >
                {clickable && loc ? (
                  <button
                    type="button"
                    className="route-step-button"
                    onClick={() => onStepClick?.(loc)}
                  >
                    {body}
                  </button>
                ) : (
                  body
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
