import { formatDistance } from '../api/osrm'
import type { GapBridgeKind, LatLng, RouteGapInfo } from '../types'

interface Props {
  gaps: RouteGapInfo[]
  onFocusLocation?: (ll: LatLng) => void
}

const KIND_BADGE: Record<
  GapBridgeKind,
  { text: string; className: string }
> = {
  routed: { text: '연결됨', className: 'gap-badge gap-badge-routed' },
  straight: { text: '점선', className: 'gap-badge gap-badge-straight' },
  skipped: { text: '미연결', className: 'gap-badge gap-badge-skipped' },
}

function gapFocusPoint(gap: RouteGapInfo): LatLng {
  return {
    lat: (gap.from.lat + gap.to.lat) / 2,
    lng: (gap.from.lng + gap.to.lng) / 2,
  }
}

export function GapList({ gaps, onFocusLocation }: Props) {
  if (!gaps.length) return null

  return (
    <div className="gap-list" aria-label="끊긴 구간">
      <div className="gap-list-title">끊긴 구간 ({gaps.length})</div>
      <ul className="gap-list-items">
        {gaps.map((gap) => {
          const badge = KIND_BADGE[gap.kind]
          const focus = gapFocusPoint(gap)
          const clickable = Boolean(onFocusLocation)
          const body = (
            <>
              <span className={badge.className}>{badge.text}</span>
              <span className="gap-list-label">{gap.label}</span>
              <span className="gap-list-dist">
                {formatDistance(gap.gapMeters)}
              </span>
            </>
          )
          return (
            <li key={gap.id} className="gap-list-row">
              {clickable ? (
                <button
                  type="button"
                  className="gap-list-button"
                  onClick={() => onFocusLocation?.(focus)}
                >
                  {body}
                </button>
              ) : (
                <div className="gap-list-static">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
