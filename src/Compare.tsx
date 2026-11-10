import { useMemo } from 'react'
import { CI_SCRIPT, DEFAULT_THRESHOLDS, gateConfig, metricsExport, verdict, type Threshold } from './engine/analysis.ts'
import { compareEvals, METRICS, metricLabel, winsLosses } from './engine/metrics.ts'
import type { Dataset } from './engine/types.ts'
import type { TabProps } from './Project.tsx'
import { pickRuns, type Workspace } from './projectData.ts'
import type { Project } from './store.ts'
import { Code, download, fmt3, Link } from './ui.tsx'

export function regression(project: Project, ds: Dataset, w: Workspace) {
  const { base, cand } = pickRuns(ds, project.settings)
  const a = w.evalRun(base), b = w.evalRun(cand)
  const cmp = compareEvals(a, b)
  const v = verdict(a, b, project.settings.thresholds, { alpha: project.settings.alpha })
  const wl = winsLosses(a, b, 'ndcg@10')
  return { base, cand, a, b, cmp, v, wl }
}

export const pFmt = (p: number) => p < 0.001 ? '<0.001' : p.toFixed(3)

export function MetricsTable({ r }: { r: ReturnType<typeof regression> }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Metric</th><th className="num">{r.base.name}</th><th className="num">{r.cand.name}</th><th className="num">Delta</th><th className="num">95% CI of delta</th><th className="num">p (bootstrap)</th><th className="num">p (randomisation)</th><th className="num">W / L / T</th></tr></thead>
        <tbody>{METRICS.map(m => {
          const t = r.cmp.tests[m]
          const sig = t.pRandom < 0.05 && t.pBootstrap < 0.05
          return (
            <tr key={m}>
              <th scope="row">{metricLabel(m)}</th>
              <td className="num">{fmt3(r.a.agg[m].mean)}</td>
              <td className="num">{fmt3(r.b.agg[m].mean)}</td>
              <td className={`num ${sig ? t.delta > 0 ? 'good-text' : 'error' : ''}`}><b>{t.delta >= 0 ? '+' : '−'}{Math.abs(t.delta).toFixed(3)}</b></td>
              <td className="num muted">{fmt3(t.lo)} to {fmt3(t.hi)}</td>
              <td className="num">{pFmt(t.pBootstrap)}</td>
              <td className="num">{pFmt(t.pRandom)}</td>
              <td className="num muted">{t.wins} / {t.losses} / {t.ties}</td>
            </tr>
          )
        })}</tbody>
      </table>
    </div>
  )
}

export function VerdictBox({ r }: { r: ReturnType<typeof regression> }) {
  return (
    <div className={`verdict ${r.v.ship ? 'ship' : 'block'}`}>
      <div className="verdict-head"><span className="verdict-mark" aria-hidden="true">{r.v.ship ? '✓' : '×'}</span><div><b>{r.v.ship ? 'Ship' : 'No ship'}</b><small>{r.cand.name} vs {r.base.name} · {r.v.shared} shared queries</small></div></div>
      <ul>{r.v.checks.map((c, i) => <li key={i} className={c.pass ? '' : 'fail'}><b>{metricLabel(c.metric)}</b> {fmt3(c.base)} → {fmt3(c.value)}: {c.reason}</li>)}</ul>
    </div>
  )
}

export default function Compare({ project, ds, w, setSettings }: TabProps) {
  const r = useMemo(() => regression(project, ds, w), [project, ds, w])
  const th = project.settings.thresholds
  const setTh = (i: number, p: Partial<Threshold>) => setSettings({ thresholds: th.map((t, j) => j === i ? { ...t, ...p } : t) })
  const numOrU = (s: string) => s.trim() === '' ? undefined : Number(s)
  const queryText = (id: string) => w.queries.get(id)?.text ?? id

  if (ds.runs.length < 2) return <div className="panel"><h2>Import a second run to compare</h2><p className="muted">Log the same queries against your new pipeline version (new chunker, embedder, reranker, k) and import it on the <Link href={`/app/p/${project.id}/data`}>Data</Link> tab.</p></div>

  const gate = JSON.stringify(gateConfig(th, project.settings.alpha), null, 2)
  return (
    <>
      <div className="panel">
        <div className="row gap wrap">
          <label className="field inline"><span>Baseline</span><select value={r.base.id} onChange={e => setSettings({ baseRunId: e.target.value })}>{ds.runs.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          <label className="field inline"><span>Candidate</span><select value={r.cand.id} onChange={e => setSettings({ candRunId: e.target.value })}>{ds.runs.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          <button type="button" className="btn ghost sm" onClick={() => setSettings({ baseRunId: r.cand.id, candRunId: r.base.id })}>Swap</button>
          <span className="grow" />
          <Link href={`/app/p/${project.id}/report`} className="btn primary">Printable report</Link>
        </div>
        <MetricsTable r={r} />
        <p className="muted small" style={{ margin: '10px 0 0' }}>Both tests pair queries by id and resample per-query differences (2,000 iterations, seeded). Coloured deltas are significant at p &lt; 0.05 on both.</p>
      </div>

      <div className="grid-2">
        <div className="panel">
          <h2>Verdict</h2>
          <VerdictBox r={r} />
          <h3 style={{ marginTop: 18 }}>Thresholds</h3>
          <table className="compact th-edit">
            <thead><tr><th>Metric</th><th>Floor</th><th>Max drop</th><th /></tr></thead>
            <tbody>{th.map((t, i) => (
              <tr key={i}>
                <td><select value={t.metric} onChange={e => setTh(i, { metric: e.target.value })} aria-label="Metric">{METRICS.map(m => <option key={m} value={m}>{metricLabel(m)}</option>)}</select></td>
                <td><input type="number" step="0.01" min="0" max="1" value={t.min ?? ''} placeholder="none" onChange={e => setTh(i, { min: numOrU(e.target.value) })} aria-label={`Floor for ${metricLabel(t.metric)}`} /></td>
                <td><input type="number" step="0.005" min="0" max="1" value={t.maxDrop ?? ''} placeholder="none" onChange={e => setTh(i, { maxDrop: numOrU(e.target.value) })} aria-label={`Max drop for ${metricLabel(t.metric)}`} /></td>
                <td><button type="button" className="icon-btn" aria-label="Remove threshold" onClick={() => setSettings({ thresholds: th.filter((_, j) => j !== i) })}>&times;</button></td>
              </tr>
            ))}</tbody>
          </table>
          <div className="row gap-sm wrap" style={{ marginTop: 10 }}>
            <button type="button" className="btn ghost sm" onClick={() => setSettings({ thresholds: [...th, { metric: 'recall@10', maxDrop: 0.02 }] })}>Add threshold</button>
            <button type="button" className="btn ghost sm" onClick={() => setSettings({ thresholds: DEFAULT_THRESHOLDS.map(t => ({ ...t })) })}>Reset</button>
            <label className="row gap-sm small">alpha <input type="number" step="0.01" min="0.001" max="0.5" value={project.settings.alpha} onChange={e => setSettings({ alpha: Number(e.target.value) || 0.05 })} style={{ width: 80 }} /></label>
          </div>
          <p className="muted small">A drop past "max drop" only blocks when it is significant at alpha; a floor always blocks.</p>
        </div>
        <div className="panel">
          <h2>Biggest per-query changes</h2>
          <h3 className="small-h">Losses (nDCG@10)</h3>
          <ul className="wl">{r.wl.filter(x => x.delta < 0).slice(0, 6).map(x => <li key={x.queryId}><span>{queryText(x.queryId)}</span><b className="error tab-nums">−{Math.abs(x.delta).toFixed(2)}</b></li>)}{!r.wl.some(x => x.delta < 0) && <li className="muted">None</li>}</ul>
          <h3 className="small-h">Wins</h3>
          <ul className="wl">{r.wl.filter(x => x.delta > 0).reverse().slice(0, 6).map(x => <li key={x.queryId}><span>{queryText(x.queryId)}</span><b className="good-text tab-nums">+{x.delta.toFixed(2)}</b></li>)}{!r.wl.some(x => x.delta > 0) && <li className="muted">None</li>}</ul>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>CI gate</h2><span className="muted small">Run the same check in your pipeline, no dependencies</span></div>
        <ol className="steps-list">
          <li>Commit the thresholds file and the script to your repo.</li>
          <li>In CI, export per-query metrics for the baseline and the candidate in the JSON shape below (or download them here).</li>
          <li>Run <code>node rag-gate.mjs rag-thresholds.json baseline.json candidate.json</code>. It exits 1 on no-ship.</li>
        </ol>
        <div className="row gap-sm wrap">
          <button type="button" className="btn outline sm" onClick={() => download('rag-thresholds.json', gate, 'application/json')}>rag-thresholds.json</button>
          <button type="button" className="btn outline sm" onClick={() => download('rag-gate.mjs', CI_SCRIPT, 'text/javascript')}>rag-gate.mjs</button>
          <button type="button" className="btn outline sm" onClick={() => download('baseline.json', JSON.stringify(metricsExport(r.base.name, r.a, METRICS), null, 1), 'application/json')}>baseline.json</button>
          <button type="button" className="btn outline sm" onClick={() => download('candidate.json', JSON.stringify(metricsExport(r.cand.name, r.b, METRICS), null, 1), 'application/json')}>candidate.json</button>
        </div>
        <Code code={gate} label="rag-thresholds.json" />
        <Code code={CI_SCRIPT} label="rag-gate.mjs" />
        <Code code={`{ "run": "v2", "queries": 75,\n  "metrics": { "ndcg@10": 0.7131, "recall@5": 0.6489 },\n  "perQuery": { "ndcg@10": { "q001": 1, "q002": 0.6309 } } }`} label="metrics JSON shape" />
      </div>
    </>
  )
}
