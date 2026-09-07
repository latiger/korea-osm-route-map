import { formatDistance } from '../api/osrm'
import type { GapBridgeKind, RouteGapInfo } from '../types'

interface Props {
  gaps: RouteGapInfo[]
  onFocusGap?: (gap: RouteGapInfo) => void
  onConnectGap?: (gap: RouteGapInfo) => void
  connectingId?: string | null
  onConnectAllGaps?: () => void
  connectingAll?: boolean
}

const KIND_BADGE: Record<
  GapBridgeKind,
  { text: string; className: string }
> = {
  routed: { text: '연결됨', className: 'gap-badge gap-badge-routed' },
  straight: { text: '점선', className: 'gap-badge gap-badge-straight' },
  skipped: { text: '미연결', className: 'gap-badge gap-badge-skipped' },
  blocked: { text: '연결불가', className: 'gap-badge gap-badge-blocked' },
}

function canConnect(gap: RouteGapInfo): boolean {
  return gap.kind === 'skipped' || gap.kind === 'straight'
}

export function GapList({
  gaps,
  onFocusGap,
  onConnectGap,
  connectingId,
  onConnectAllGaps,
  connectingAll,
}: Props) {
  if (!gaps.length) return null

  const connectable = gaps.filter(canConnect)
  const busy = Boolean(connectingId) || Boolean(connectingAll)

  return (
    <div className="gap-list" aria-label="끊긴 구간">
      <div className="gap-list-header">
        <div className="gap-list-title">끊긴 구간 ({gaps.length})</div>
        {onConnectAllGaps && connectable.length > 1 && (
          <button
            type="button"
            className="gap-connect-all"
            disabled={busy}
            onClick={onConnectAllGaps}
          >
            {connectingAll ? '연결 중…' : '미연결만 일괄 연결'}
          </button>
        )}
      </div>
      <p className="hint muted gap-connect-hint">
        이어서 연결 = 카카오/OSRM 실제 경로
      </p>
      <ul className="gap-list-items">
        {gaps.map((gap) => {
          const badge = KIND_BADGE[gap.kind]
          const clickable = Boolean(onFocusGap)
          const showConnect = Boolean(onConnectGap) && canConnect(gap)
          const connecting = connectingId === gap.id
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
              <div className="gap-list-row-inner">
                {clickable ? (
                  <button
                    type="button"
                    className="gap-list-button"
                    onClick={() => onFocusGap?.(gap)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="gap-list-static">{body}</div>
                )}
                {showConnect && (
                  <button
                    type="button"
                    className="gap-connect-btn"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation()
                      onConnectGap?.(gap)
                    }}
                  >
                    {connecting ? '연결 중…' : '이어서 연결'}
                  </button>
                )}
              </div>
              {gap.rejectReason && (
                <p className="gap-reject-reason" role="status">
                  {gap.rejectReason}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
