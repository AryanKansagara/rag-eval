import type { Estimate } from './engine/metrics.ts'

/** Vertical bars with labels underneath. */
export function Hist({ bins, label, mark }: { bins: { label: string; n: number }[]; label: string; mark?: string }) {
  const max = Math.max(1, ...bins.map(b => b.n))
  return (
    <div className="hist" role="img" aria-label={label}>
      {bins.map(b => (
        <div key={b.label} className={`bar${b.label === mark ? ' mark' : ''}`} title={`${b.label}: ${b.n}`}>
          <b>{b.n || ''}</b>
          <span style={{ height: `${(b.n / max) * 100}%` }} />
          <small>{b.label}</small>
        </div>
      ))}
    </div>
  )
}

/** A 0-1 track with the mean as a dot and the bootstrap interval as a band. */
export function CiBar({ e, compare }: { e: Estimate; compare?: number }) {
  if (!Number.isFinite(e.mean)) return <span className="muted">—</span>
  const pct = (x: number) => `${Math.max(0, Math.min(1, x)) * 100}%`
  return (
    <span className="ci" aria-label={`${e.mean.toFixed(3)}, 95% CI ${e.lo.toFixed(3)} to ${e.hi.toFixed(3)}`}>
      <span className="ci-band" style={{ left: pct(e.lo), width: `calc(${pct(e.hi)} - ${pct(e.lo)})` }} />
      {compare !== undefined && Number.isFinite(compare) && <i className="ci-cmp" style={{ left: pct(compare) }} />}
      <span className="ci-dot" style={{ left: pct(e.mean) }} />
    </span>
  )
}

/** Semicircle gauge for a 0-1 metric. The arc animates through a CSS transition on stroke-dashoffset. */
export function Dial({ value, label, from }: { value: number; label: string; from?: number }) {
  const r = 52, len = Math.PI * r
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
  const d = from !== undefined ? value - from : 0
  return (
    <figure className="dial" aria-label={`${label} ${value.toFixed(3)}`}>
      <svg viewBox="0 0 128 74" aria-hidden="true">
        <path d="M12 66 A52 52 0 0 1 116 66" className="dial-track" />
        <path d="M12 66 A52 52 0 0 1 116 66" className="dial-arc" style={{ strokeDasharray: len, strokeDashoffset: len * (1 - v) }} />
      </svg>
      <figcaption>
        <b className="tab-nums">{value.toFixed(3)}</b>
        <small>{label}{Math.abs(d) > 0.0005 && <em className={d > 0 ? 'up' : 'down'}> {d > 0 ? '+' : '−'}{Math.abs(d).toFixed(3)}</em>}</small>
      </figcaption>
    </figure>
  )
}

export const Meter = ({ v, tone }: { v: number; tone?: 'bad' | 'good' | 'warn' }) => (
  <span className={`meter ${tone ?? ''}`}><span style={{ width: `${Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)) * 100}%` }} /></span>
)

export const Grade = ({ g }: { g: number }) => <span className={`grade g${g}`} title={`Relevance ${g}`}>{g}</span>
