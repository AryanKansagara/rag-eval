import { useMemo, useState } from 'react'
import { CiBar, Meter } from './charts.tsx'
import { slices } from './engine/analysis.ts'
import { METRICS, metricLabel } from './engine/metrics.ts'
import type { TabProps } from './Project.tsx'
import { pickRuns } from './projectData.ts'
import { fmt3, Link } from './ui.tsx'

const LEVEL_NOTE = {
  chunk: 'Chunk level: a retrieved chunk earns the grade its id (or its doc, for doc-keyed qrels) was given. Each judgment is credited once.',
  doc: 'Doc level: retrieved chunks collapse to their documents (first hit wins) and each doc takes its best grade.',
  span: 'Gold span level: a chunk is graded by how much of the gold answer span its offsets cover (all 3, half or more 2, any 1).',
}

export default function Overview({ project, ds, w }: TabProps) {
  const { cand } = pickRuns(ds, project.settings)
  const ev = w.evalRun(cand)
  const [metric, setMetric] = useState('ndcg@10')
  const all = useMemo(() => ds.runs.map(r => ({ r, ev: w.evalRun(r) })), [ds, w])
  const sl = useMemo(() => slices(ev, w.queries, metric, cand.rows), [ev, w, metric, cand])
  const best = (m: string) => Math.max(...all.map(x => x.ev.agg[m]?.mean ?? -1))

  return (
    <>
      {ev.unlabelled.length > 0 && (
        <div className="banner"><span><strong>{ev.unlabelled.length} queries in this run have no judgments</strong>, so they are left out of every metric.</span><Link href={`/app/p/${project.id}/label`} className="btn primary sm">Label them</Link></div>
      )}
      <div className="kpis kpis-7">
        {METRICS.map(m => {
          const e = ev.agg[m]
          return (
            <div key={m} className="kpi">
              <small>{metricLabel(m)}</small>
              <b>{fmt3(e.mean)}</b>
              <CiBar e={e} />
              <p>95% CI {fmt3(e.lo)} to {fmt3(e.hi)}</p>
            </div>
          )
        })}
      </div>
      <p className="muted small">{LEVEL_NOTE[project.settings.level]} Means over {ev.scored.length} queries with at least one relevant item (grade {project.settings.minGrade}+); {ev.noGold.length} labelled queries have no gold and {ev.unlabelled.length} are unlabelled. Intervals: percentile bootstrap over queries.</p>

      <div className="panel">
        <div className="panel-head"><h2>Runs</h2><span className="muted small">Best value per metric in bold</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Run</th><th className="num">Queries</th>{METRICS.map(m => <th key={m} className="num">{metricLabel(m)}</th>)}</tr></thead>
            <tbody>{all.map(({ r, ev: e }) => (
              <tr key={r.id} className={r.id === cand.id ? 'current' : ''}>
                <th scope="row">{r.name}{r.notes && <div className="muted tiny">{r.notes}</div>}</th>
                <td className="num">{e.scored.length}</td>
                {METRICS.map(m => <td key={m} className="num">{e.agg[m].mean === best(m) && all.length > 1 ? <b>{fmt3(e.agg[m].mean)}</b> : fmt3(e.agg[m].mean)}<div className="muted tiny">±{fmt3((e.agg[m].hi - e.agg[m].lo) / 2)}</div></td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>
        {all.length > 1 && <p className="small" style={{ margin: '12px 0 0' }}>Is the difference real? <Link href={`/app/p/${project.id}/compare`}>Run the paired significance test</Link>.</p>}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Slices</h2>
          <label className="row gap-sm small">Metric <select value={metric} onChange={e => setMetric(e.target.value)}>{METRICS.map(m => <option key={m} value={m}>{metricLabel(m)}</option>)}</select></label>
        </div>
        {sl.length === 0 ? <p className="muted">No scored queries yet.</p> : (
          <div className="slices">
            {(['intent', 'tag', 'length'] as const).map(dim => {
              const rows = sl.filter(s => s.dim === dim)
              if (!rows.length) return null
              return (
                <div key={dim}>
                  <h3 className="small-h">{dim === 'tag' ? 'Tag' : dim === 'intent' ? 'Intent' : 'Query length'}</h3>
                  <table className="compact">
                    <tbody>{rows.map(s => (
                      <tr key={s.value}><th scope="row">{s.value}</th><td className="num muted">{s.n}</td><td style={{ width: '45%' }}><Meter v={s.mean} tone={s.mean < ev.agg[metric].mean - 0.1 ? 'bad' : undefined} /></td><td className="num">{fmt3(s.mean)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )
            })}
          </div>
        )}
        <p className="muted small" style={{ margin: '10px 0 0' }}>Slices more than 0.1 under the overall mean are flagged. Tags and intent come from your queries file.</p>
      </div>
    </>
  )
}
