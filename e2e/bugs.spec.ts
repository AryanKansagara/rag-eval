import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE, CORPUS, downloadText, expect, importFiles, jsonl, kpi, newProject, offer, openTab, PERFECT, QRELS, row, stored, test } from './fixtures.ts'

// Known app bugs. Each test states the right behaviour and names its issue; drop `.fail` when the bug is fixed.

const onlyData = async (page: Parameters<typeof stored>[0]) => Object.values((await stored(page)).data)[0]

test('#2 a deleted run leaves the list at once and the next import does not bring it back', async ({ page }) => {
  await newProject(page)
  await importFiles(page, QRELS, BASE, PERFECT)
  const names = page.getByRole('textbox', { name: 'Run name' })
  await page.locator('.run-list li').first().getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('button', { name: 'Delete run' }).click()
  await expect(page.getByText('Deleted base')).toBeVisible()
  await importFiles(page, { name: 'third.jsonl', text: jsonl(row('qA', ['c1'])) })
  expect((await onlyData(page)).runs.map(r => r.name)).toEqual(['perfect', 'third'])
  await expect(names).toHaveCount(2)
})

test('#2 two files imported at the same moment are both kept', async ({ page }) => {
  await newProject(page)
  await offer(page, BASE)
  await offer(page, PERFECT)
  await page.evaluate(() => document.querySelectorAll<HTMLButtonElement>('.pending .btn.primary').forEach(b => b.click()))
  await expect(page.locator('.pending')).toHaveCount(0)
  expect((await onlyData(page)).runs.map(r => r.name)).toEqual(['base', 'perfect'])
  expect((await stored(page)).projects[0].imports.map(i => i.fileName)).toEqual(['base.jsonl', 'perfect.jsonl'])
})

test('#2 clear and rename show at once, and Undo keeps what was imported since', async ({ page }) => {
  await newProject(page)
  await importFiles(page, QRELS, BASE)
  const name = page.getByRole('textbox', { name: 'Run name' })
  await name.fill('renamed')
  await name.blur()
  await expect(page.getByRole('button', { name: 'renamed.jsonl' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear all data' }).click()
  await page.getByRole('button', { name: 'Clear data' }).click()
  await expect(page.getByText('No runs yet.')).toBeVisible()
  await importFiles(page, PERFECT)
  expect((await onlyData(page)).runs.map(r => r.name)).toEqual(['perfect'])
  await page.getByText('Data cleared').locator('..').getByRole('button', { name: 'Undo' }).click()
  await expect(name).toHaveCount(2)
  await page.reload()
  const d = await onlyData(page)
  expect(d.runs.map(r => r.name)).toEqual(['renamed', 'perfect'])
  expect(Object.keys(d.qrels)).toHaveLength(5)
})

test('#2 double-clicking Import on a sample makes one project', async ({ page }) => {
  await page.goto('/app?sample=ledgerly')
  await openTab(page, 'Data')
  const panel = await offer(page, BASE)
  await panel.getByRole('button', { name: 'Import', exact: true }).dblclick()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('My RAG eval')
  await page.waitForTimeout(300)
  const s = await stored(page)
  expect(s.projects).toHaveLength(2)
  expect(Object.values(s.data).map(d => d.runs.length)).toEqual([1])
})

test('#2 two files imported at the same moment from a sample land in one new project', async ({ page }) => {
  await page.goto('/app?sample=ledgerly')
  await openTab(page, 'Data')
  await offer(page, BASE)
  await offer(page, PERFECT)
  await page.evaluate(() => document.querySelectorAll<HTMLButtonElement>('.pending .btn.primary').forEach(b => b.click()))
  await expect(page.locator('.pending')).toHaveCount(0)
  expect(Object.values((await stored(page)).data).map(d => d.runs.map(r => r.name))).toEqual([['base', 'perfect']])
})

test('#3 grades entered in quick succession are all kept', async ({ page }) => {
  await newProject(page)
  await importFiles(page, CORPUS, { name: 'run.jsonl', text: jsonl(row('q1', ['c1', 'c2', 'c3', 'c4'])) })
  await openTab(page, 'Label')
  await expect(page.locator('#cand-3')).toBeVisible()
  // Only microtasks run between the keys, as between real events, so no storage write can finish in time to hide the bug.
  await page.evaluate(async () => { for (const key of ['3', '2', '1', '0']) { dispatchEvent(new KeyboardEvent('keydown', { key })); for (let i = 0; i < 5; i++) await Promise.resolve() } })
  await expect.poll(async () => Object.keys((await stored(page)).projects[0].labels)).toEqual(['q1'])
  await page.waitForTimeout(300)
  expect((await stored(page)).projects[0].labels).toEqual({ q1: { c1: 3, c2: 2, c3: 1, c4: 0 } })
})

test('#3 a threshold is stored as typed', async ({ page }) => {
  await newProject(page)
  await importFiles(page, QRELS, BASE, PERFECT)
  await openTab(page, 'Regression')
  const floor = page.getByLabel('Floor for nDCG@10')
  await floor.click()
  await floor.press('ControlOrMeta+a')
  // All four characters land before any storage write can finish, however slow the machine is.
  await page.evaluate(() => { for (const c of '0.75') document.execCommand('insertText', false, c) })
  await expect(floor).toHaveValue('0.75')
  await expect.poll(async () => (await stored(page)).projects[0].settings.thresholds[0].min).toBe(0.75)
  // alpha too, which used to jump back to 0.05 after the first 0.
  const alpha = page.getByLabel('alpha')
  await alpha.click()
  await alpha.press('ControlOrMeta+a')
  await alpha.pressSequentially('0.01')
  await expect.poll(async () => (await stored(page)).projects[0].settings.alpha).toBe(0.01)
  await alpha.fill('')
  await alpha.blur()
  await expect(alpha).toHaveValue('0.01')
})

test('#3 Undo of one change keeps the changes made after it', async ({ page }) => {
  await newProject(page)
  await importFiles(page, CORPUS, { name: 'run.jsonl', text: jsonl(row('q1', ['c1']), row('q2', ['c2'])) })
  await openTab(page, 'Label')
  await page.getByRole('button', { name: 'No relevant chunk' }).click()
  await page.getByRole('radiogroup', { name: 'Relevance of c2' }).getByRole('radio', { name: '3' }).click()
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.getByLabel('k for triage').selectOption('10')
  await page.reload()
  await expect(page.getByLabel('k for triage')).toHaveValue('10')
  const [p] = (await stored(page)).projects
  expect(p.labels).toEqual({ q2: { c2: 3 } })
  expect(p.settings.k).toBe(10)
})

test('#4 a candidate that shares no judged query with the baseline does not ship', async ({ page }) => {
  await newProject(page)
  await importFiles(page, QRELS, BASE, { name: 'other.jsonl', text: jsonl(row('zz', ['c1'])) })
  await openTab(page, 'Regression')
  for (const [i, l] of ['Floor for nDCG@10', 'Floor for Recall@5'].entries()) {
    await page.getByLabel(l).fill('')
    await expect.poll(async () => (await stored(page)).projects[0].settings.thresholds[i].min).toBeUndefined()
  }
  await expect(page.locator('.verdict-head b')).toHaveText('No ship')
  await expect(page.locator('.verdict')).toContainText('share no judged queries')
  await expect(page.locator('main')).not.toContainText('NaN')
})

test('#4 a candidate log cut off after the first query does not ship', async ({ page }) => {
  await newProject(page)
  await importFiles(page, QRELS, BASE, { name: 'cut.jsonl', text: jsonl(row('qA', ['c1', 'c2'])) })
  await openTab(page, 'Regression')
  await expect(page.locator('.verdict-head b')).toHaveText('No ship')
  await expect(page.locator('.verdict')).toContainText('The candidate has no scored result for 3 of the baseline\'s 4 judged queries.')
  await page.getByRole('link', { name: 'Printable report' }).click()
  await expect(page.locator('.verdict-head b')).toHaveText('No ship')
})

test('#5 a blank relevance is reported and not counted as relevant', async ({ page }) => {
  await newProject(page)
  const panel = await offer(page, { name: 'qrels.csv', text: 'query_id,chunk_id,relevance\nq1,c9,\nq1,c1,1\n' })
  await expect(panel.locator('.issues')).toContainText('line 2')
  await panel.getByRole('button', { name: 'Import 1 good rows' }).click()
  await importFiles(page, { name: 'run.jsonl', text: jsonl(row('q1', ['c9', 'c1'])) })
  await openTab(page, 'Overview')
  await expect(kpi(page, 'MRR')).toHaveText('0.500')
})

test('#5 relevance false is not relevant', async ({ page }) => {
  await newProject(page)
  await importFiles(page, { name: 'qrels.jsonl', text: jsonl({ query_id: 'q1', chunk_id: 'c9', label: false }, { query_id: 'q1', chunk_id: 'c1', label: true }) }, { name: 'run.jsonl', text: jsonl(row('q1', ['c9', 'c1'])) })
  await openTab(page, 'Overview')
  await expect(kpi(page, 'MRR')).toHaveText('0.500')
})

test('#6 the CI gate fails when the candidate metrics are missing', async ({ page }) => {
  await newProject(page)
  await importFiles(page, QRELS, BASE, PERFECT)
  await openTab(page, 'Regression')
  const dir = mkdtempSync(join(tmpdir(), 'rag-gate-'))
  try {
    for (const n of ['rag-gate.mjs', 'baseline.json']) writeFileSync(join(dir, n), (await downloadText(page, () => page.getByRole('button', { name: n, exact: true }).click())).text)
    writeFileSync(join(dir, 't.json'), JSON.stringify({ alpha: 0.05, thresholds: [{ metric: 'mrr', maxDrop: 0.03 }] }))
    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ run: 'x', queries: 0, metrics: {}, perQuery: {} }))
    let code = 0
    try { execFileSync(process.execPath, ['rag-gate.mjs', 't.json', 'baseline.json', 'empty.json'], { cwd: dir, stdio: 'pipe' }) } catch (e) { code = (e as { status: number }).status }
    expect(code).toBe(1)
  } finally { rmSync(dir, { recursive: true }) }
})

test('#7 a cut-off JSON line counts as skipped', async ({ page }) => {
  await newProject(page)
  const panel = await offer(page, { name: 'corpus.jsonl', text: '{"chunk_id":"a","text":"x"}\n{"chunk_id":"b","te' })
  await expect(panel.locator('.issues')).toContainText('line 2Not valid JSON')
  await expect(panel).toContainText('1 skipped')
  await expect(panel.getByRole('button', { name: 'Import 1 good rows' })).toBeVisible()
  await panel.getByRole('button', { name: 'Import 1 good rows' }).click()
  await expect(page.getByText('Imported corpus.jsonl: 1 chunks in 1 docs, skipped 1 rows')).toBeVisible()
  await expect(page.locator('.panel', { has: page.getByRole('heading', { name: 'Import history' }) })).toContainText('1 skipped')
})

test('#7 a null row is reported and does not blank the page', async ({ page }) => {
  await newProject(page)
  const panel = await offer(page, { name: 'corpus.jsonl', text: '{"chunk_id":"a","text":"x"}\nnull\n' })
  await expect(panel.locator('.issues')).toContainText('line 2')
  await expect(panel.locator('.issues')).toContainText('Expected a JSON object, got null')
})

test('#8 numeric chunk ids are kept', async ({ page }) => {
  await newProject(page)
  await importFiles(page, { name: 'qrels.csv', text: 'query_id,chunk_id,relevance\nq1,13,1\n' }, { name: 'run.jsonl', text: '{"query_id":"q1","retrieved":[12,13]}\n' })
  await openTab(page, 'Overview')
  await expect(kpi(page, 'MRR')).toHaveText('0.500')
})

test('#9 a quote that never closes is reported', async ({ page }) => {
  await newProject(page)
  const panel = await offer(page, { name: 'corpus.csv', text: 'chunk_id,doc_id,text\na,d,"hello\nb,d,world\nc,d,x\n' })
  await expect(panel.locator('.issues')).toContainText('line 2')
})

test('#10 ids with spaces stay whole when separated by |', async ({ page }) => {
  await newProject(page)
  await importFiles(page, { name: 'run.csv', text: 'query_id,retrieved_ids\nq1,doc 1|doc 2\n' })
  expect((await onlyData(page)).runs[0].rows[0].retrieved.map(x => x.id)).toEqual(['doc 1', 'doc 2'])
})

test('#11 a negative TREC judgment earns no gain', async ({ page }) => {
  await newProject(page)
  await importFiles(page, { name: 'qrels.txt', text: 'q1 0 a -2\nq1 0 b 1\n' }, { name: 'run.jsonl', text: jsonl(row('q1', ['a', 'b'])) })
  await openTab(page, 'Overview')
  // DCG 1/log2(3), ideal 1.
  await expect(kpi(page, 'nDCG@10')).toHaveText('0.631')
})

test('#12 labels are part of the qrels download', async ({ page }) => {
  await newProject(page)
  await importFiles(page, CORPUS, { name: 'run.jsonl', text: jsonl(row('q1', ['c1'])) })
  await openTab(page, 'Label')
  await expect(page.locator('#cand-0')).toBeVisible()
  await page.keyboard.press('3')
  await openTab(page, 'Data')
  await expect(page.getByRole('button', { name: 'qrels.tsv' })).toBeEnabled({ timeout: 3000 })
  const { text } = await downloadText(page, () => page.getByRole('button', { name: 'qrels.tsv' }).click())
  expect(text).toContain('q1\tc1\t3')
})

test('#12 the qrels download applies labels over imported judgments and scores the same in a new project', async ({ page }) => {
  await newProject(page)
  const run = { name: 'run.jsonl', text: jsonl(row('q1', ['c1', 'c2', 'c3']), row('q2', ['c4'])) }
  await importFiles(page, CORPUS, { name: 'qrels.tsv', text: 'query-id\tcorpus-id\tscore\nq1\tc1\t3\nq1\tc3\t1\nq2\tc4\t0\n' }, run)
  await openTab(page, 'Label')
  await page.getByRole('radio', { name: 'All queries' }).click()
  await expect(page.locator('#cand-0')).toBeVisible()
  // c1 drops from 3 to 0, c2 is judged 2, c3 keeps its imported grade.
  await page.keyboard.press('0')
  await page.keyboard.press('2')
  await expect.poll(async () => (await stored(page)).projects[0].labels).toEqual({ q1: { c1: 0, c2: 2 } })
  await openTab(page, 'Overview')
  const ndcg = await kpi(page, 'nDCG@10').innerText(), mrr = await kpi(page, 'MRR').innerText()
  await openTab(page, 'Data')
  const { text } = await downloadText(page, () => page.getByRole('button', { name: 'qrels.tsv' }).click())
  expect(text.trim().split('\n').slice(1).map(l => l.trim())).toEqual(['q1\tc1\t0', 'q1\tc3\t1', 'q1\tc2\t2', 'q2\tc4\t0'])

  await newProject(page)
  await importFiles(page, CORPUS, { name: 'qrels.tsv', text }, run)
  await openTab(page, 'Overview')
  await expect(kpi(page, 'nDCG@10')).toHaveText(ndcg)
  await expect(kpi(page, 'MRR')).toHaveText(mrr)
  expect(mrr).toBe('0.500')
})

test('#13 the worklist CSV never starts a cell with a formula', async ({ page }) => {
  await newProject(page)
  await importFiles(page, { name: 'run.jsonl', text: jsonl({ query_id: 'q1', query: '=1+1', retrieved: ['c1'] }) })
  await openTab(page, 'Failures')
  const { text } = await downloadText(page, () => page.getByRole('button', { name: 'Download worklist CSV' }).click())
  expect(text).toContain('q1,')
  expect(text.split('\n')[1].split(',')[1]).toBe("'=1+1")
})

test.fail('#14 a chunk that holds two gold spans has recall 1', async ({ page }) => {
  await newProject(page)
  await importFiles(page, { name: 'corpus.jsonl', text: jsonl({ chunk_id: 'c', doc_id: 'd', text: 'x'.repeat(100), start: 0, end: 100 }) }, { name: 'gold.csv', text: 'query_id,doc_id,start,end\nq,d,0,10\nq,d,50,60\n' }, { name: 'run.jsonl', text: jsonl(row('q', ['c'])) })
  await openTab(page, 'Overview')
  await page.getByRole('radio', { name: 'Gold span' }).click()
  await expect(kpi(page, 'Recall@5')).toHaveText('1.000')
})

test('#15 nothing is recommended when no gold span matches a document', async ({ page }) => {
  await newProject(page)
  await importFiles(page, { name: 'corpus.jsonl', text: jsonl({ chunk_id: 'c', doc_id: 'd', text: 'a b c', start: 0, end: 5 }) }, { name: 'gold.csv', text: 'query_id,doc_id,start,end\nq,other,0,3\n' }, { name: 'run.jsonl', text: jsonl(row('q', ['c'])) })
  await openTab(page, 'Chunking')
  await expect(page.getByRole('heading', { name: 'Re-chunking simulator' })).toBeVisible()
  await expect(page.locator('.recommend')).toHaveCount(0)
})

test('#15 a huge offset does not crash the Chunking tab', async ({ page }) => {
  await newProject(page)
  await importFiles(page, { name: 'corpus.jsonl', text: jsonl({ chunk_id: 'c', doc_id: 'd', text: 'a b c', start: 2e9, end: 2e9 + 5 }) })
  await openTab(page, 'Chunking')
  await expect(page.getByRole('heading', { name: 'Re-chunking simulator' })).toBeVisible()

})
