import type { SpanCheck } from './chunks.ts'
import { compareEvals, firstRelevant, judge, metricLabel, type Ctx, type Estimate, type RunEval } from './metrics.ts'
import { rrf, type Bm25 } from './text.ts'
import type { Query, RunRow } from './types.ts'

// ---------- Rerank what-if ----------

export type WhatIf = 'baseline' | 'rerank' | 'bm25-rerank' | 'bm25' | 'hybrid'
export const WHATIF_LABEL: Record<WhatIf, string> = {
  baseline: 'As logged',
  rerank: 'Logged rerank scores',
  'bm25-rerank': 'Rerank candidates by BM25',
  bm25: 'BM25 only (local index)',
  hybrid: 'Hybrid: logged ranking + BM25 (RRF)',
}

export const hasRerank = (rows: RunRow[]) => rows.some(r => r.retrieved.some(x => x.rerank !== undefined))

export function applyWhatIf(mode: WhatIf, rows: RunRow[], opts: { bm?: Bm25; queries?: Map<string, Query>; depth?: number; rrfK?: number } = {}): RunRow[] {
  if (mode === 'baseline') return rows
  const text = (r: RunRow) => r.query ?? opts.queries?.get(r.queryId)?.text ?? ''
  return rows.map(r => {
    // BM25 and fusion keep the logged depth so metrics stay comparable with the run as logged.
    const depth = opts.depth ?? (r.retrieved.length || 10)
    let retrieved = r.retrieved
    if (mode === 'rerank') {
      retrieved = r.retrieved.map((x, i) => ({ x, i })).sort((a, b) => (b.x.rerank ?? -Infinity) - (a.x.rerank ?? -Infinity) || a.i - b.i).map(o => o.x)
    } else {
      if (!opts.bm) throw new Error('BM25 needs the corpus file')
      const bm = opts.bm
      if (mode === 'bm25-rerank') {
        const q = text(r)
        retrieved = r.retrieved.map((x, i) => ({ x, i, s: bm.score(q, x.id) })).sort((a, b) => b.s - a.s || a.i - b.i).map(o => o.x)
      } else if (mode === 'bm25') retrieved = bm.search(text(r), depth)
      else retrieved = rrf([r.retrieved, bm.search(text(r), depth)], opts.rrfK ?? 60, depth)
    }
    return { ...r, retrieved }
  })
}

// ---------- Failure triage ----------

export type Bucket = 'not-retrieved' | 'ranked-low' | 'wrong-citation' | 'no-gold' | 'unlabelled' | 'ok'
export const BUCKETS: { id: Bucket; label: string; hint: string }[] = [
  { id: 'not-retrieved', label: 'Gold not retrieved', hint: 'No relevant chunk anywhere in the retrieved list. Check chunking, the embedder, and query rewriting.' },
  { id: 'ranked-low', label: 'Retrieved but ranked low', hint: 'The relevant chunk is there but below k. A reranker or hybrid fusion usually fixes these.' },
  { id: 'wrong-citation', label: 'Answer cited the wrong chunk', hint: 'Retrieval found the gold chunk in the top k, but the answer cited something else. A generation or prompt problem.' },
  { id: 'no-gold', label: 'Query too vague (no gold)', hint: 'Labelled, but nothing in the corpus answers it. Rewrite, clarify, or add content.' },
  { id: 'unlabelled', label: 'Not labelled yet', hint: 'No judgments. Label them in the Label tab.' },
  { id: 'ok', label: 'Working', hint: 'Relevant chunk in the top k and, if logged, cited.' },
]

export interface TriageRow { queryId: string; bucket: Bucket; firstRank: number; boundaryCut: boolean; goldIds: string[]; topIds: string[] }

export function triage(ev: RunEval, rows: RunRow[], ctx: Ctx, spanChecks: SpanCheck[], k: number, minGrade = 1): TriageRow[] {
  const rowBy = new Map(rows.map(r => [r.queryId, r]))
  const cutBy = new Map<string, boolean>()
  const spanChunks = new Map<string, string[]>()
  for (const c of spanChecks) {
    if (c.status === 'cut') cutBy.set(c.span.queryId, true)
    spanChunks.set(c.span.queryId, [...(spanChunks.get(c.span.queryId) ?? []), ...c.chunkIds])
  }
  return ev.perQuery.map(q => {
    const row = rowBy.get(q.queryId)!
    const j = q.judged
    const first = firstRelevant(j, minGrade)
    const qr = ctx.qrels[q.queryId] ?? {}
    const goldIds = ctx.level === 'span' ? spanChunks.get(q.queryId) ?? [] : Object.entries(qr).filter(([, g]) => g >= minGrade).map(([id]) => id)
    let bucket: Bucket
    if (!j.labelled) bucket = 'unlabelled'
    else if (!j.ideal.some(g => g >= minGrade)) bucket = 'no-gold'
    else if (!first) bucket = 'not-retrieved'
    else if (first > k) bucket = 'ranked-low'
    else if (row.cited?.length && !judge(ctx, q.queryId, row.cited.map(id => ({ id }))).grades.some(g => g >= minGrade)) bucket = 'wrong-citation'
    else bucket = 'ok'
    return { queryId: q.queryId, bucket, firstRank: first, boundaryCut: !!cutBy.get(q.queryId), goldIds, topIds: j.ids.slice(0, 3) }
  })
}

export function bucketCounts(t: TriageRow[]) {
  const c = Object.fromEntries(BUCKETS.map(b => [b.id, 0])) as Record<Bucket, number>
  for (const r of t) c[r.bucket]++
  return { ...c, boundaryCut: t.filter(r => r.boundaryCut && (r.bucket === 'not-retrieved' || r.bucket === 'ranked-low')).length }
}

export const SUGGEST: Record<Bucket, string> = {
  'not-retrieved': 'Check the gold chunk exists and is not split; try hybrid BM25 for exact terms',
  'ranked-low': 'Add a reranker or hybrid fusion; consider a larger k',
  'wrong-citation': 'Tighten the citation prompt or pass fewer, better-ranked chunks',
  'no-gold': 'Clarify the query or add the missing content',
  unlabelled: 'Label this query',
  ok: '',
}

// ---------- Slices ----------

export const lengthBucket = (text: string) => { const n = text.trim().split(/\s+/).filter(Boolean).length; return n <= 4 ? 'short (1-4 words)' : n <= 10 ? 'medium (5-10)' : 'long (11+)' }

export interface Slice { dim: 'tag' | 'intent' | 'length'; value: string; n: number; mean: number; ids: string[] }

export function slices(ev: RunEval, queries: Map<string, Query>, m: string, rows?: RunRow[]): Slice[] {
  const rowText = new Map(rows?.map(r => [r.queryId, r.query ?? '']) ?? [])
  const groups = new Map<string, { dim: Slice['dim']; value: string; xs: number[]; ids: string[] }>()
  const add = (dim: Slice['dim'], value: string, x: number, id: string) => {
    const key = dim + ':' + value
    const g = groups.get(key) ?? { dim, value, xs: [], ids: [] }
    g.xs.push(x); g.ids.push(id); groups.set(key, g)
  }
  for (const q of ev.scored) {
    const meta = queries.get(q.queryId)
    const x = q.scores[m]
    for (const t of meta?.tags ?? []) add('tag', t, x, q.queryId)
    if (meta?.intent) add('intent', meta.intent, x, q.queryId)
    add('length', lengthBucket(meta?.text || rowText.get(q.queryId) || ''), x, q.queryId)
  }
  return [...groups.values()].map(g => ({ dim: g.dim, value: g.value, n: g.xs.length, mean: g.xs.reduce((a, b) => a + b, 0) / g.xs.length, ids: g.ids }))
    .sort((a, b) => a.dim.localeCompare(b.dim) || a.mean - b.mean)
}

// ---------- Regression verdict ----------

export interface Threshold { metric: string; min?: number; maxDrop?: number }
export const DEFAULT_THRESHOLDS: Threshold[] = [
  { metric: 'ndcg@10', min: 0.5, maxDrop: 0.02 },
  { metric: 'recall@5', min: 0.6, maxDrop: 0.02 },
  { metric: 'mrr', maxDrop: 0.03 },
]

export interface Check { metric: string; base: number; value: number; delta: number; p: number; pass: boolean; reason: string }
export interface Verdict { ship: boolean; checks: Check[]; shared: number }

/** Ship unless a metric falls under its floor, or drops by more than allowed with p < alpha. */
export function verdict(base: RunEval, cand: RunEval, thresholds: Threshold[], opts: { alpha?: number; requireSignificance?: boolean } = {}): Verdict {
  const alpha = opts.alpha ?? 0.05
  const metrics = [...new Set(thresholds.map(t => t.metric))]
  const cmp = compareEvals(base, cand, metrics)
  const checks = thresholds.map(t => {
    const b = base.agg[t.metric]?.mean ?? NaN, v = cand.agg[t.metric]?.mean ?? NaN
    const test = cmp.tests[t.metric]
    const delta = test.delta, p = Math.min(test.pBootstrap, test.pRandom)
    const reasons: string[] = []
    let pass = true
    if (t.min !== undefined && !(v >= t.min)) { pass = false; reasons.push(`${metricLabel(t.metric)} ${v.toFixed(3)} is under the floor ${t.min}`) }
    if (t.maxDrop !== undefined && delta < -t.maxDrop) {
      const sig = p < alpha
      if (sig || opts.requireSignificance === false) { pass = false; reasons.push(`dropped ${(-delta).toFixed(3)} (allowed ${t.maxDrop}${sig ? `, p=${p.toFixed(3)}` : ''})`) }
      else reasons.push(`dropped ${(-delta).toFixed(3)} but not significant (p=${p.toFixed(2)})`)
    }
    return { metric: t.metric, base: b, value: v, delta, p, pass, reason: reasons.join('; ') || 'within thresholds' }
  })
  return { ship: checks.every(c => c.pass), checks, shared: cmp.shared.length }
}

// ---------- Exports ----------

export function toCsv(rows: (string | number | undefined)[][]): string {
  return rows.map(r => r.map(v => {
    const s = v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\n') + '\n'
}

export function worklistCsv(t: TriageRow[], queries: Map<string, Query>, rows: RunRow[], scores: Map<string, number>, metric: string): string {
  const rowText = new Map(rows.map(r => [r.queryId, r.query]))
  const order: Bucket[] = ['not-retrieved', 'ranked-low', 'wrong-citation', 'no-gold', 'unlabelled']
  const list = t.filter(r => r.bucket !== 'ok').sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket) || a.queryId.localeCompare(b.queryId))
  return toCsv([
    ['query_id', 'query', 'bucket', 'boundary_cut', 'first_relevant_rank', metric, 'gold_ids', 'top3_retrieved', 'suggested_fix'],
    ...list.map(r => [r.queryId, queries.get(r.queryId)?.text ?? rowText.get(r.queryId) ?? '', r.bucket, r.boundaryCut ? 'yes' : '', r.firstRank || '', scores.get(r.queryId)?.toFixed(4), r.goldIds.join(' '), r.topIds.join(' '), (r.boundaryCut ? 'Gold answer is split across chunks; re-chunk. ' : '') + SUGGEST[r.bucket]]),
  ])
}

export function metricsExport(name: string, ev: RunEval, metrics: readonly string[]) {
  return {
    run: name,
    queries: ev.scored.length,
    metrics: Object.fromEntries(metrics.map(m => [m, round(ev.agg[m]?.mean)])),
    perQuery: Object.fromEntries(metrics.map(m => [m, Object.fromEntries(ev.scored.map(q => [q.queryId, round(q.scores[m])]))])),
  }
}
const round = (x: number | undefined) => x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4

export function gateConfig(thresholds: Threshold[], alpha = 0.05) {
  return { alpha, thresholds: thresholds.map(t => ({ metric: t.metric, ...(t.min !== undefined ? { min: t.min } : {}), ...(t.maxDrop !== undefined ? { maxDrop: t.maxDrop } : {}) })) }
}

/** Dependency-free Node script for CI. Exits 1 when the candidate fails the gate. */
export const CI_SCRIPT = `// rag-gate.mjs: node rag-gate.mjs thresholds.json baseline.json candidate.json
import { readFileSync } from 'node:fs'
const [cfgPath, basePath, candPath] = process.argv.slice(2)
const read = p => JSON.parse(readFileSync(p, 'utf8'))
const cfg = read(cfgPath), base = read(basePath), cand = read(candPath)
const alpha = cfg.alpha ?? 0.05
// Sign-flip randomisation test on shared per-query scores (seeded so CI is repeatable).
function pValue(m) {
  const a = base.perQuery?.[m] ?? {}, b = cand.perQuery?.[m] ?? {}
  const d = Object.keys(a).filter(q => q in b && a[q] !== null && b[q] !== null).map(q => b[q] - a[q])
  if (!d.length) return 1
  const obs = Math.abs(d.reduce((s, x) => s + x, 0) / d.length)
  if (obs === 0) return 1
  let seed = 12345, hit = 0
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  for (let i = 0; i < 5000; i++) { let s = 0; for (const x of d) s += rnd() < 0.5 ? x : -x; if (Math.abs(s / d.length) >= obs - 1e-12) hit++ }
  return (hit + 1) / 5001
}
let failed = 0
for (const t of cfg.thresholds) {
  const v = cand.metrics[t.metric], b = base.metrics[t.metric]
  const problems = []
  if (t.min !== undefined && !(v >= t.min)) problems.push(\`below floor \${t.min}\`)
  if (t.maxDrop !== undefined && b !== undefined && v < b - t.maxDrop) {
    const p = pValue(t.metric)
    if (p < alpha) problems.push(\`dropped \${(b - v).toFixed(4)} (p=\${p.toFixed(4)})\`)
  }
  console.log(\`\${problems.length ? 'FAIL' : 'ok  '} \${t.metric.padEnd(12)} \${String(b).padEnd(8)} -> \${v}\${problems.length ? '  ' + problems.join(', ') : ''}\`)
  if (problems.length) failed++
}
console.log(failed ? \`\\nNo ship: \${failed} check(s) failed\` : '\\nShip: all checks passed')
process.exit(failed ? 1 : 0)
`

// ---------- Snapshots ----------

export interface Snapshot {
  id: string
  runId: string
  runName: string
  label: string
  at: number
  level: string
  k: number
  queries: number
  metrics: Record<string, Estimate>
  /** Main metric per query, for the compare view. */
  perQuery: Record<string, number>
  buckets: Record<string, number>
  cutRate: number
}
