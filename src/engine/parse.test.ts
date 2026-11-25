// What the importer does with rows it cannot read.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { autoMap, qrelsToTsv, readFile, validate } from './parse.ts'

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
