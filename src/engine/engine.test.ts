import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyWhatIf, bucketCounts, CI_SCRIPT, gateConfig, metricsExport, slices, toCsv, triage, verdict, worklistCsv } from './analysis.ts'
import { checkSpans, chunkText, cutRate, diagnose, rebuildDocs, recommend, sentences, simulate } from './chunks.ts'
import { bootstrap, compareEvals, evaluateRows, judge, makeCtx, metric, pairedTest, spanGrade, winsLosses } from './metrics.ts'
import { autoMap, mergeFragment, qrelsToTsv, readFile, runToJsonl, corpusToJsonl, validate } from './parse.ts'
import { buildSample } from './sample.ts'
import { bm25, jaccard, nearDuplicates, rrf, shingles } from './text.ts'
import { emptyDataset, type Chunk, type Dataset } from './types.ts'

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const R = (...ids: string[]) => ids.map(id => ({ id }))

// ---------- Metrics ----------

test('recall, precision, hit, MRR and MAP on a hand-checked list', () => {
  const j = { grades: [0, 1, 0, 1, 0], ideal: [1, 1, 1] }
  close(metric('recall@5', j), 2 / 3)
  close(metric('recall@1', j), 0)
  close(metric('precision@5', j), 2 / 5)
  close(metric('hit@1', j), 0)
  close(metric('hit@3', j), 1)
  close(metric('mrr', j), 1 / 2)
  // AP = (1/2 + 2/4) / 3
  close(metric('map', j), (0.5 + 0.5) / 3)
})

test('nDCG uses graded gains 2^g - 1 against the ideal ordering', () => {
  const j = { grades: [1, 3, 0], ideal: [3, 1] }
  const dcg = 1 / Math.log2(2) + 7 / Math.log2(3)
  const idcg = 7 / Math.log2(2) + 1 / Math.log2(3)
  close(metric('ndcg@10', j), dcg / idcg)
  close(metric('ndcg@10', { grades: [3, 1], ideal: [3, 1] }), 1)
})

test('queries with nothing relevant return NaN so they are excluded, not scored zero', () => {
  assert.ok(Number.isNaN(metric('ndcg@10', { grades: [0, 0], ideal: [] })))
  assert.ok(Number.isNaN(metric('recall@5', { grades: [1], ideal: [1] }, 2)), 'grade 1 is not relevant at minGrade 2')
})

test('chunk-level judging with doc-keyed (BEIR-style) qrels credits a doc only once', () => {
  const corpus: Chunk[] = [{ id: 'a#0', docId: 'a', text: 'x' }, { id: 'a#1', docId: 'a', text: 'y' }, { id: 'b#0', docId: 'b', text: 'z' }]
  const ctx = makeCtx({ corpus, qrels: { q: { a: 2 } }, spans: [] }, 'chunk')
  const j = judge(ctx, 'q', R('a#0', 'a#1', 'b#0'))
  assert.deepEqual(j.grades, [2, 0, 0])
  assert.deepEqual(j.ideal, [2])
})

test('doc-level judging dedupes chunks of the same doc and takes the max grade', () => {
  const corpus: Chunk[] = [{ id: 'a#0', docId: 'a', text: '' }, { id: 'a#1', docId: 'a', text: '' }, { id: 'b#0', docId: 'b', text: '' }]
  const ctx = makeCtx({ corpus, qrels: { q: { 'a#1': 3, 'a#0': 1, 'b#0': 1 } }, spans: [] }, 'doc')
  const j = judge(ctx, 'q', R('a#0', 'a#1', 'b#0'))
  assert.deepEqual(j.ids, ['a', 'b'])
  assert.deepEqual(j.grades, [3, 1])
  close(metric('ndcg@10', j), 1)
})

test('span-level grades a chunk by how much of the gold span it covers', () => {
  const s = { queryId: 'q', docId: 'd', start: 100, end: 200 }
  assert.equal(spanGrade({ id: 'c', docId: 'd', text: '', start: 50, end: 250 }, s), 3)
  assert.equal(spanGrade({ id: 'c', docId: 'd', text: '', start: 140, end: 300 }, s), 2)
  assert.equal(spanGrade({ id: 'c', docId: 'd', text: '', start: 180, end: 300 }, s), 1)
  assert.equal(spanGrade({ id: 'c', docId: 'd', text: '', start: 200, end: 300 }, s), 0, 'touching is not overlapping')
  assert.equal(spanGrade({ id: 'c', docId: 'other', text: '', start: 0, end: 999 }, s), 0)
})

test('bootstrap CI brackets the mean and is reproducible with a seed', () => {
  const xs = Array.from({ length: 60 }, (_, i) => (i % 5) / 4)
  const a = bootstrap(xs, 500, 3), b = bootstrap(xs, 500, 3)
  assert.deepEqual(a, b)
  assert.ok(a.lo < a.mean && a.mean < a.hi)
  const c = bootstrap(Array(30).fill(0.7))
  close(c.lo, 0.7); close(c.hi, 0.7)
})

test('paired tests: identical runs give p = 1, a consistent gain is significant', () => {
  const a = Array.from({ length: 40 }, (_, i) => 0.3 + (i % 7) / 20)
  const same = pairedTest(a, a)
  assert.equal(same.pBootstrap, 1); assert.equal(same.pRandom, 1); assert.equal(same.ties, 40)
  const better = pairedTest(a, a.map((x, i) => x + 0.05 + (i % 3) / 100))
  assert.ok(better.pRandom < 0.01 && better.pBootstrap < 0.01)
  assert.equal(better.wins, 40)
  assert.ok(better.lo > 0)
  const noisy = pairedTest(a, a.map((x, i) => x + (i % 2 ? 0.02 : -0.02)))
  assert.ok(noisy.pRandom > 0.5, 'symmetric noise is not significant')
})

// ---------- Text, BM25, fusion, MinHash ----------

test('BM25 ranks the chunk with the rare exact term first and matches its own score()', () => {
  const docs = [
    { id: '1', text: 'error codes and what they mean in general' },
    { id: '2', text: 'error INV-221 appears when a contact has no email' },
    { id: '3', text: 'invoices invoices invoices reminders' },
  ]
  const bm = bm25(docs)
  const res = bm.search('what does INV-221 mean')
  assert.equal(res[0].id, '2')
  close(res[0].score!, bm.score('what does INV-221 mean', '2'))
  assert.equal(bm.search('zzzz').length, 0)
})

test('RRF rewards items ranked well in both lists', () => {
  const fused = rrf([R('a', 'b', 'c'), R('c', 'a', 'd')], 60)
  assert.equal(fused[0].id, 'a')
  assert.deepEqual(fused.map(x => x.id).sort(), ['a', 'b', 'c', 'd'])
  close(fused[0].score!, 1 / 61 + 1 / 62)
})

test('MinHash LSH finds exact and near duplicates but not unrelated chunks', () => {
  const base = 'Reminders are sent three days before the due date and again seven fourteen and thirty days after it unless the invoice is paid in full by the customer'
  const chunks = [
    { id: 'a', text: base },
    { id: 'b', text: base.toUpperCase() },
    { id: 'c', text: base.replace('in full', 'completely') },
    { id: 'd', text: 'Bank feeds import up to ninety days of history when you first connect an account and refresh every four hours afterwards' },
  ]
  const pairs = nearDuplicates(chunks, 0.5)
  const key = (p: { a: string; b: string }) => [p.a, p.b].sort().join('-')
  assert.ok(pairs.some(p => key(p) === 'a-b' && p.exact))
  assert.ok(pairs.some(p => key(p) === 'a-c' && !p.exact))
  assert.ok(!pairs.some(p => p.a === 'd' || p.b === 'd'))
  close(jaccard(shingles(base), shingles(base)), 1)
})

// ---------- Chunks ----------

test('boundary-cut detection: whole, cut and missing spans', () => {
  const corpus: Chunk[] = [{ id: 'd#0', docId: 'd', text: '', start: 0, end: 100 }, { id: 'd#1', docId: 'd', text: '', start: 100, end: 200 }]
  const checks = checkSpans(corpus, [
    { queryId: 'q1', docId: 'd', start: 10, end: 50 },
    { queryId: 'q2', docId: 'd', start: 90, end: 120 },
    { queryId: 'q3', docId: 'x', start: 0, end: 5 },
  ])
  assert.deepEqual(checks.map(c => c.status), ['whole', 'cut', 'missing'])
  assert.deepEqual(checks[1].chunkIds, ['d#0', 'd#1'])
  close(cutRate(checks), 0.5)
})

test('fixed chunking honours size and overlap; sentence packing never splits a sentence', () => {
  const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} has six words.`).join(' ')
  const fixed = chunkText(text, { kind: 'fixed', size: 20, overlap: 5 })
  assert.equal(text.slice(fixed[0].s, fixed[0].e).split(/\s+/).length, 20)
  assert.equal(text.slice(fixed[1].s, fixed[1].e).split(' ')[0], text.split(' ')[15], 'second window starts 15 words in')
  const packed = chunkText(text, { kind: 'sentence', size: 20 })
  for (const r of packed) assert.ok(text.slice(r.s, r.e).endsWith('words.'))
  assert.equal(sentences('Version 3.5 is out. Next one! And\na line').length, 4, 'decimals do not end a sentence')
})

test('re-chunking simulator: sentence packing removes cuts that fixed windows cause', () => {
  const sents = Array.from({ length: 40 }, (_, i) => `This is filler sentence ${i} with a few extra words.`)
  const text = sents.join(' ')
  const spans = sents.map((s, i) => ({ queryId: 'q' + i, docId: 'd', start: text.indexOf(s), end: text.indexOf(s) + s.length }))
  const docs = [{ id: 'd', text, chunkIds: [], hasOffsets: true }]
  const fixed = simulate(docs, spans, { kind: 'fixed', size: 23, overlap: 0 })
  const sent = simulate(docs, spans, { kind: 'sentence', size: 25 })
  assert.ok(fixed.cutRate > 0.2)
  assert.equal(sent.cutRate, 0)
  assert.equal(recommend(docs, spans).best.cutRate, 0)
})

test('rebuildDocs reassembles overlapping chunks into the original text', () => {
  const text = 'alpha beta gamma delta epsilon zeta eta theta'
  const rs = chunkText(text, { kind: 'fixed', size: 3, overlap: 1 })
  const corpus = rs.map((r, i) => ({ id: 'd#' + i, docId: 'd', text: text.slice(r.s, r.e), start: r.s, end: r.e }))
  assert.equal(rebuildDocs(corpus)[0].text, text)
})

test('diagnose flags tiny and orphan chunks and mid-sentence starts', () => {
  const corpus: Chunk[] = [
    { id: 'a#0', docId: 'a', text: 'A long enough opening chunk '.repeat(10) },
    { id: 'a#1', docId: 'a', text: 'and this one starts mid sentence '.repeat(10) },
    { id: 'stub', docId: 'stub', text: 'This page moved.' },
  ]
  const d = diagnose(corpus, [])
  assert.deepEqual(d.tiny, ['stub'])
  assert.deepEqual(d.orphans, ['stub'])
  assert.deepEqual(d.midSentence, ['a#1'])
  assert.equal(d.sizes.n, 3)
})

// ---------- Import ----------

test('detects LangChain, LlamaIndex, Ragas, TREC and BEIR formats', () => {
  assert.equal(readFile('t.jsonl', JSON.stringify({ id: 'r1', run_type: 'retriever', inputs: { query: 'q' }, outputs: { documents: [{ page_content: 'x', metadata: { id: 'c1' } }] } })).format, 'langchain')
  assert.equal(readFile('t.json', JSON.stringify([{ query: 'q', source_nodes: [{ node: { id_: 'c1' }, score: 0.5 }] }])).format, 'llamaindex')
  assert.equal(readFile('t.jsonl', JSON.stringify({ user_input: 'q', retrieved_contexts: ['x'] })).format, 'ragas')
  assert.equal(readFile('run.txt', 'q1 Q0 d1 1 9.5 bm25\nq1 Q0 d2 2 8.1 bm25\n').format, 'trec-run')
  assert.equal(readFile('qrels.txt', 'q1 0 d1 2\nq1 0 d2 0\n').format, 'qrels-trec')
  assert.equal(readFile('test.tsv', 'query-id\tcorpus-id\tscore\nq1\td1\t1\n').format, 'qrels')
  assert.equal(readFile('chunks.csv', 'chunk_id,doc_id,text,start,end\nc1,d1,hello,0,5\n').format, 'corpus')
})

test('LangChain and LlamaIndex traces normalise to ranked rows; Ragas contexts match corpus text', () => {
  const lc = readFile('t.jsonl', JSON.stringify({ run_type: 'retriever', extra: { metadata: { query_id: 'q9' } }, inputs: { query: 'reset 2fa' }, outputs: { documents: [{ page_content: 'a', metadata: { chunk_id: 'c2' } }, { page_content: 'b', metadata: { chunk_id: 'c1' } }] } }))
  const v = validate(lc, lc.format, {})
  assert.deepEqual(v.fragment.run!.rows[0], { queryId: 'q9', query: 'reset 2fa', retrieved: R('c2', 'c1') })
  const li = readFile('t.json', JSON.stringify([{ query_id: 'q1', query: 'x', source_nodes: [{ node: { id_: 'n1' }, score: 0.9 }], response: 'ans' }]))
  assert.deepEqual(validate(li, li.format, {}).fragment.run!.rows[0].retrieved, [{ id: 'n1', score: 0.9 }])
  const corpus: Chunk[] = [{ id: 'k1', docId: 'd', text: 'Refunds take five days.' }]
  const rg = readFile('r.jsonl', JSON.stringify({ user_input: 'refund time', retrieved_contexts: ['refunds  take five days.', 'unknown text'] }))
  const vr = validate(rg, rg.format, {}, corpus)
  assert.equal(vr.fragment.run!.rows[0].retrieved[0].id, 'k1')
  assert.ok(vr.issues.some(i => /did not match/.test(i.message)))
})

test('CSV run log: groups rows per query, orders by rank, reports bad lines with line numbers', () => {
  const csv = 'query_id,query,rank,chunk_id,score,rerank_score\nq1,refund,2,c2,0.5,0.9\nq1,refund,1,c1,0.7,0.1\n,missing,1,c3,0.1,\nq2,fees,1,c9,0.4,\n'
  const p = readFile('run.csv', csv)
  assert.equal(p.format, 'run-csv')
  const map = autoMap('run', p.headers)
  assert.equal(map.rerank, 'rerank_score')
  const v = validate(p, 'run-csv', map)
  assert.deepEqual(v.fragment.run!.rows[0].retrieved.map(x => x.id), ['c1', 'c2'])
  assert.equal(v.fragment.run!.rows[0].retrieved[1].rerank, 0.9)
  assert.deepEqual(v.issues.filter(i => i.level === 'error').map(i => i.line), [4])
  assert.equal(v.skipped, 1)
})

test('qrels with gold answer text are located in the corpus to make spans; explicit zero rows stay labelled', () => {
  const corpus: Chunk[] = [{ id: 'd#0', docId: 'd', text: 'Intro text. Refunds take five days.', start: 0, end: 35 }]
  const p = readFile('gold.csv', 'query_id,doc_id,answer_text,relevance\nq1,d,Refunds take five days,\nq2,,,0\nq3,d,not in the doc,\n')
  const v = validate(p, 'qrels', autoMap('qrels', p.headers), corpus)
  assert.deepEqual(v.fragment.spans, [{ queryId: 'q1', docId: 'd', start: 12, end: 34 }])
  assert.deepEqual(v.fragment.qrels!.q2, {})
  assert.ok(v.issues.some(i => i.line === 4 && /not found/.test(i.message)))
})

test('sample round-trips through the exporters and importers unchanged', () => {
  const { ds } = buildSample()
  const run = ds.runs[0]
  const pr = readFile('run.jsonl', runToJsonl(run))
  assert.equal(pr.format, 'run-jsonl')
  assert.deepEqual(validate(pr, pr.format, {}).fragment.run!.rows.map(r => r.retrieved), run.rows.map(r => r.retrieved))
  const pc = readFile('corpus.jsonl', corpusToJsonl(ds.corpus))
  assert.deepEqual(validate(pc, 'corpus', autoMap('corpus', pc.headers)).fragment.corpus, ds.corpus)
  const pq = readFile('qrels.tsv', qrelsToTsv(ds.qrels, ds.spans))
  const vq = validate(pq, 'qrels', autoMap('qrels', pq.headers), ds.corpus)
  assert.deepEqual(vq.fragment.qrels, ds.qrels)
  assert.equal(vq.fragment.spans!.length, ds.spans.length)
  let merged: Dataset = mergeFragment(emptyDataset(), vq.fragment)
  merged = mergeFragment(merged, { run: { rows: run.rows } }, { id: 'r', name: 'r', createdAt: 0 })
  assert.equal(merged.queries.length, ds.queries.length, 'query text comes from the log')
})

// ---------- Sample, what-if, triage, regression ----------

test('sample has the promised shape: 60 docs (+ stubs), ~400 chunks, 80 labelled queries, two runs', () => {
  const { ds } = buildSample()
  const docs = new Set(ds.corpus.map(c => c.docId))
  assert.ok(docs.size >= 60 && docs.size <= 64)
  assert.ok(ds.corpus.length >= 360 && ds.corpus.length <= 460, `${ds.corpus.length} chunks`)
  assert.equal(Object.keys(ds.qrels).length, 80)
  assert.equal(ds.runs.length, 2)
  const cr = cutRate(checkSpans(ds.corpus, ds.spans))
  assert.ok(cr > 0.05, 'fixed chunks cut some answers')
})

test('hybrid what-if on the dense run reproduces the logged hybrid run, and beats dense significantly', () => {
  const { ds } = buildSample()
  const bm = bm25(ds.corpus)
  const ctx = makeCtx(ds, 'chunk')
  const dense = evaluateRows(ctx, ds.runs[0].rows, undefined, 1, 200)
  const sim = evaluateRows(ctx, applyWhatIf('hybrid', ds.runs[0].rows, { bm }), undefined, 1, 200)
  const logged = evaluateRows(ctx, ds.runs[1].rows, undefined, 1, 200)
  close(sim.agg['ndcg@10'].mean, logged.agg['ndcg@10'].mean)
  const cmp = compareEvals(dense, logged)
  assert.ok(cmp.tests['ndcg@10'].delta > 0 && cmp.tests['ndcg@10'].pRandom < 0.05)
  const rr = applyWhatIf('rerank', ds.runs[0].rows)
  assert.deepEqual(new Set(rr[0].retrieved.map(x => x.id)), new Set(ds.runs[0].rows[0].retrieved.map(x => x.id)), 'rerank only reorders')
  const wl = winsLosses(dense, logged, 'ndcg@10')
  assert.ok(wl[0].delta <= wl.at(-1)!.delta)
})

test('triage buckets: not retrieved, ranked low, wrong citation, no gold, unlabelled', () => {
  const corpus: Chunk[] = ['g1', 'g2', 'g3', 'x1', 'x2', 'x3'].map(id => ({ id, docId: id, text: id }))
  const ds = { corpus, qrels: { a: { g1: 3 }, b: { g2: 3 }, c: { g3: 3 }, d: {}, ok: { g1: 3 } }, spans: [] }
  const rows = [
    { queryId: 'a', retrieved: R('x1', 'x2') },
    { queryId: 'b', retrieved: R('x1', 'x2', 'x3', 'g2') },
    { queryId: 'c', retrieved: R('g3', 'x1'), cited: ['x1'] },
    { queryId: 'd', retrieved: R('x1') },
    { queryId: 'e', retrieved: R('x1') },
    { queryId: 'ok', retrieved: R('g1'), cited: ['g1'] },
  ]
  const ctx = makeCtx(ds, 'chunk')
  const t = triage(evaluateRows(ctx, rows), rows, ctx, [], 3)
  assert.deepEqual(t.map(r => r.bucket), ['not-retrieved', 'ranked-low', 'wrong-citation', 'no-gold', 'unlabelled', 'ok'])
  assert.equal(t[1].firstRank, 4)
  assert.equal(bucketCounts(t)['ranked-low'], 1)
  const csv = worklistCsv(t, new Map(), rows, new Map(), 'ndcg@10')
  assert.equal(csv.trim().split('\n').length, 1 + 5, 'ok queries are not on the worklist')
})

test('slices group scored queries by tag, intent and query length', () => {
  const corpus: Chunk[] = [{ id: 'g', docId: 'g', text: '' }]
  const ctx = makeCtx({ corpus, qrels: { a: { g: 1 }, b: { g: 1 } }, spans: [] }, 'chunk')
  const ev = evaluateRows(ctx, [{ queryId: 'a', retrieved: R('g') }, { queryId: 'b', retrieved: R('x') }])
  const qs = new Map([['a', { id: 'a', text: 'short one', tags: ['billing'], intent: 'how-to' }], ['b', { id: 'b', text: 'a much longer query with lots and lots of extra words in it', tags: ['billing'] }]])
  const s = slices(ev, qs, 'hit@5')
  const billing = s.find(x => x.dim === 'tag' && x.value === 'billing')!
  assert.equal(billing.n, 2); close(billing.mean, 0.5)
  assert.ok(s.some(x => x.dim === 'length' && x.value.startsWith('long') && x.mean === 0))
})

test('verdict: a significant drop past the allowed delta is no-ship; a floor breach is no-ship', () => {
  const { ds } = buildSample()
  const ctx = makeCtx(ds, 'chunk')
  const dense = evaluateRows(ctx, ds.runs[0].rows, undefined, 1, 200)
  const hybrid = evaluateRows(ctx, ds.runs[1].rows, undefined, 1, 200)
  assert.equal(verdict(dense, hybrid, [{ metric: 'ndcg@10', maxDrop: 0.01 }]).ship, true)
  const back = verdict(hybrid, dense, [{ metric: 'ndcg@10', maxDrop: 0.01 }])
  assert.equal(back.ship, false)
  assert.match(back.checks[0].reason, /dropped/)
  assert.equal(verdict(dense, hybrid, [{ metric: 'ndcg@10', min: 0.99 }]).ship, false)
})

test('the CI gate script passes a better candidate and fails a regression (exit code 1)', () => {
  const { ds } = buildSample()
  const ctx = makeCtx(ds, 'chunk')
  const ms = ['ndcg@10', 'recall@5']
  const dense = metricsExport('v1', evaluateRows(ctx, ds.runs[0].rows, ms, 1, 100), ms)
  const hybrid = metricsExport('v2', evaluateRows(ctx, ds.runs[1].rows, ms, 1, 100), ms)
  const dir = mkdtempSync(join(tmpdir(), 'gate-'))
  const f = (n: string, o: unknown) => { const p = join(dir, n); writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o)); return p }
  const script = f('rag-gate.mjs', CI_SCRIPT), cfg = f('t.json', gateConfig([{ metric: 'ndcg@10', maxDrop: 0.01 }, { metric: 'recall@5', min: 0.3 }]))
  const out = execFileSync(process.execPath, [script, cfg, f('a.json', dense), f('b.json', hybrid)], { encoding: 'utf8' })
  assert.match(out, /Ship: all checks passed/)
  assert.throws(() => execFileSync(process.execPath, [script, cfg, f('c.json', hybrid), f('d.json', dense)], { stdio: 'pipe' }), (e: { status: number }) => e.status === 1)
})

test('toCsv quotes commas, quotes and newlines and blanks non-finite numbers', () => {
  assert.equal(toCsv([['a,b', 'say "hi"', NaN, 'x\ny']]), '"a,b","say ""hi""",,"x\ny"\n')
})
