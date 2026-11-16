// BM25 over the full BEIR NQ corpus with the app's own tokeniser and formula, two index variants.
import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { terms } from '../../src/engine/text.ts'
// usage: node scripts/nq-sample/1-bm25.ts <dir with corpus.jsonl and queries.jsonl> <out bm25.json> [offset, default 9]
const D = process.argv[2].replace(/\/?$/, '/'), OUT = process.argv[3]
const all = readFileSync(D + 'queries.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l))
const offset = Number(process.argv[4] ?? 9)
const queries = all.filter((_, i) => i % 43 === offset).slice(0, 80)
const qterms = queries.map(q => [...new Set(terms(q.text))])
const vocab = new Map<string, number[]>()
qterms.forEach((ts, qi) => ts.forEach(t => { const l = vocab.get(t) ?? []; l.push(qi); vocab.set(t, l) }))
const lines = () => createInterface({ input: createReadStream(D + 'corpus.jsonl'), crlfDelay: Infinity })
const k1 = 1.2, b = 0.75, DEPTH = 100
// pass 1: N, average lengths, document frequencies of query terms
let N = 0, lenX = 0, lenTX = 0
const dfX = new Map<string, number>(), dfTX = new Map<string, number>()
for await (const l of lines()) {
  const d = JSON.parse(l)
  const tT = terms(d.title), tX = terms(d.text)
  N++; lenX += tX.length; lenTX += tX.length + tT.length
  const sx = new Set<string>(), st = new Set<string>()
  for (const t of tX) if (vocab.has(t)) sx.add(t)
  for (const t of tT) if (vocab.has(t)) st.add(t)
  for (const t of sx) { dfX.set(t, (dfX.get(t) ?? 0) + 1); dfTX.set(t, (dfTX.get(t) ?? 0) + 1) }
  for (const t of st) if (!sx.has(t)) dfTX.set(t, (dfTX.get(t) ?? 0) + 1)
  if (N % 500000 === 0) console.error('pass1', N)
}
const avgX = lenX / N, avgTX = lenTX / N
const idf = (df: Map<string, number>, t: string) => { const n = df.get(t) ?? 0; return Math.log(1 + (N - n + 0.5) / (n + 0.5)) }
console.error({ N, avgX, avgTX })
// pass 2: score
type Hit = { id: string; s: number; o: number }
const topX: Hit[][] = queries.map(() => []), topTX: Hit[][] = queries.map(() => [])
const thrX = new Float64Array(queries.length), thrTX = new Float64Array(queries.length)
const push = (top: Hit[][], thr: Float64Array, qi: number, h: Hit) => {
  if (h.s <= thr[qi]) return
  const l = top[qi]; l.push(h)
  if (l.length >= 4 * DEPTH) { l.sort((x, y) => y.s - x.s || x.o - y.o); l.length = DEPTH; thr[qi] = l[DEPTH - 1].s }
}
let o = 0
for await (const l of lines()) {
  const d = JSON.parse(l)
  const tT = terms(d.title), tX = terms(d.text)
  const fx = new Map<string, number>(), ft = new Map<string, number>()
  for (const t of tX) if (vocab.has(t)) fx.set(t, (fx.get(t) ?? 0) + 1)
  for (const t of tT) if (vocab.has(t)) ft.set(t, (ft.get(t) ?? 0) + 1)
  if (fx.size || ft.size) {
    const sx = new Map<number, number>(), stx = new Map<number, number>()
    for (const [t, f] of fx) { const v = idf(dfX, t) * f * (k1 + 1) / (f + k1 * (1 - b + b * tX.length / avgX)); for (const qi of vocab.get(t)!) sx.set(qi, (sx.get(qi) ?? 0) + v) }
    for (const t of new Set([...fx.keys(), ...ft.keys()])) { const f = (fx.get(t) ?? 0) + (ft.get(t) ?? 0); const v = idf(dfTX, t) * f * (k1 + 1) / (f + k1 * (1 - b + b * (tX.length + tT.length) / avgTX)); for (const qi of vocab.get(t)!) stx.set(qi, (stx.get(qi) ?? 0) + v) }
    for (const [qi, s] of sx) push(topX, thrX, qi, { id: d._id, s, o })
    for (const [qi, s] of stx) push(topTX, thrTX, qi, { id: d._id, s, o })
  }
  if (++o % 500000 === 0) console.error('pass2', o)
}
const fin = (top: Hit[][]) => top.map(l => l.sort((x, y) => y.s - x.s || x.o - y.o).slice(0, DEPTH).map(h => ({ id: h.id, score: +h.s.toFixed(4) })))
writeFileSync(OUT, JSON.stringify({ N, avgX, avgTX, offset, queries, text: fin(topX), titleText: fin(topTX) }))
