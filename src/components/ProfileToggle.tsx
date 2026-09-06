import type { TravelProfile } from '../types'

interface Props {
  value: TravelProfile
  onChange: (p: TravelProfile) => void
  disabled?: boolean
}

export function ProfileToggle({ value, onChange, disabled }: Props) {
  return (
    <div className="profile-toggle" role="group" aria-label="이동 수단">
      <button
        type="button"
        className={value === 'driving' ? 'active' : ''}
        disabled={disabled}
        onClick={() => onChange('driving')}
      >
        자동차
      </button>
      <button
        type="button"
        className={value === 'walking' ? 'active' : ''}
        disabled={disabled}
        onClick={() => onChange('walking')}
      >
        도보
      </button>
    </div>
  )
}
