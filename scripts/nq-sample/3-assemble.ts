// Assemble the public sample file from the BM25 and rerank outputs.
// usage: node scripts/nq-sample/3-assemble.ts bm25.json rerank.json public/samples/nq-beir-80.json
import { readFileSync, writeFileSync } from 'node:fs'
const [bmPath, rrPath, outPath] = process.argv.slice(2)
const b = JSON.parse(readFileSync(bmPath, 'utf8')), r = JSON.parse(readFileSync(rrPath, 'utf8'))
const K = 10
const ce: Map<string, number>[] = r.rerank.map((l: any[]) => new Map(l.map(x => [x.id, x.ce])))
const runs = [
  { id: 'nq-bm25-text', name: 'BM25, passage text only', notes: `BM25 (k1 1.2, b 0.75) over all ${b.N.toLocaleString('en-US')} NQ passages, passage text only, top ${K}.`, rows: b.queries.map((q: any, i: number) => ({ q: q._id, r: b.text[i].slice(0, K).map((x: any) => [x.id, x.score]) })) },
  { id: 'nq-bm25-title', name: 'BM25, title + text', notes: `BM25 over all ${b.N.toLocaleString('en-US')} NQ passages with the article title indexed alongside the text, top ${K}. The rerank column is the cross-encoder score of each logged passage.`, rows: b.queries.map((q: any, i: number) => ({ q: q._id, r: b.titleText[i].slice(0, K).map((x: any) => [x.id, x.score, ce[i].get(x.id)]) })) },
  { id: 'nq-bm25-ce', name: 'BM25 top 100 + cross-encoder rerank', notes: `BM25 (title + text) top 100, reranked by cross-encoder/ms-marco-MiniLM-L-6-v2, top ${K}. Scores are cross-encoder logits.`, rows: b.queries.map((q: any, i: number) => ({ q: q._id, r: [...r.rerank[i]].sort((x: any, y: any) => y.ce - x.ce).slice(0, K).map((x: any) => [x.id, x.ce]) })) },
]
const ids = new Set<string>()
for (const run of runs) for (const row of run.rows) for (const x of row.r) ids.add(x[0])
const qrels: Record<string, Record<string, number>> = {}
for (const q of b.queries) { qrels[q._id] = {}; for (const d of r.gold[q._id]) { qrels[q._id][d] = 1; ids.add(d) } }
const corpus = [...ids].sort((x, y) => +x.slice(3) - +y.slice(3)).map(id => ({ id, title: r.docs[id].title, text: r.docs[id].text }))
const out = {
  id: 'nq-beir', name: 'Natural Questions (BEIR), 80 test queries',
  source: 'BEIR NQ test split (Thakur et al., 2021), built from Natural Questions (Kwiatkowski et al., 2019) over English Wikipedia passages',
  url: 'https://huggingface.co/datasets/BeIR/nq', licence: 'CC BY-SA 4.0 (BEIR NQ as distributed); Natural Questions is CC BY-SA 3.0, Wikipedia text CC BY-SA', retrieved: '2026-11-13',
  selection: `Every 43rd test query starting at index ${b.offset ?? 7} (80 of 3,452). The corpus here is the pool of passages any run returned in its top ${K}, plus every judged-relevant passage: ${corpus.length} of ${b.N.toLocaleString('en-US')}.`,
  corpusSize: b.N,
  queries: b.queries.map((q: any) => ({ id: q._id, text: q.text })), qrels, corpus, runs,
}
writeFileSync(outPath, JSON.stringify(out))
console.log(corpus.length, 'passages', JSON.stringify(out).length, 'bytes')
