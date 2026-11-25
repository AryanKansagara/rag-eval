import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE, cells, CORPUS, downloadText, expect, importFiles, jsonl, kpi, newProject, openTab, PERFECT, QRELS, QUERIES, row, test } from './fixtures.ts'

/*
 * Worked on paper from the definitions on the Docs page (gain 2^grade - 1, discount log2(rank + 1)).
 * Logged grades per rank; qD has only a 0 judgment and qE none, so the means are over qA, qB, qC and qF.
 *
 *   qA  0 3 0 1        of {3, 1}   R@5 1   R@10 1    P@5 2/5  Hit 1  RR 1/2  AP (1/2 + 2/4) / 2 = 0.5
 *                                  nDCG (7/log2(3) + 1/log2(5)) / (7 + 1/log2(3)) = 4.84719 / 7.63093 = 0.63520
 *   qB  1              of {1}      R@5 1   R@10 1    P@5 1/5  Hit 1  RR 1    AP 1                 nDCG 1
 *   qC  0 0 0 0 0 1    of {1, 1}   R@5 0   R@10 1/2  P@5 0    Hit 0  RR 1/6  AP (1/6) / 2 = 0.08333
 *                                  nDCG (1/log2(7)) / (1 + 1/log2(3)) = 0.35621 / 1.63093 = 0.21841
 *   qF  0              of {1}      all 0
 *
 *   means: nDCG 1.85361/4 = 0.463   R@5 2/4 = 0.500   R@10 2.5/4 = 0.625   P@5 0.6/4 = 0.150
 *          Hit 2/4 = 0.500   MRR 1.66667/4 = 0.417   MAP 1.58333/4 = 0.396
 */
const HAND: [string, string][] = [['nDCG@10', '0.463'], ['Recall@5', '0.500'], ['Recall@10', '0.625'], ['Precision@5', '0.150'], ['Hit@5', '0.500'], ['MRR', '0.417'], ['MAP', '0.396']]

test('every headline metric matches the hand-worked example, with exponential and linear gain', async ({ page }) => {
  const url = await newProject(page)
  await importFiles(page, CORPUS, QUERIES, QRELS, BASE)
  await openTab(page, 'Overview')
  for (const [label, value] of HAND) await expect(kpi(page, label), label).toHaveText(value)
  await expect(page.getByText('Means over 4 queries with at least one relevant item (grade 1+); 1 labelled queries have no gold and 1 are unlabelled.')).toBeVisible()
  await expect(page.getByText('1 queries in this run have no judgments')).toBeVisible()

  // Slices: billing is qA and qB, so nDCG@10 (0.63520 + 1) / 2 = 0.818; account is qC and qF, 0.21841 / 2 = 0.109.
  expect(await cells(page, 'billing')).toEqual(['2', '', '0.818'])
  expect(await cells(page, 'account')).toEqual(['2', '', '0.109'])

  // Linear gain only changes qA: (3/log2(3) + 1/log2(5)) / (3 + 1/log2(3)) = 2.32347 / 3.63093 = 0.63991, mean 1.85832/4 = 0.465.
  await page.goto('/settings')
  await page.getByLabel('nDCG gain').selectOption('linear')
  await page.goto(url)
  await expect(kpi(page, 'nDCG@10')).toHaveText('0.465')
  await expect(kpi(page, 'MAP')).toHaveText('0.396')
})

test('each failure bucket holds the query it should, on screen and in the worklist CSV', async ({ page }) => {
  await newProject(page)
  await importFiles(page, CORPUS, QUERIES, QRELS, BASE)
  await openTab(page, 'Failures')
  for (const [label, n] of [['Gold not retrieved', 1], ['Retrieved but ranked low', 1], ['Answer cited the wrong chunk', 1], ['Query too vague (no gold)', 1], ['Not labelled yet', 1], ['Working', 1]] as const)
    await expect(page.getByRole('button', { name: `${n} ${label}` })).toBeVisible()
  const { text } = await downloadText(page, () => page.getByRole('button', { name: 'Download worklist CSV' }).click())
  const rows = text.trim().split('\n').map(l => l.split(','))
  expect(rows.slice(1).map(r => [r[0], r[2], r[4], r[5] === 'NaN' ? '' : r[5]])).toEqual([
    ['qF', 'not-retrieved', '', '0.0000'],
    ['qC', 'ranked-low', '6', '0.2184'],
    ['qB', 'wrong-citation', '1', '1.0000'],
    ['qD', 'no-gold', '', ''],
    ['qE', 'unlabelled', '', ''],
  ])
  // With k = 10 the gold at rank 6 is inside the cutoff, so qC is no longer ranked low.
  await page.getByLabel('k for triage').selectOption('10')
  await expect(page.getByRole('button', { name: '0 Retrieved but ranked low' })).toBeVisible()
})

test('regression: paired deltas, verdict both ways, and the report', async ({ page }) => {
  await newProject(page)
  await importFiles(page, CORPUS, QUERIES, QRELS, BASE, PERFECT)
  await openTab(page, 'Regression')
  // The perfect run scores 1 everywhere, so nDCG@10 gains 1 - 0.46340 = 0.537; qA, qC and qF improve and qB ties.
  const ndcg = await cells(page, 'nDCG@10')
  expect([ndcg[0], ndcg[1], ndcg[2], ndcg[6]]).toEqual(['0.463', '1.000', '+0.537', '3 / 0 / 1'])
  // Of the 8 sign patterns of three non-zero gains only +++ and --- are as extreme, so the exact p is 2/8.
  expect(Math.abs(Number(ndcg[5]) - 0.25)).toBeLessThan(0.04)
  // Precision@5 of a perfect run: (2/5 + 1/5 + 2/5 + 1/5) / 4 = 0.300.
  expect((await cells(page, 'Precision@5')).slice(0, 3)).toEqual(['0.150', '0.300', '+0.150'])
  await expect(page.locator('.verdict-head')).toContainText('Ship')
  await expect(page.locator('.verdict-head')).toContainText('4 shared queries')

  // The other way round, 0.463 is under the 0.5 nDCG floor and 0.500 under the 0.6 recall floor.
  await page.getByRole('button', { name: 'Swap' }).click()
  await expect(page.locator('.verdict-head b')).toHaveText('No ship')
  await expect(page.locator('.verdict')).toContainText('nDCG@10 0.463 is under the floor 0.5')
  await expect(page.locator('.verdict')).toContainText('Recall@5 0.500 is under the floor 0.6')
  await page.getByRole('link', { name: 'Printable report' }).click()
  await expect(page.getByRole('heading', { name: 'base vs perfect' })).toBeVisible()
  await expect(page.locator('.verdict-head b')).toHaveText('No ship')
  // qF fell from 1 to 0 and is the largest regression.
  await expect(page.getByRole('row', { name: /delete my account qF/ })).toContainText('0.000')
})

test('the downloaded CI gate agrees with the app on the same two runs', async ({ page }) => {
  await newProject(page)
  await importFiles(page, CORPUS, QRELS, BASE, PERFECT)
  await openTab(page, 'Regression')
  const dir = mkdtempSync(join(tmpdir(), 'rag-gate-'))
  try {
    for (const n of ['rag-thresholds.json', 'rag-gate.mjs', 'baseline.json', 'candidate.json']) writeFileSync(join(dir, n), (await downloadText(page, () => page.getByRole('button', { name: n, exact: true }).click())).text)
    const gate = (...a: string[]) => { try { return { code: 0, out: execFileSync(process.execPath, ['rag-gate.mjs', 'rag-thresholds.json', ...a], { cwd: dir, encoding: 'utf8' }) } } catch (e) { const x = e as { status: number; stdout: string }; return { code: x.status, out: x.stdout } } }
    expect(gate('baseline.json', 'candidate.json')).toMatchObject({ code: 0, out: expect.stringContaining('Ship: all checks passed') })
    const bad = gate('candidate.json', 'baseline.json')
    expect(bad.code).toBe(1)
    expect(bad.out).toContain('0.4634')
    expect(bad.out).toContain('No ship')
  } finally { rmSync(dir, { recursive: true }) }
})

test('doc level collapses chunks, and gold spans give grades, cut rate and the simulator', async ({ page }) => {
  // Document d is two 20-character chunks. s1 covers 0-20 and s2 covers 20-40.
  const a = 'aaaa bbbb cccc dddd ', b = 'eeee ffff gggg hhhh.'
  await newProject(page)
  await importFiles(page,
    { name: 'corpus.jsonl', text: jsonl({ chunk_id: 's1', doc_id: 'd', text: a, start: 0, end: 20 }, { chunk_id: 's2', doc_id: 'd', text: b, start: 20, end: 40 }, { chunk_id: 'x1', doc_id: 'x', text: 'unrelated', start: 0, end: 9 }) },
    // q1 needs 15-25, half in each chunk. q2 needs 0-8, all of it in s1.
    { name: 'gold.csv', text: 'query_id,doc_id,start,end\nq1,d,15,25\nq2,d,0,8\n' },
    { name: 'run.jsonl', text: jsonl(row('q1', ['x1', 's1', 's2']), row('q2', ['s1'])) })
  await openTab(page, 'Overview')
  // Doc level: q1 ranks docs x, d so RR is 1/2 and nDCG 1/log2(3) = 0.63093; q2 is perfect.
  await page.getByRole('radio', { name: 'Doc', exact: true }).click()
  await expect(kpi(page, 'MRR')).toHaveText('0.750')
  await expect(kpi(page, 'nDCG@10')).toHaveText('0.815')
  // Span level: s1 holds 5 of 10 characters, grade 2, at rank 2: (3/log2(3)) / 7 = 0.27040. q2 is 1. Mean 0.635.
  await page.getByRole('radio', { name: 'Gold span' }).click()
  await expect(kpi(page, 'nDCG@10')).toHaveText('0.635')
  await openTab(page, 'Chunking')
  await expect(kpi(page, 'Boundary-cut rate')).toHaveText('50.0%')
  await expect(page.getByText('1 of 2 gold spans split')).toBeVisible()
  // Whole 8-word documents fit in any simulated chunk, so nothing is cut.
  await expect(page.locator('.sim-result')).toContainText('0.0%')
  await expect(page.locator('.recommend')).toContainText('cuts 0.0% of gold answers (now 50.0%)')
})

test('rerank what-if reorders by the logged score and BM25 finds an unlogged exact match', async ({ page }) => {
  await newProject(page)
  await importFiles(page, CORPUS,
    { name: 'qrels.tsv', text: 'query-id\tcorpus-id\tscore\nq1\tc1\t1\n' },
    { name: 'run.jsonl', text: jsonl({ query_id: 'q1', query: 'topic1', retrieved: [{ id: 'c9', score: 0.9, rerank_score: 0.1 }, { id: 'c1', score: 0.8, rerank_score: 0.7 }] }) })
  await openTab(page, 'Rerank what-if')
  const mrr = async (r: string) => (await cells(page, r))[5].split('\n')[0]
  expect(await mrr('As logged')).toBe('0.500')
  expect(await mrr('Logged rerank scores')).toBe('1.000')
  expect(await mrr('BM25 only (local index)')).toBe('1.000')
  // RRF: c1 = 1/62 + 1/61 beats c9 = 1/61.
  expect(await mrr('Hybrid: logged ranking + BM25 (RRF)')).toBe('1.000')
  await expect(page.locator('.move').first()).toContainText('#2 → #1')
})
