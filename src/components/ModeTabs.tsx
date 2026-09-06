import type { AppMode } from '../types'

const TABS: { id: AppMode; label: string }[] = [
  { id: 'od', label: '출발·도착' },
  { id: 'road', label: '도로명' },
  { id: 'waypoints', label: '점 이어 경로' },
]

interface Props {
  mode: AppMode
  onChange: (m: AppMode) => void
}

export function ModeTabs({ mode, onChange }: Props) {
  return (
    <div className="mode-tabs" role="tablist" aria-label="경로 모드">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={mode === t.id}
          className={mode === t.id ? 'active' : ''}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
