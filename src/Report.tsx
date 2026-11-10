import { useEffect, useMemo } from 'react'
import { BUCKETS, bucketCounts, triage } from './engine/analysis.ts'
import { metricLabel } from './engine/metrics.ts'
import { MetricsTable, regression, VerdictBox } from './Compare.tsx'
import { useProject, useWorkspace } from './projectData.ts'
import { Empty, fmt3, fmtPct, Link, SyntheticBadge } from './ui.tsx'

export default function Report({ id }: { id: string }) {
  const { loading, project, ds } = useProject(id)
  const w = useWorkspace(ds, project)
  const r = useMemo(() => project && ds && w && ds.runs.length ? regression(project, ds, w) : null, [project, ds, w])
  useEffect(() => { if (project) document.title = `Regression report · ${project.name}` }, [project?.name])

  if (loading) return <div className="boot"><span className="spinner" /> Building report</div>
  if (!project || !ds || !w || !r) return <section className="page narrow"><Empty title="Nothing to report"><p className="muted">Import at least one run.</p><Link href={`/app/p/${id}`} className="btn primary">Back</Link></Empty></section>

  const s = project.settings
  const d = ds.corpus.length ? w.diag() : null
  const counts = (run: typeof r.base, ev: typeof r.a) => bucketCounts(triage(ev, run.rows, w.ctx, d?.spans ?? [], s.k, s.minGrade))
  const ca = counts(r.base, r.a), cb = counts(r.cand, r.b)
  const losses = r.wl.filter(x => x.delta < -0.05).slice(0, 10)

  return (
    <article className="report">
      <div className="report-actions">
        <Link href={`/app/p/${id}/compare`} className="btn ghost">Back to project</Link>
        <button type="button" className="btn primary" onClick={() => print()}>Print or save PDF</button>
      </div>
      <div className="eyebrow">RAG Eval Desk · regression report</div>
      <h1>{r.cand.name} vs {r.base.name}</h1>
      <p className="muted">{project.name} {project.sampleId && <SyntheticBadge />} · {new Date().toLocaleDateString('en-US', { dateStyle: 'long' })} · {s.level}-level judgments, relevant = grade {s.minGrade}+, triage k = {s.k}</p>

      <VerdictBox r={r} />

      <h2>Metrics</h2>
      <MetricsTable r={r} />
      <p className="muted small">Paired over {r.cmp.shared.length} queries judged in both runs. Delta CI: bootstrap of per-query differences. p-values: paired bootstrap (null-shifted) and sign-flip randomisation, 2,000 iterations each.</p>

      <h2>Failure buckets</h2>
      <table className="compact">
        <thead><tr><th>Bucket</th><th className="num">{r.base.name}</th><th className="num">{r.cand.name}</th></tr></thead>
        <tbody>
          {BUCKETS.filter(b => b.id !== 'ok').map(b => <tr key={b.id}><th scope="row">{b.label}</th><td className="num">{ca[b.id]}</td><td className="num">{cb[b.id]}</td></tr>)}
          <tr><th scope="row">Missed because the answer was cut</th><td className="num">{ca.boundaryCut}</td><td className="num">{cb.boundaryCut}</td></tr>
        </tbody>
      </table>
      {d && Number.isFinite(d.cutRate) && <p className="small">Corpus boundary-cut rate: <b>{fmtPct(d.cutRate, 1)}</b> of gold spans are split across chunks.</p>}

      <h2>Largest per-query regressions</h2>
      {losses.length ? (
        <table className="compact">
          <thead><tr><th>Query</th><th className="num">{metricLabel('ndcg@10')} before</th><th className="num">after</th></tr></thead>
          <tbody>{losses.map(x => <tr key={x.queryId}><th scope="row">{w.queries.get(x.queryId)?.text ?? x.queryId} <span className="muted tiny mono">{x.queryId}</span></th><td className="num">{fmt3(x.a)}</td><td className="num error">{fmt3(x.b)}</td></tr>)}</tbody>
        </table>
      ) : <p className="muted">No query lost more than 0.05 nDCG@10.</p>}

      <h2>Thresholds</h2>
      <ul className="small">{s.thresholds.map((t, i) => <li key={i}>{metricLabel(t.metric)}: {t.min !== undefined ? `floor ${t.min}` : 'no floor'}{t.maxDrop !== undefined ? `, max drop ${t.maxDrop} (blocks only if p < ${s.alpha})` : ''}</li>)}</ul>
      <p className="muted small">Generated in the browser from logged retrieval runs; no LLM judge involved. Metrics: Recall, Precision, Hit and nDCG at k (gain 2^grade − 1), MRR, MAP.</p>
    </article>
  )
}
