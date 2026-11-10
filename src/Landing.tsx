import { useEffect, useMemo, useState } from 'react'
import { Dial } from './charts.tsx'
import { applyWhatIf } from './engine/analysis.ts'
import { evaluateRows, firstRelevant, judge, makeCtx } from './engine/metrics.ts'
import { buildSample } from './engine/sample.ts'
import { Link } from './ui.tsx'

const ROW = 46, SHOW = 8, K = 5

/** Everything here runs on the real engine over the synthetic sample: judging, metrics, RRF fusion and rerank ordering. */
function useHeroModel() {
  return useMemo(() => {
    const { ds } = buildSample()
    const ctx = makeCtx(ds, 'chunk')
    const [dense, hybrid] = ds.runs
    const configs = {
      base: dense.rows,
      hybrid: hybrid.rows,
      rerank: applyWhatIf('rerank', dense.rows),
      both: applyWhatIf('rerank', hybrid.rows),
    }
    const evals = Object.fromEntries(Object.entries(configs).map(([k, rows]) => [k, evaluateRows(ctx, rows, ['ndcg@10', 'recall@5'], 1, 50)])) as Record<keyof typeof configs, ReturnType<typeof evaluateRows>>
    // The query where the gold chunk climbs furthest: low in dense, top with hybrid + rerank.
    const rank = (k: keyof typeof configs, qid: string) => { const q = evals[k].scored.find(x => x.queryId === qid); return q ? firstRelevant(q.judged) || 99 : 99 }
    const pickQ = evals.base.scored
      .map(q => q.queryId)
      .filter(id => { const r = rank('base', id); return r >= 5 && r <= SHOW && rank('both', id) === 1 && rank('hybrid', id) < r })
      .sort((a, b) => rank('base', b) - rank('base', a))[0] ?? evals.base.scored[0].queryId
    const lists = Object.fromEntries(Object.entries(configs).map(([k, rows]) => {
      const row = rows.find(r => r.queryId === pickQ)!
      const j = judge(ctx, pickQ, row.retrieved)
      return [k, row.retrieved.slice(0, SHOW).map((r, i) => ({ id: r.id, g: j.grades[i] }))]
    })) as Record<keyof typeof configs, { id: string; g: number }[]>
    const gold = Object.entries(ds.qrels[pickQ]).sort((a, b) => b[1] - a[1])[0][0]
    const text = (id: string) => { const c = ctx.chunks.get(id)!; return `${c.title} · ${c.text.replace(/^#.*\n+/, '').replace(/\s+/g, ' ')}` }
    const query = ds.queries.find(q => q.id === pickQ)!
    return { evals, lists, gold, text, query, n: evals.base.scored.length }
  }, [])
}

function LiveRanking() {
  const m = useHeroModel()
  const [hybrid, setHybrid] = useState(false)
  const [rerank, setRerank] = useState(false)
  const [auto, setAuto] = useState(true)
  useEffect(() => {
    if (!auto || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const steps: [boolean, boolean][] = [[false, false], [true, false], [true, true], [false, true]]
    let i = 0
    const t = setInterval(() => { i = (i + 1) % steps.length; setHybrid(steps[i][0]); setRerank(steps[i][1]) }, 2600)
    return () => clearInterval(t)
  }, [auto])
  const key = hybrid ? rerank ? 'both' : 'hybrid' : rerank ? 'rerank' : 'base'
  const list = m.lists[key]
  const all = useMemo(() => [...new Set(Object.values(m.lists).flatMap(l => l.map(x => x.id)))], [m])
  const ev = m.evals[key]
  const goldRank = list.findIndex(x => x.id === m.gold) + 1

  return (
    <div className="live" aria-label="Live ranked list for one sample query">
      <div className="live-bar"><span className="dot" aria-hidden="true" /> retrieval run · synthetic help centre · {m.n} labelled queries</div>
      <div className="live-q"><small>Query {m.query.id}</small><p>&ldquo;{m.query.text}&rdquo;</p></div>
      <div className="live-toggles">
        <button type="button" className="chip" aria-pressed={hybrid} onClick={() => { setAuto(false); setHybrid(!hybrid) }}><i aria-hidden="true" />Hybrid + BM25</button>
        <button type="button" className="chip" aria-pressed={rerank} onClick={() => { setAuto(false); setRerank(!rerank) }}><i aria-hidden="true" />Rerank</button>
      </div>
      <div className="live-body">
        <ol className="live-list" style={{ height: SHOW * ROW }} aria-live="polite">
          {all.map(id => {
            const i = list.findIndex(x => x.id === id)
            const g = i >= 0 ? list[i].g : 0
            return (
              <li key={id} className={`${id === m.gold ? 'gold' : g > 0 ? 'rel' : ''}${i < 0 ? ' out' : ''}`} style={{ transform: `translateY(${(i < 0 ? SHOW : i) * ROW}px)` }} aria-hidden={i < 0}>
                <span className="rk">{i < 0 ? '' : i + 1}</span>
                <span className={`grade g${g}`}>{g}</span>
                <span className="txt">{m.text(id)}</span>
              </li>
            )
          })}
          <div className="kline" style={{ top: K * ROW - 3 }}><span>k = {K}</span></div>
        </ol>
        <div className="dials">
          <Dial value={ev.agg['ndcg@10'].mean} from={m.evals.base.agg['ndcg@10'].mean} label="nDCG@10" />
          <Dial value={ev.agg['recall@5'].mean} from={m.evals.base.agg['recall@5'].mean} label="Recall@5" />
          <p className="live-note">Across all {m.n} queries. Gold chunk here: rank {goldRank || '>' + SHOW}.</p>
        </div>
      </div>
      <div className="live-foot"><span>Grades 0 to 3 from qrels. Ranks re-scored by the same engine the app uses.</span><Link href="/app?sample=ledgerly">Open this run</Link></div>
    </div>
  )
}

const QUOTES = [
  ['You do not need an LLM judge to evaluate retrieval. That is the half everyone skips.', 'r/Rag, paraphrased'],
  ['How do you actually tell whether your chunking strategy is any good?', 'r/Rag, paraphrased'],
  ['My RAG had all the evidence and still got 167 answers wrong.', 'r/AI_Agents, paraphrased'],
]

const FEATURES = [
  ['Metrics with error bars', 'Recall, Precision, Hit and nDCG at k with graded relevance, MRR and MAP, each with a bootstrap confidence interval over queries.'],
  ['Is v2 really better?', 'Paired bootstrap and randomisation tests between runs, per-query wins and losses, and a ship / no-ship verdict against your thresholds.'],
  ['Chunking diagnostics', 'Size distribution, the share of gold answers your chunker cuts in half, MinHash near-duplicates, tiny and orphan chunks.'],
  ['Re-chunking simulator', 'Rebuild documents from chunk offsets and test fixed, sentence and heading strategies against your gold spans. No embeddings needed.'],
  ['Rerank and hybrid what-if', 'Reorder by logged rerank scores, a local BM25 index, or RRF fusion of your dense ranking with BM25, and see the metric deltas with p-values.'],
  ['Failure triage', 'Gold never retrieved, retrieved but ranked low, answer cited the wrong chunk, query too vague, or the answer was cut by a chunk boundary.'],
]

export function Landing() {
  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <div>
            <div className="eyebrow">Retrieval evaluation for RAG</div>
            <h1>Measure the half of RAG <em>before</em> the LLM.</h1>
            <p className="lede">RAG Eval Desk scores your logged retrieval runs against labelled queries: recall, nDCG and MRR with confidence intervals, what your chunker cuts, what a reranker or BM25 would fix, and whether the new pipeline is actually better. No LLM judge, no API keys, nothing leaves your browser.</p>
            <div className="hero-ctas">
              <Link href="/app?sample=ledgerly" className="btn primary lg">Try the sample</Link>
              <Link href="/app" className="btn outline lg">Import your logs</Link>
            </div>
            <p className="hero-note">For ML and AI product engineers running a RAG chatbot in production. Sample data is synthetic.</p>
          </div>
          <LiveRanking />
        </div>
      </section>

      <section className="section">
        <div className="section-head"><div className="eyebrow">Why</div><h2>Most RAG failures are retrieval failures you can count.</h2><p>Teams reach for LLM judges and end up debugging the judge. If you log what the retriever returned and label what should have come back, plain IR metrics tell you where it breaks, and they are cheap enough to run in CI.</p></div>
        <div className="quotes">{QUOTES.map(([q, s]) => <figure key={q} className="quote"><blockquote>&ldquo;{q}&rdquo;</blockquote><span className="src">{s}</span></figure>)}</div>
      </section>

      <section className="section">
        <div className="section-head"><div className="eyebrow">What you get</div><h2>From a JSONL log to a ship decision.</h2></div>
        <div className="features">{FEATURES.map(([t, d]) => <article key={t} className="feature"><h3>{t}</h3><p>{d}</p></article>)}</div>
      </section>

      <section className="section">
        <div className="section-head"><div className="eyebrow">Inputs</div><h2>Bring what you already log.</h2><p>Retrieval logs as JSONL or CSV, LangChain and LlamaIndex trace exports, Ragas datasets, TREC run files. Qrels in BEIR or TREC format, or gold answer spans. The chunks file with offsets for the chunking diagnostics. Format is detected, columns are mapped, and bad rows come back with line numbers.</p></div>
        <div className="metric-grid">
          <div className="metric-card"><b>1 · Import</b><p>Runs, qrels, spans and chunks. Several runs per project, one per pipeline version.</p></div>
          <div className="metric-card"><b>2 · Label</b><p>Grade unlabelled queries 0 to 3 from the keyboard to grow your qrels.</p></div>
          <div className="metric-card"><b>3 · Diagnose</b><p>Failure buckets, slices by intent and length, chunking cuts and duplicates.</p></div>
          <div className="metric-card"><b>4 · Decide</b><p>Regression report, CI gate config, failure worklist CSV, chunking recommendation.</p></div>
        </div>
      </section>

      <section className="cta-band">
        <div className="cta-inner">
          <div><h2>See it on 80 labelled queries.</h2><p>A synthetic help centre with two runs: dense only, and dense + BM25 hybrid over fixed-size chunks that cut answers.</p></div>
          <Link href="/app?sample=ledgerly" className="btn primary lg">Open the sample</Link>
        </div>
      </section>
    </>
  )
}
