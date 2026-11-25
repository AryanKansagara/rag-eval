import { readFileSync } from 'node:fs'
import { BASE, CORPUS, downloadText, expect, importFiles, jsonl, kpi, newProject, offer, openTab, QRELS, QUERIES, row, stored, test, type F } from './fixtures.ts'

const fx = (n: string) => readFileSync(new URL(`../src/engine/fixtures/${n}`, import.meta.url), 'utf8')

// q1's gold is c1, logged second in every format, so MRR is 1/2 each time.
const RUNS: { f: F; label: RegExp }[] = [
  { label: /^Retrieval log \(JSONL/, f: { name: 'a.jsonl', text: jsonl(row('q1', ['c9', 'c1'])) } },
  { label: /^Retrieval log \(JSONL/, f: { name: 'b.json', text: JSON.stringify({ data: [{ query_id: 'q1', results: ['c9', 'c1'] }] }, null, 2) } },
  // Rows out of order: the rank column decides. CRLF and a BOM must not matter.
  { label: /^Retrieval log \(CSV/, f: { name: 'long-run.csv', text: '﻿query_id,rank,chunk_id,score\r\nq1,2,c1,0.5\r\nq1,1,c9,0.6\r\n' } },
  { label: /^Retrieval log \(CSV/, f: { name: 'wide-run.csv', text: 'query_id,retrieved_ids\nq1,c9|c1\n' } },
  { label: /^Retrieval log \(CSV/, f: { name: 'semicolon-run.csv', text: 'query_id;rank;chunk_id\nq1;1;c9\nq1;2;c1\n' } },
  { label: /^TREC run/, f: { name: 'a.run', text: '# a comment\nq1 Q0 c1 2 0.5 tag\nq1\tQ0 c9 1 0.6 tag\n' } },
  { label: /^LangChain/, f: { name: 'ls.jsonl', text: jsonl({ id: 'r1', run_type: 'retriever', inputs: { query: 'hello' }, outputs: { documents: [{ page_content: 'x', metadata: { chunk_id: 'c9' } }, { page_content: 'y', metadata: { chunk_id: 'c1' } }] }, extra: { metadata: { query_id: 'q1' } } }) } },
  { label: /^LlamaIndex/, f: { name: 'li.jsonl', text: jsonl({ query_id: 'q1', response: 'ok', source_nodes: [{ node: { id_: 'c9', text: 'x' }, score: 0.9 }, { node: { id_: 'c1', text: 'y' }, score: 0.8 }] }) } },
  // Contexts as text are matched to the corpus.
  { label: /^Ragas/, f: { name: 'ragas.jsonl', text: jsonl({ query_id: 'q1', user_input: 'hello', retrieved_contexts: ['Passage number 9 about topic9', 'Passage number 1 about topic1'] }) } },
]
for (const { f, label } of RUNS) test(`run format: ${f.name}`, async ({ page }) => {
  await newProject(page)
  await importFiles(page, CORPUS, { name: 'qrels.trec.qrels', text: 'q1 0 c1 1\n' })
  const panel = await offer(page, f)
  await expect(panel.getByLabel('Detected as').locator('option:checked')).toHaveText(label)
  await expect(panel.locator('.issues')).toHaveCount(0)
  await panel.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(panel).toBeHidden()
  await openTab(page, 'Overview')
  await expect(kpi(page, 'MRR')).toHaveText('0.500')
})

const JUDGMENTS: F[] = [
  { name: 'beir.tsv', text: 'query-id\tcorpus-id\tscore\nq1\tc1\t1\n' },
  { name: 'qrels.txt', text: 'q1 0 c1 1\n' },
  { name: 'labels.csv', text: 'query_id,chunk_id,relevance\nq1,c1,1\n' },
  { name: 'qrels.jsonl', text: jsonl({ query_id: 'q1', chunk_id: 'c1', relevance: 1 }) },
]
for (const f of JUDGMENTS) test(`judgment format: ${f.name}`, async ({ page }) => {
  await newProject(page)
  await importFiles(page, f, { name: 'run.jsonl', text: jsonl(row('q1', ['c9', 'c1'])) })
  await openTab(page, 'Overview')
  await expect(kpi(page, 'MRR')).toHaveText('0.500')
})

test('trec_eval fixture files reproduce the published figures', async ({ page }) => {
  await newProject(page)
  // trec_eval's own expected output for this pair: P_5 0.2667, recip_rank 0.4064, ndcg_cut_10 0.3016 (binary grades).
  await importFiles(page, { name: 'qrels.test', text: fx('trec_eval.qrels.test') }, { name: 'results.test', text: fx('trec_eval.results.test') })
  await openTab(page, 'Overview')
  await expect(kpi(page, 'Precision@5')).toHaveText('0.267')
  await expect(kpi(page, 'MRR')).toHaveText('0.406')
  await expect(kpi(page, 'nDCG@10')).toHaveText('0.302')
})

test('a column the importer cannot guess is mapped by hand', async ({ page }) => {
  await newProject(page)
  const panel = await offer(page, { name: 'mystery-run.csv', text: 'ask,found,place\nq1,c9,1\nq1,c1,2\n' })
  await expect(panel.getByRole('button', { name: 'Fix the mapping first' })).toBeDisabled()
  await expect(panel).toContainText('Map a column to "Query id"')
  await panel.getByLabel('Query id *').selectOption('ask')
  await panel.getByLabel('Retrieved chunk id').selectOption('found')
  await panel.locator('label.field').filter({ has: page.locator('span').getByText('Rank', { exact: true }) }).locator('select').selectOption('place')
  await expect(panel).toContainText('1 queries, 2 rows')
  await panel.getByRole('button', { name: 'Import', exact: true }).click()
  await expect.poll(async () => Object.values((await stored(page)).data)[0]?.runs[0]?.rows[0].retrieved.map(x => x.id)).toEqual(['c9', 'c1'])
})

test('an empty file says so and is not offered for import', async ({ page }) => {
  await newProject(page)
  await page.locator('input[type=file]').setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.from('') })
  await expect(page.getByText('empty.csv is empty')).toBeVisible()
  await expect(page.locator('.panel.pending')).toHaveCount(0)
})

for (const f of [
  { name: 'notes.txt', text: 'Dear team, here are some notes.\nNothing else.\n' },
  { name: 'array.json', text: '[]' },
  { name: 'object.json', text: '{"hello":"world"}' },
  { name: 'cut.json', text: '[{"query_id":"q1","retrieved":["c1"' },
  { name: 'header-only.csv', text: 'query_id,rank,chunk_id\n' },
  { name: 'binary.jsonl', text: '\u0000\u0001\u0002��' },
]) test(`wrong or truncated file is refused: ${f.name}`, async ({ page }) => {
  await newProject(page)
  const panel = await offer(page, f)
  await expect(panel.getByRole('button', { name: 'Fix the mapping first' })).toBeDisabled()
})

test('bad rows are listed with their line numbers and left out', async ({ page }) => {
  await newProject(page)
  const panel = await offer(page, { name: 'run.csv', text: 'query_id,rank,chunk_id\nq1,1,c9\n,2,c1\nq1,3,\n' })
  await expect(panel.locator('.issues')).toContainText('line 3Missing query id')
  await expect(panel.locator('.issues')).toContainText('line 4Missing retrieved chunk id')
  await expect(panel).toContainText('2 skipped')
  await panel.getByRole('button', { name: 'Import 1 good rows' }).click()
  await expect(page.getByText(/skipped 2 rows/)).toBeVisible()
})

test('a run with nothing judged shows dashes, not scores', async ({ page }) => {
  await newProject(page)
  await importFiles(page, BASE)
  await openTab(page, 'Overview')
  await expect(page.getByText('6 queries in this run have no judgments')).toBeVisible()
  for (const m of ['nDCG@10', 'Recall@5', 'MRR']) await expect(kpi(page, m)).toHaveText('—')
})

test('downloaded files import again to the same scores', async ({ page }) => {
  await newProject(page)
  await importFiles(page, CORPUS, QUERIES, QRELS, BASE)
  const out: F[] = []
  for (const n of ['corpus.jsonl', 'queries.jsonl', 'qrels.tsv', 'base.jsonl']) out.push(await downloadText(page, () => page.getByRole('button', { name: n, exact: true }).click()))
  await newProject(page)
  await importFiles(page, ...out)
  await openTab(page, 'Overview')
  await expect(kpi(page, 'nDCG@10')).toHaveText('0.463')
  await expect(kpi(page, 'MAP')).toHaveText('0.396')
})

test('imported text is shown as text, never run as markup', async ({ page }) => {
  const evil = '<img src=x onerror="throw new Error(1)"><script>throw 2</script>'
  await newProject(page)
  await importFiles(page, { name: 'corpus.jsonl', text: jsonl({ chunk_id: 'c1', doc_id: 'd', text: evil }) }, { name: 'run.jsonl', text: jsonl({ query_id: 'q1', query: evil, retrieved: ['c1'], answer: evil }) })
  await openTab(page, 'Label')
  await expect(page.getByRole('heading', { name: evil })).toBeVisible()
  await openTab(page, 'Failures')
  await page.getByRole('button', { name: evil }).click()
  await expect(page.locator('.detail')).toContainText(evil)
  await expect(page.locator('main img, main script')).toHaveCount(0)
})
