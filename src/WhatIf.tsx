import { useMemo, useState } from 'react'
import { hasRerank, WHATIF_LABEL, type WhatIf } from './engine/analysis.ts'
import { compareEvals, firstRelevant, METRICS, metricLabel } from './engine/metrics.ts'
import type { TabProps } from './Project.tsx'
import { pickRuns } from './projectData.ts'
import { fmt3, Link } from './ui.tsx'

const MODES: WhatIf[] = ['rerank', 'bm25-rerank', 'bm25', 'hybrid']
const BLURB: Record<WhatIf, string> = {
  baseline: '',
  rerank: 'Reorders each logged list by the rerank_score you logged (for example from a Cohere Rerank call). Same candidates, new order.',
  'bm25-rerank': 'Reorders each logged list by a BM25 score computed here over your corpus. A cheap lexical second stage.',
  bm25: 'Ignores the logged ranking and retrieves with BM25 over the whole corpus, at the same depth.',
  hybrid: 'Fuses the logged ranking with BM25 over the corpus using reciprocal rank fusion (k = 60), at the same depth.',
}

export default function WhatIfTab({ project, ds, w }: TabProps) {
  const { cand } = pickRuns(ds, project.settings)
  const canRerank = hasRerank(cand.rows)
  const canBm = ds.corpus.length > 0
  const avail = (m: WhatIf) => m === 'rerank' ? canRerank : canBm
  const [focus, setFocus] = useState<WhatIf>(() => MODES.find(avail) ?? 'rerank')
  const base = w.evalRun(cand)
  const results = useMemo(() => MODES.filter(avail).map(m => { const ev = w.evalRun(cand, m); return { m, ev, cmp: compareEvals(base, ev) } }), [cand, w, base, canRerank, canBm])
  const cur = results.find(r => r.m === focus) ?? results[0]
  const moves = useMemo(() => {
    if (!cur) return []
    const by = new Map(cur.ev.scored.map(q => [q.queryId, q]))
    return base.scored.filter(q => by.has(q.queryId)).map(q => ({ id: q.queryId, from: firstRelevant(q.judged, project.settings.minGrade), to: firstRelevant(by.get(q.queryId)!.judged, project.settings.minGrade), d: by.get(q.queryId)!.scores['ndcg@10'] - q.scores['ndcg@10'] }))
      .filter(x => x.from !== x.to).sort((a, b) => b.d - a.d)
  }, [cur, base, project.settings.minGrade])

  if (!results.length) return (
    <div className="panel"><h2>Nothing to simulate yet</h2><p className="muted">Log a <code>rerank_score</code> per retrieved chunk to test reranking, or import the corpus to test BM25 and hybrid fusion locally. <Link href="/docs#logging">Logging snippets</Link>.</p></div>
  )
  const rank = (n: number) => n ? `#${n}` : 'not retrieved'

  return (
    <>
      <p className="muted">What would <strong>{cand.name}</strong> score with a second stage? Every row below re-runs the full evaluation on the transformed lists, with a paired test against the run as logged.</p>
      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Variant</th>{METRICS.map(m => <th key={m} className="num">{metricLabel(m)}</th>)}</tr></thead>
            <tbody>
              <tr><th scope="row">{WHATIF_LABEL.baseline}</th>{METRICS.map(m => <td key={m} className="num">{fmt3(base.agg[m].mean)}</td>)}</tr>
              {results.map(r => (
                <tr key={r.m} className={`click${r.m === cur?.m ? ' current' : ''}`} onClick={() => setFocus(r.m)}>
                  <th scope="row"><button type="button" className="linkish left">{WHATIF_LABEL[r.m]}</button></th>
                  {METRICS.map(m => {
                    const t = r.cmp.tests[m], p = t.pRandom
                    return <td key={m} className="num">{fmt3(r.ev.agg[m].mean)}<div className={`tiny ${t.delta > 0.0005 ? 'good-text' : t.delta < -0.0005 ? 'error' : 'muted'}`}>{t.delta >= 0 ? '+' : '−'}{Math.abs(t.delta).toFixed(3)}{p < 0.05 ? ' *' : ''}</div></td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small" style={{ margin: '10px 0 0' }}>* p &lt; 0.05 on a paired sign-flip randomisation test over queries. {!canRerank && 'No rerank scores in this run, so the logged-rerank row is hidden. '}{!canBm && 'Import the corpus to unlock BM25 and hybrid.'}</p>
      </div>

      {cur && (
        <div className="panel">
          <div className="panel-head"><h2>{WHATIF_LABEL[cur.m]}: what moved</h2><span className="muted small">{cur.cmp.tests['ndcg@10'].wins} queries better · {cur.cmp.tests['ndcg@10'].losses} worse · {cur.cmp.tests['ndcg@10'].ties} unchanged</span></div>
          <p className="small muted">{BLURB[cur.m]}</p>
          <div className="moves">
            {moves.slice(0, 12).map(x => (
              <div key={x.id} className={`move ${x.d >= 0 ? 'up' : 'down'}`}>
                <span className="mv-q">{w.queries.get(x.id)?.text ?? x.id}</span>
                <span className="mv-r">{rank(x.from)} <span aria-hidden="true">&rarr;</span> {rank(x.to)}</span>
                <span className="mv-d tab-nums">{x.d >= 0 ? '+' : '−'}{Math.abs(x.d).toFixed(2)}</span>
              </div>
            ))}
            {moves.length > 12 && <p className="muted small">and {moves.length - 12} more. Biggest gains first; the worst losses are at the end of the list.</p>}
            {moves.filter(x => x.d < 0).slice(-4).reverse().map(x => (
              <div key={'l' + x.id} className="move down">
                <span className="mv-q">{w.queries.get(x.id)?.text ?? x.id}</span>
                <span className="mv-r">{rank(x.from)} <span aria-hidden="true">&rarr;</span> {rank(x.to)}</span>
                <span className="mv-d tab-nums">−{Math.abs(x.d).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
