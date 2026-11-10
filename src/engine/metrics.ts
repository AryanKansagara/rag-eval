import type { Chunk, Dataset, GoldSpan, Level, Qrels, Retrieved, RunRow } from './types.ts'

// ---------- Judging a ranked list ----------

/** A ranked list after relevance has been resolved: each position's credited grade, plus the ideal grades. */
export interface Judged {
  queryId: string
  grades: number[]
  /** Ids (chunk or doc) in ranked order, aligned with grades. */
  ids: string[]
  ideal: number[]
  /** null when the query has no judgments at all at this level */
  labelled: boolean
}

export interface Ctx {
  level: Level
  chunks: Map<string, Chunk>
  qrels: Qrels
  spans: Map<string, GoldSpan[]>
}

export function makeCtx(ds: Pick<Dataset, 'corpus' | 'qrels' | 'spans'>, level: Level): Ctx {
  const spans = new Map<string, GoldSpan[]>()
  for (const s of ds.spans) { const l = spans.get(s.queryId) ?? []; l.push(s); spans.set(s.queryId, l) }
  return { level, chunks: new Map(ds.corpus.map(c => [c.id, c])), qrels: ds.qrels, spans }
}

export const docOf = (ctx: Ctx, id: string) => ctx.chunks.get(id)?.docId ?? id

/** Grade a chunk against one gold span by how much of the span it covers. */
export function spanGrade(c: Chunk | undefined, s: GoldSpan): number {
  if (!c || c.docId !== s.docId || c.start === undefined || c.end === undefined) return 0
  const len = s.end - s.start
  if (len <= 0) return 0
  const ov = Math.min(c.end, s.end) - Math.max(c.start, s.start)
  if (ov <= 0) return 0
  const cov = ov / len
  return cov >= 0.999 ? 3 : cov >= 0.5 ? 2 : 1
}

export function judge(ctx: Ctx, queryId: string, retrieved: Retrieved[]): Judged {
  const q = ctx.qrels[queryId]
  if (ctx.level === 'span') {
    const spans = ctx.spans.get(queryId) ?? []
    const used = new Set<number>()
    const grades: number[] = [], ids: string[] = []
    for (const r of retrieved) {
      let best = 0, bi = -1
      spans.forEach((s, i) => { if (used.has(i)) return; const g = spanGrade(ctx.chunks.get(r.id), s); if (g > best) { best = g; bi = i } })
      if (bi >= 0) used.add(bi)
      grades.push(best); ids.push(r.id)
    }
    return { queryId, grades, ids, ideal: spans.map(() => 3), labelled: spans.length > 0 || !!q }
  }
  if (!q) return { queryId, grades: retrieved.map(() => 0), ids: retrieved.map(r => r.id), ideal: [], labelled: false }

  if (ctx.level === 'doc') {
    const docGrade = new Map<string, number>()
    for (const [k, g] of Object.entries(q)) { const d = docOf(ctx, k); docGrade.set(d, Math.max(docGrade.get(d) ?? 0, g)) }
    const seen = new Set<string>()
    const grades: number[] = [], ids: string[] = []
    for (const r of retrieved) {
      const d = docOf(ctx, r.id)
      if (seen.has(d)) continue
      seen.add(d)
      grades.push(docGrade.get(d) ?? 0); ids.push(d)
    }
    return { queryId, grades, ids, ideal: [...docGrade.values()].filter(g => g > 0), labelled: true }
  }

  // Chunk level. Judgments keyed by doc id (BEIR-style) credit the first chunk of that doc only.
  const credited = new Set<string>()
  const grades: number[] = [], ids: string[] = []
  for (const r of retrieved) {
    const key = r.id in q ? r.id : docOf(ctx, r.id) in q ? docOf(ctx, r.id) : null
    let g = 0
    if (key && !credited.has(key)) { g = q[key]; credited.add(key) }
    grades.push(g); ids.push(r.id)
  }
  return { queryId, grades, ids, ideal: Object.values(q).filter(g => g > 0), labelled: true }
}

// ---------- Metrics ----------

export const METRICS = ['ndcg@10', 'recall@5', 'recall@10', 'precision@5', 'hit@5', 'mrr', 'map'] as const
export const METRIC_LABEL: Record<string, string> = {
  'ndcg@10': 'nDCG@10', 'ndcg@5': 'nDCG@5', 'recall@5': 'Recall@5', 'recall@10': 'Recall@10', 'recall@20': 'Recall@20', 'recall@1': 'Recall@1', 'recall@3': 'Recall@3',
  'precision@5': 'Precision@5', 'precision@1': 'Precision@1', 'precision@10': 'Precision@10', 'hit@1': 'Hit@1', 'hit@3': 'Hit@3', 'hit@5': 'Hit@5', 'hit@10': 'Hit@10', mrr: 'MRR', map: 'MAP',
}
export const metricLabel = (m: string) => METRIC_LABEL[m] ?? m.replace(/^(\w)/, c => c.toUpperCase())

const gain = (g: number) => 2 ** g - 1
export function dcg(grades: number[], k: number) {
  let s = 0
  for (let i = 0; i < Math.min(k, grades.length); i++) s += gain(grades[i]) / Math.log2(i + 2)
  return s
}

/** One metric for one judged list. Returns NaN when the query has nothing relevant (excluded from means). */
export function metric(name: string, j: Pick<Judged, 'grades' | 'ideal'>, minGrade = 1): number {
  const nRel = j.ideal.filter(g => g >= minGrade).length
  if (!nRel) return NaN
  const [base, kRaw] = name.split('@')
  const k = kRaw ? Number(kRaw) : Infinity
  const top = j.grades.slice(0, k)
  const hits = top.filter(g => g >= minGrade).length
  switch (base) {
    case 'recall': return Math.min(1, hits / nRel)
    case 'precision': return hits / k
    case 'hit': return hits > 0 ? 1 : 0
    case 'mrr': { const i = j.grades.slice(0, k).findIndex(g => g >= minGrade); return i < 0 ? 0 : 1 / (i + 1) }
    case 'ndcg': {
      const ideal = dcg([...j.ideal].sort((a, b) => b - a), k)
      return ideal ? dcg(j.grades, k) / ideal : 0
    }
    case 'map': {
      let n = 0, s = 0
      top.forEach((g, i) => { if (g >= minGrade) { n++; s += n / (i + 1) } })
      return s / nRel
    }
  }
  throw new Error(`Unknown metric ${name}`)
}

/** Rank (1-based) of the first relevant item, or 0 when none was retrieved. */
export const firstRelevant = (j: Judged, minGrade = 1) => j.grades.findIndex(g => g >= minGrade) + 1

// ---------- Statistics ----------

/** Small seeded PRNG so confidence intervals are stable between renders. */
export function rng(seed = 1) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return NaN
  const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo)
}

export interface Estimate { mean: number; lo: number; hi: number; n: number }

/** Percentile bootstrap over queries. */
export function bootstrap(xs: number[], iters = 1000, seed = 7, alpha = 0.05): Estimate {
  const n = xs.length
  if (!n) return { mean: NaN, lo: NaN, hi: NaN, n: 0 }
  const r = rng(seed)
  const means: number[] = new Array(iters)
  for (let b = 0; b < iters; b++) {
    let s = 0
    for (let i = 0; i < n; i++) s += xs[Math.floor(r() * n)]
    means[b] = s / n
  }
  means.sort((a, b) => a - b)
  return { mean: mean(xs), lo: quantile(means, alpha / 2), hi: quantile(means, 1 - alpha / 2), n }
}

export interface Paired { delta: number; lo: number; hi: number; pBootstrap: number; pRandom: number; n: number; wins: number; losses: number; ties: number }

/** Paired comparison of per-query scores b - a: bootstrap CI of the mean delta, and two-sided p-values
 * from a paired bootstrap (shifted to the null) and a sign-flip randomisation test. */
export function pairedTest(a: number[], b: number[], iters = 2000, seed = 11): Paired {
  const d = a.map((x, i) => b[i] - x)
  const n = d.length
  const wins = d.filter(x => x > 1e-12).length, losses = d.filter(x => x < -1e-12).length
  if (!n) return { delta: NaN, lo: NaN, hi: NaN, pBootstrap: 1, pRandom: 1, n: 0, wins, losses, ties: 0 }
  const obs = mean(d)
  const r = rng(seed)
  const boot: number[] = new Array(iters)
  let extremeB = 0, extremeR = 0
  for (let it = 0; it < iters; it++) {
    let s = 0
    for (let i = 0; i < n; i++) s += d[Math.floor(r() * n)]
    boot[it] = s / n
    if (Math.abs(boot[it] - obs) >= Math.abs(obs) - 1e-12) extremeB++
    let f = 0
    for (let i = 0; i < n; i++) f += r() < 0.5 ? d[i] : -d[i]
    if (Math.abs(f / n) >= Math.abs(obs) - 1e-12) extremeR++
  }
  boot.sort((x, y) => x - y)
  const allZero = d.every(x => Math.abs(x) < 1e-12)
  return {
    delta: obs, lo: quantile(boot, 0.025), hi: quantile(boot, 0.975),
    pBootstrap: allZero ? 1 : (extremeB + 1) / (iters + 1),
    pRandom: allZero ? 1 : (extremeR + 1) / (iters + 1),
    n, wins, losses, ties: n - wins - losses,
  }
}

// ---------- Evaluating a run ----------

export interface QueryScore { queryId: string; judged: Judged; scores: Record<string, number> }
export interface RunEval {
  perQuery: QueryScore[]
  /** Queries with relevant judgments (the ones metrics average over). */
  scored: QueryScore[]
  unlabelled: string[]
  noGold: string[]
  agg: Record<string, Estimate>
}

export function evaluateRows(ctx: Ctx, rows: RunRow[], metrics: readonly string[] = METRICS, minGrade = 1, iters = 1000): RunEval {
  const perQuery = rows.map(r => {
    const judged = judge(ctx, r.queryId, r.retrieved)
    return { queryId: r.queryId, judged, scores: Object.fromEntries(metrics.map(m => [m, metric(m, judged, minGrade)])) }
  })
  const unlabelled = perQuery.filter(q => !q.judged.labelled).map(q => q.queryId)
  const noGold = perQuery.filter(q => q.judged.labelled && !q.judged.ideal.some(g => g >= minGrade)).map(q => q.queryId)
  const scored = perQuery.filter(q => q.judged.labelled && q.judged.ideal.some(g => g >= minGrade))
  const agg = Object.fromEntries(metrics.map((m, i) => [m, bootstrap(scored.map(q => q.scores[m]), iters, 7 + i)]))
  return { perQuery, scored, unlabelled, noGold, agg }
}

/** Align two evaluations on shared scored queries and test every metric. */
export function compareEvals(a: RunEval, b: RunEval, metrics: readonly string[] = METRICS, iters = 2000) {
  const bm = new Map(b.scored.map(q => [q.queryId, q]))
  const shared = a.scored.filter(q => bm.has(q.queryId))
  const tests = Object.fromEntries(metrics.map((m, i) => [m, pairedTest(shared.map(q => q.scores[m]), shared.map(q => bm.get(q.queryId)!.scores[m]), iters, 11 + i)]))
  return { shared: shared.map(q => q.queryId), tests }
}

/** Per-query deltas on one metric, biggest losses first. */
export function winsLosses(a: RunEval, b: RunEval, m: string) {
  const bm = new Map(b.scored.map(q => [q.queryId, q]))
  return a.scored.filter(q => bm.has(q.queryId))
    .map(q => ({ queryId: q.queryId, a: q.scores[m], b: bm.get(q.queryId)!.scores[m], delta: bm.get(q.queryId)!.scores[m] - q.scores[m] }))
    .sort((x, y) => x.delta - y.delta)
}
