// Tests against real public files: trec_eval's own fixture, a Ragas dataset excerpt and the BEIR NQ sample.
// Sources and licences are listed in fixtures/SOURCES.txt.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { applyWhatIf } from './analysis.ts'
import { evaluateRows, makeCtx, metric } from './metrics.ts'
import { autoMap, FORMATS, mergeFragment, readFile, validate } from './parse.ts'
import { buildPublicSample, questionWord, type PublicSampleFile } from './publicSample.ts'
import { emptyDataset } from './types.ts'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const load = (name: string, text: string, corpus = emptyDataset().corpus) => {
  const p = readFile(name, text)
  return { p, v: validate(p, p.format, autoMap(FORMATS[p.format].kind, p.headers), corpus) }
}
const near = (a: number, b: number, eps = 5e-5) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`)

// ---------- trec_eval ----------

test('trec_eval fixture: tab-separated run and qrels are detected and imported whole', () => {
  const q = load('qrels.test', fx('trec_eval.qrels.test')), r = load('results.test', fx('trec_eval.results.test'))
  assert.equal(q.p.format, 'qrels-trec')
  assert.equal(r.p.format, 'trec-run')
  assert.equal(q.v.ok, 3681)
  assert.equal(r.v.ok, 1500)
  assert.equal(q.v.issues.length + r.v.issues.length, 0)
  assert.equal(r.v.fragment.run!.rows.length, 3)
})

test('trec_eval fixture: metrics match the official output to four decimals', () => {
  const qrels = load('qrels.test', fx('trec_eval.qrels.test')).v.fragment.qrels!
  const rows = load('results.test', fx('trec_eval.results.test')).v.fragment.run!.rows
  const ms = ['map', 'mrr', 'precision@5', 'precision@10', 'precision@100', 'recall@5', 'recall@10', 'recall@100', 'ndcg@5', 'ndcg@10', 'ndcg@100']
  const ev = evaluateRows(makeCtx({ corpus: [], qrels, spans: [] }, 'chunk'), rows, ms, 1, 10)
  // test/out.test.aq: map, recip_rank, P_5, P_10, P_100, recall_5, recall_10, recall_100, ndcg_cut_5, ndcg_cut_10, ndcg_cut_100
  const official = [0.1785, 0.4064, 0.2667, 0.3, 0.2467, 0.0173, 0.0317, 0.498, 0.2768, 0.3016, 0.3916]
  ms.forEach((m, i) => near(ev.agg[m].mean, official[i]))
  const byQ = Object.fromEntries(ev.perQuery.map(q => [q.queryId, q.scores]))
  near(byQ['301'].map, 0.0324); near(byQ['302'].map, 0.4175); near(byQ['303'].map, 0.0858)
  near(byQ['301'].mrr, 0.1667); near(byQ['302'].mrr, 1); near(byQ['303'].mrr, 0.0526)
  near(byQ['302']['ndcg@10'], 0.753)
})

test('TREC files with comment lines and float relevance still parse', () => {
  const q = load('judgments.txt', '# pooled, depth 100\n301 0 FR940202-2-00150 1.0\n301 0 FR940202-2-00151 0.0\n')
  assert.equal(q.p.format, 'qrels-trec')
  assert.deepEqual(q.v.fragment.qrels, { '301': { 'FR940202-2-00150': 1, 'FR940202-2-00151': 0 } })
  const r = load('bm25.txt', '# run\n301\tQ0\tFR940202-2-00150\t1\t  2.129133\tSTANDARD\n')
  assert.equal(r.p.format, 'trec-run')
  assert.equal(r.v.fragment.run!.rows[0].retrieved[0].score, 2.129133)
})

test('nDCG gain: exponential by default, linear matches the trec_eval definition', () => {
  const j = { grades: [3, 2, 0, 1], ideal: [3, 2, 1] }
  // linear: (3 + 2/log2(3) + 1/log2(5)) / (3 + 2/log2(3) + 1/2)
  near(metric('ndcg@10', j, 1, true), (3 + 2 / Math.log2(3) + 1 / Math.log2(5)) / (3 + 2 / Math.log2(3) + 0.5), 1e-12)
  near(metric('ndcg@10', j, 1, true), 0.98544, 1e-5)
  // exponential: (7 + 3/log2(3) + 1/log2(5)) / (7 + 3/log2(3) + 1/2)
  near(metric('ndcg@10', j), 0.99262, 1e-5)
  // binary judgments give the same value either way
  const b = { grades: [0, 1, 1, 0], ideal: [1, 1, 1] }
  near(metric('ndcg@10', b), metric('ndcg@10', b, 1, true), 1e-12)
})

// ---------- BEIR ----------

// First lines of BEIR NQ queries.jsonl, corpus.jsonl and qrels/test.tsv (CC BY-SA).
const BEIR_QUERIES = '{"_id": "test0", "title": "", "text": "what is non controlling interest on balance sheet"}\n{"_id": "test1", "title": "", "text": "how many episodes are in chicago fire season 4"}\n{"_id": "test2", "title": "", "text": "who sings love will keep us alive by the eagles"}\n'
const BEIR_CORPUS = '{"_id": "doc0", "title": "Minority interest", "text": "In accounting, minority interest (or non-controlling interest) is the portion of a subsidiary corporation\'s stock that is not owned by the parent corporation. The magnitude of the minority interest in the subsidiary company is generally less than 50% of outstanding shares, or the corporation would generally cease to be a subsidiary of the parent.[1]"}\n'
const BEIR_QRELS = 'query-id\tcorpus-id\tscore\ntest0\tdoc0\t1\ntest0\tdoc1\t1\ntest1\tdoc6\t1\n'

test('BEIR queries.jsonl is read as queries, not as a corpus, whatever the file is called', () => {
  for (const name of ['queries.jsonl', 'nq.jsonl']) {
    const { p, v } = load(name, BEIR_QUERIES)
    assert.equal(p.format, 'queries', name)
    assert.deepEqual(v.fragment.queries!.map(q => q.id), ['test0', 'test1', 'test2'])
    assert.equal(v.fragment.queries![1].text, 'how many episodes are in chicago fire season 4')
  }
})

test('BEIR corpus.jsonl and qrels TSV import with titles and binary grades', () => {
  const c = load('corpus.jsonl', BEIR_CORPUS)
  assert.equal(c.p.format, 'corpus')
  assert.equal(c.v.fragment.corpus![0].title, 'Minority interest')
  const q = load('test.tsv', BEIR_QRELS)
  assert.equal(q.p.format, 'qrels')
  assert.deepEqual(q.v.fragment.qrels, { test0: { doc0: 1, doc1: 1 }, test1: { doc6: 1 } })
})

// ---------- Ragas ----------

test('Ragas rows with text-only contexts become a run plus readable chunks', () => {
  const { p, v } = load('amnesty_qa.jsonl', fx('ragas.amnesty_qa.jsonl'))
  assert.equal(p.format, 'ragas')
  const rows = v.fragment.run!.rows
  assert.equal(rows.length, 2)
  const ids = rows.flatMap(r => r.retrieved.map(x => x.id))
  // ids are short hashes, never the passage itself
  assert.ok(ids.every(id => /^h[0-9a-z]+$/.test(id)), ids.join(','))
  const corpus = v.fragment.corpus!
  assert.equal(corpus.length, new Set(ids).size)
  assert.ok(corpus.every(c => c.text.length > 40 && ids.includes(c.id)))
  assert.ok(rows[0].answer!.startsWith('The global implications'))
  assert.ok(v.issues.some(i => i.level === 'warning' && /added as chunks/.test(i.message)))
  // merged into a project, every retrieved id resolves to a chunk that can be labelled
  const ds = mergeFragment(emptyDataset(), v.fragment, { id: 'r', name: 'r', createdAt: 0 })
  const known = new Set(ds.corpus.map(c => c.id))
  assert.ok(ds.runs[0].rows.every(r => r.retrieved.every(x => known.has(x.id))))
})

test('Ragas contexts match an imported corpus by text, and reference contexts become judgments', () => {
  const first = JSON.parse(fx('ragas.amnesty_qa.jsonl').split('\n')[0])
  const corpus = [{ id: 'amnesty-12', docId: 'amnesty', text: first.retrieved_contexts[0] }]
  const row = { ...first, reference_contexts: [first.retrieved_contexts[0]] }
  const { v } = load('eval.jsonl', JSON.stringify(row) + '\n', corpus)
  const r = v.fragment.run!.rows[0]
  assert.equal(r.retrieved[0].id, 'amnesty-12')
  assert.deepEqual(v.fragment.qrels![r.queryId], { 'amnesty-12': 1 })
  // only the contexts that matched nothing are added
  assert.equal(v.fragment.corpus?.length ?? 0, first.retrieved_contexts.length - 1)
})

test('column-oriented JSON (Dataset.to_dict and pandas to_json) is read as rows', () => {
  const rows = fx('ragas.amnesty_qa.jsonl').trim().split('\n').map(l => JSON.parse(l))
  const keys = Object.keys(rows[0])
  const lists = Object.fromEntries(keys.map(k => [k, rows.map(r => r[k])]))
  const indexed = Object.fromEntries(keys.map(k => [k, Object.fromEntries(rows.map((r, i) => [i, r[k]]))]))
  for (const shape of [lists, indexed]) {
    const { p, v } = load('eval.json', JSON.stringify(shape))
    assert.equal(p.format, 'ragas')
    assert.equal(v.fragment.run!.rows.length, 2)
    assert.equal(v.fragment.run!.rows[1].query, rows[1].user_input)
  }
  // a single ordinary record is still one record
  assert.equal(load('one.json', JSON.stringify({ query_id: 'q1', retrieved: ['a', 'b'] })).v.fragment.run!.rows.length, 1)
})

// ---------- Public sample ----------

const nq = JSON.parse(readFileSync(new URL('../../public/samples/nq-beir-80.json', import.meta.url), 'utf8')) as PublicSampleFile

test('NQ sample: 80 queries, three full-depth runs, every id resolves', () => {
  const ds = buildPublicSample(nq)
  assert.equal(ds.queries.length, 80)
  assert.equal(Object.keys(ds.qrels).length, 80)
  assert.equal(ds.runs.length, 3)
  const known = new Set(ds.corpus.map(c => c.id))
  assert.equal(known.size, ds.corpus.length)
  for (const run of ds.runs) {
    assert.equal(run.rows.length, 80)
    for (const row of run.rows) {
      assert.equal(row.retrieved.length, 10)
      assert.ok(row.retrieved.every(x => known.has(x.id)))
      // logged order is score order
      assert.ok(row.retrieved.every((x, i, a) => i === 0 || a[i - 1].score! >= x.score!))
    }
  }
  assert.ok(Object.values(ds.qrels).every(j => Object.keys(j).length >= 1 && Object.keys(j).every(id => known.has(id))))
  assert.ok(ds.runs[1].rows.every(r => r.retrieved.every(x => typeof x.rerank === 'number')))
  assert.ok(nq.licence.includes('CC BY-SA') && nq.url.startsWith('https://'))
})

test('NQ sample: indexing titles helps BM25, and the cross-encoder rerank helps more', () => {
  const ds = buildPublicSample(nq)
  const ctx = makeCtx(ds, 'chunk')
  const [text, title, ce] = ds.runs.map(r => evaluateRows(ctx, r.rows, ['recall@10', 'ndcg@10', 'mrr'], 1, 200))
  assert.equal(text.scored.length, 80)
  // values computed independently when the runs were built
  near(text.agg['recall@10'].mean, 0.406, 1e-3)
  near(title.agg['recall@10'].mean, 0.456, 1e-3)
  assert.ok(ce.agg['ndcg@10'].mean > title.agg['ndcg@10'].mean && title.agg['ndcg@10'].mean > text.agg['ndcg@10'].mean)
  // reranking the logged top 10 by its logged cross-encoder scores cannot change recall@10, only the order
  const re = evaluateRows(ctx, applyWhatIf('rerank', ds.runs[1].rows), ['recall@10', 'mrr'], 1, 200)
  near(re.agg['recall@10'].mean, title.agg['recall@10'].mean, 1e-12)
  assert.ok(re.agg.mrr.mean > title.agg.mrr.mean)
})

test('NQ sample: passages group into Wikipedia articles and queries get a question-word intent', () => {
  const ds = buildPublicSample(nq)
  const docs = new Set(ds.corpus.map(c => c.docId))
  assert.ok(docs.size < ds.corpus.length && docs.size > 100)
  const chunk = evaluateRows(makeCtx(ds, 'chunk'), ds.runs[1].rows, ['hit@10'], 1, 50)
  const doc = evaluateRows(makeCtx(ds, 'doc'), ds.runs[1].rows, ['hit@10'], 1, 50)
  // finding the right article is never harder than finding the right passage
  assert.ok(doc.agg['hit@10'].mean >= chunk.agg['hit@10'].mean)
  assert.equal(questionWord('who sang the theme song for laverne and shirley'), 'who')
  assert.equal(questionWord('in order to prove disparate impact you first must establish'), 'other')
  assert.equal(questionWord('a synonym for the content component of communication is'), 'other')
  assert.ok(new Set(ds.queries.map(q => q.intent)).size >= 4)
})
