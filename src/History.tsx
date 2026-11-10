import { useState } from 'react'
import { BUCKETS } from './engine/analysis.ts'
import { METRICS, metricLabel } from './engine/metrics.ts'
import type { TabProps } from './Project.tsx'
import { deleteSnapshotCloud } from './sync.ts'
import { Empty, fmt3, fmtPct, toast } from './ui.tsx'

export default function History({ project, w, update }: TabProps) {
  const snaps = [...project.snapshots].sort((a, b) => a.at - b.at)
  const [aId, setA] = useState(snaps.at(-2)?.id ?? '')
  const [bId, setB] = useState(snaps.at(-1)?.id ?? '')
  const a = snaps.find(s => s.id === aId) ?? snaps.at(-2)
  const b = snaps.find(s => s.id === bId) ?? snaps.at(-1)

  if (!snaps.length) return <Empty title="No snapshots yet"><p className="muted">Press <kbd>S</kbd> or the Snapshot button to freeze the run under study: every metric with its CI, the failure buckets and the per-query scores. Take one per pipeline version or per month.</p></Empty>

  const del = (id: string) => {
    const before = project.snapshots
    void update({ snapshots: before.filter(s => s.id !== id) })
    void deleteSnapshotCloud(id)
    toast('Snapshot deleted', { undo: () => void update({ snapshots: before }) })
  }

  const changed = a && b ? Object.keys(b.perQuery).filter(q => q in a.perQuery).map(q => ({ q, d: b.perQuery[q] - a.perQuery[q] })).filter(x => Math.abs(x.d) >= 0.1).sort((x, y) => x.d - y.d) : []

  return (
    <>
      <div className="panel">
        <div className="panel-head"><h2>Snapshots</h2><span className="muted small">{snaps.length} saved · synced with the project</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Snapshot</th><th>Level / k</th><th className="num">Queries</th>{METRICS.slice(0, 4).map(m => <th key={m} className="num">{metricLabel(m)}</th>)}<th className="num">Cut rate</th><th /></tr></thead>
            <tbody>{snaps.map(s => (
              <tr key={s.id}>
                <th scope="row">{s.label}<div className="muted tiny">{new Date(s.at).toLocaleString()}</div></th>
                <td className="small">{s.level} · {s.k}</td>
                <td className="num">{s.queries}</td>
                {METRICS.slice(0, 4).map(m => <td key={m} className="num">{fmt3(s.metrics[m]?.mean)}</td>)}
                <td className="num">{Number.isFinite(s.cutRate) ? fmtPct(s.cutRate, 1) : '—'}</td>
                <td><button type="button" className="btn danger-ghost sm" onClick={() => del(s.id)}>Delete</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
      {snaps.length > 1 && a && b && (
        <div className="panel">
          <div className="panel-head">
            <h2>Compare snapshots</h2>
            <div className="row gap-sm wrap">
              <select value={a.id} onChange={e => setA(e.target.value)} aria-label="Earlier snapshot">{snaps.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
              <span aria-hidden="true">&rarr;</span>
              <select value={b.id} onChange={e => setB(e.target.value)} aria-label="Later snapshot">{snaps.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
            </div>
          </div>
          {(a.level !== b.level || a.k !== b.k) && <div className="banner warn"><span>These snapshots used different settings ({a.level}/k={a.k} vs {b.level}/k={b.k}), so differences mix pipeline and settings changes.</span></div>}
          <div className="grid-2">
            <table className="compact">
              <thead><tr><th>Metric</th><th className="num">Before</th><th className="num">After</th><th className="num">Change</th></tr></thead>
              <tbody>{METRICS.map(m => { const d = (b.metrics[m]?.mean ?? NaN) - (a.metrics[m]?.mean ?? NaN); return <tr key={m}><th scope="row">{metricLabel(m)}</th><td className="num">{fmt3(a.metrics[m]?.mean)}</td><td className="num">{fmt3(b.metrics[m]?.mean)}</td><td className={`num ${d > 0.0005 ? 'good-text' : d < -0.0005 ? 'error' : 'muted'}`}>{Number.isFinite(d) ? (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(3) : '—'}</td></tr> })}</tbody>
            </table>
            <table className="compact">
              <thead><tr><th>Bucket</th><th className="num">Before</th><th className="num">After</th></tr></thead>
              <tbody>{BUCKETS.map(x => <tr key={x.id}><th scope="row">{x.label}</th><td className="num">{a.buckets[x.id] ?? 0}</td><td className="num">{b.buckets[x.id] ?? 0}</td></tr>)}
                <tr><th scope="row">Missed because cut</th><td className="num">{a.buckets.boundaryCut ?? 0}</td><td className="num">{b.buckets.boundaryCut ?? 0}</td></tr></tbody>
            </table>
          </div>
          <h3 style={{ marginTop: 18 }}>Queries that moved by 0.1 nDCG@10 or more <span className="muted small">{changed.length}</span></h3>
          <ul className="wl">{changed.slice(0, 20).map(x => <li key={x.q}><span>{w.queries.get(x.q)?.text ?? x.q}</span><b className={`tab-nums ${x.d > 0 ? 'good-text' : 'error'}`}>{x.d > 0 ? '+' : '−'}{Math.abs(x.d).toFixed(2)}</b></li>)}{!changed.length && <li className="muted">None</li>}</ul>
        </div>
      )}
    </>
  )
}
