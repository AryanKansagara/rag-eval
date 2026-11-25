// What the importer does with rows it cannot read.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoMap, FORMATS, qrelsToTsv, readFile, validate } from './parse.ts'

test('blank relevance is not a judgment, booleans are 1 and 0, and a span graded 0 is not gold', () => {
  const load = (name: string, text: string) => { const p = readFile(name, text); return validate(p, p.format, autoMap('qrels', p.headers)) }
  const csv = load('qrels.csv', 'query_id,chunk_id,relevance\nq1,a,\nq1,b,2\nq1,c, \n')
  assert.deepEqual(csv.fragment.qrels, { q1: { b: 2 } })
  assert.deepEqual([csv.ok, csv.skipped, csv.issues.map(i => [i.line, i.level])], [1, 2, [[2, 'error'], [4, 'error']]])
  const json = load('qrels.jsonl', '{"query_id":"q1","chunk_id":"a","label":false}\n{"query_id":"q1","chunk_id":"b","label":true}\n{"query_id":"q1","chunk_id":"c","label":null}\n{"query_id":"q1","chunk_id":"d"}\n')
  assert.deepEqual(json.fragment.qrels, { q1: { a: 0, b: 1 } })
  assert.equal(json.skipped, 2)
  // Without a grade column the default stays 1.
  assert.deepEqual(load('qrels.csv', 'query_id,chunk_id\nq1,a\n').fragment.qrels, { q1: { a: 1 } })
  const spans = load('gold.csv', 'query_id,doc_id,start,end,relevance\nq1,d,0,5,0\nq2,d,0,5,\nq3,d,0,5,3\n')
  assert.deepEqual(spans.fragment.spans!.map(s => s.queryId), ['q2', 'q3'])
  assert.deepEqual(spans.fragment.qrels, { q1: { d: 0 }, q2: { d: 1 }, q3: { d: 3 } })
  // The app's own export still imports whole: spans at grade 3 and a labelled query with no gold.
  const tsv = load('qrels.tsv', qrelsToTsv({ q1: { a: 0, b: 2 }, q2: {} }, [{ queryId: 'q3', docId: 'd', start: 1, end: 4 }]))
  assert.deepEqual(tsv.fragment, { qrels: { q1: { a: 0, b: 2 }, q2: {} }, spans: [{ queryId: 'q3', docId: 'd', start: 1, end: 4 }] })
})

test('unreadable JSON rows are errors with their line, count as skipped, and never throw', () => {
  const load = (name: string, text: string, format?: Parameters<typeof validate>[1]) => { const p = readFile(name, text), f = format ?? p.format; return { p, v: validate(p, f, autoMap(FORMATS[f].kind, p.headers)) } }
  const cut = load('corpus.jsonl', '{"chunk_id":"a","text":"x"}\n{"chunk_id":"b","te').v
  assert.deepEqual([cut.ok, cut.skipped, cut.issues.map(i => i.line)], [1, 1, [2]])
  for (const [text, lines] of [
    ['{"chunk_id":"a","text":"x"}\nnull\n7\n"s"\n[1]\ntrue\n{"chunk_id":"b","text":"y"}\n', [2, 3, 4, 5, 6]],
    ['[null,{"chunk_id":"a","text":"x"},5,{"chunk_id":"b","text":"y"}]', [1, 3]],
    ['{"data":[{"chunk_id":"a","text":"x"},null,{"chunk_id":"b","text":"y"}]}', [2]],
  ] as const) {
    const { v } = load('corpus.jsonl', text)
    assert.deepEqual(v.fragment.corpus!.map(c => c.id), ['a', 'b'])
    assert.deepEqual([v.ok, v.skipped, v.issues.map(i => i.line)], [2, lines.length, [...lines]])
  }
  // Nothing readable: no rows OK in any format, and a cut-off number list is not taken for TREC columns.
  for (const text of ['[null]', '[]', '[1,2]', '[1, 2, 3, 4', '{"a":', 'null', '{'])
    for (const f of Object.keys(FORMATS) as (keyof typeof FORMATS)[]) if (!FORMATS[f].label.startsWith('TREC')) assert.equal(load('data.json', text, f).v.ok, 0, `${text} as ${f}`)
  assert.equal(load('data.json', '[1, 2, 3, 4').v.ok, 0)
})

test('finite numbers in retrieved lists and Ragas id lists are ids; null and booleans are reported', () => {
  const load = (text: string) => { const p = readFile('run.jsonl', text); return validate(p, p.format, {}) }
  const ids = (v: ReturnType<typeof load>) => v.fragment.run!.rows[0].retrieved.map(x => x.id)
  const run = load('{"query_id":"q1","retrieved":[12,13,0,-1]}')
  assert.deepEqual([ids(run), run.issues], [['12', '13', '0', '-1'], []])
  const ragas = load('{"query_id":"q1","user_input":"x","retrieved_context_ids":[1,2],"reference_context_ids":[1]}')
  assert.deepEqual([ids(ragas), ragas.fragment.qrels, ragas.issues], [['1', '2'], { q1: { 1: 1 } }, []])
  const bad = load('{"query_id":"q1","retrieved":[12,null,true,false,"13"]}')
  assert.deepEqual(ids(bad), ['12', '13'])
  assert.match(bad.issues[0].message, /Some retrieved items had no id or text/)
  const badRefs = load('{"query_id":"q1","user_input":"x","retrieved_context_ids":[1],"reference_context_ids":[1,null,true]}')
  assert.deepEqual(badRefs.fragment.qrels, { q1: { 1: 1 } })
  assert.match(badRefs.issues[0].message, /Some reference contexts had no id or text/)
  // A number JSON cannot hold exactly is kept, with a warning that it may not match.
  assert.match(load('{"query_id":"q1","retrieved":[12345678901234567891]}').issues[0].message, /too large/)
})

test('with a | only | separates ids and tags, and tags are never split on spaces', () => {
  const load = (name: string, text: string, format?: Parameters<typeof validate>[1]) => { const p = readFile(name, text), f = format ?? p.format; return validate(p, f, autoMap(FORMATS[f].kind, p.headers)).fragment }
  const ids = (f: ReturnType<typeof load>) => f.run!.rows[0].retrieved.map(x => x.id)
  const tags = load('queries.csv', 'query_id,query,tags\nq1,x,getting started|billing\nq2,x,getting started\nq3,x,a b; c\nq4,x,\n')
  assert.deepEqual(tags.queries!.map(q => q.tags), [['getting started', 'billing'], ['getting started'], ['a b', 'c'], undefined])
  const wide = load('run.csv', 'query_id,retrieved_ids,cited\nq1,doc 1 | doc 2|,doc 1|doc 2\n')
  assert.deepEqual([ids(wide), wide.run!.rows[0].cited], [['doc 1', 'doc 2'], ['doc 1', 'doc 2']])
  // Without a | the old separators still work.
  assert.deepEqual(ids(load('run.csv', 'query_id,retrieved_ids\nq1,a b;c  d\n')), ['a', 'b', 'c', 'd'])
  assert.deepEqual(ids(load('run.jsonl', '{"query_id":"q1","retrieved_ids":"doc 1|doc 2"}', 'run-jsonl')), ['doc 1', 'doc 2'])
  assert.deepEqual(ids(load('run.jsonl', '{"query_id":"q1","retrieved_ids":["a",2]}', 'run-jsonl')), ['a', '2'])
})
