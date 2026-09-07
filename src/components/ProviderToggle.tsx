import type { RoutingProvider } from '../types'

interface Props {
  value: RoutingProvider
  onChange: (p: RoutingProvider) => void
  disabled?: boolean
}

const OPTIONS: Array<{ id: RoutingProvider; label: string }> = [
  { id: 'kakao', label: '카카오' },
  { id: 'naver', label: '네이버' },
  { id: 'auto', label: '자동' },
]

export function ProviderToggle({ value, onChange, disabled }: Props) {
  return (
    <div className="provider-toggle" role="group" aria-label="길찾기 제공자">
      <span className="provider-toggle-label">길찾기</span>
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          className={value === o.id ? 'active' : ''}
          disabled={disabled}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
