import { BASE, CORPUS, downloadText, expect, importFiles, kpi, newProject, openTab, PERFECT, QRELS, QUERIES, stored, test } from './fixtures.ts'

const TABS = ['Overview', 'Failures', 'Chunking', 'Rerank what-if', 'Regression', 'Label', 'History', 'Data']

for (const [id, name] of [['ledgerly', 'Ledgerly'], ['nq-beir', 'Natural Questions']] as const) test(`sample ${id} opens, is read-only, and every section and the report work`, async ({ page }) => {
  await page.goto(`/app?sample=${id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name)
  for (const t of TABS) { await openTab(page, t); await expect(page.locator('main')).not.toContainText('NaN') }
  await expect(page.getByRole('textbox', { name: 'Run name' }).first()).toBeDisabled()
  await page.getByRole('link', { name: 'Report', exact: true }).click()
  await expect(page.locator('.verdict-head b')).toHaveText(/^(Ship|No ship)$/)
})

test('importing into a sample starts a new project and leaves the sample alone', async ({ page }) => {
  await page.goto('/app?sample=ledgerly')
  await openTab(page, 'Data')
  await importFiles(page, BASE)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('My RAG eval')
  const s = await stored(page)
  expect(s.projects.map(p => p.sampleId).sort()).toEqual(['ledgerly', undefined])
  expect(Object.values(s.data).map(d => d.runs.map(r => r.name))).toEqual([['base']])
})

test('labels made from the keyboard score the run and survive a reload', async ({ page }) => {
  await newProject(page)
  await importFiles(page, CORPUS, { name: 'run.jsonl', text: '{"query_id":"q1","query":"hello","retrieved":["c9","c1"]}\n' })
  await openTab(page, 'Label')
  await expect(page.locator('#cand-1')).toBeVisible()
  await page.keyboard.press('0')
  await expect(page.getByRole('radiogroup', { name: 'Relevance of c9' }).getByRole('radio', { name: '0' })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('3')
  await expect(page.getByRole('radiogroup', { name: 'Relevance of c1' }).getByRole('radio', { name: '3' })).toHaveAttribute('aria-checked', 'true')
  await openTab(page, 'Overview')
  await expect(kpi(page, 'MRR')).toHaveText('0.500')
  await page.reload()
  await expect(kpi(page, 'MRR')).toHaveText('0.500')
})

test('projects, settings, snapshots and data survive a reload; delete can be undone', async ({ page }) => {
  await newProject(page)
  await importFiles(page, CORPUS, QUERIES, QRELS, BASE, PERFECT)
  await openTab(page, 'Overview')
  await page.getByLabel('k for triage').selectOption('10')
  await page.getByLabel('Run under study').selectOption({ label: 'base' })
  await page.getByRole('button', { name: 'Snapshot' }).click()
  await expect(page.getByText('Saved a snapshot of base')).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('k for triage')).toHaveValue('10')
  await expect(kpi(page, 'nDCG@10')).toHaveText('0.463')
  await openTab(page, 'History')
  await expect(page.getByRole('rowheader', { name: /^base · / })).toBeVisible()
  await page.goto('/app')
  await page.getByRole('button', { name: 'Delete' }).click()
  await page.getByRole('button', { name: 'Delete project' }).click()
  await expect(page.getByRole('heading', { name: 'Try a sample' })).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click()
  await page.getByRole('link', { name: 'RAG eval 1' }).click()
  await expect(kpi(page, 'nDCG@10')).toHaveText('0.463')
  await page.reload()
  await expect(kpi(page, 'nDCG@10')).toHaveText('0.463')
})

test('export all holds the project and its dataset', async ({ page }) => {
  await newProject(page)
  await importFiles(page, CORPUS, QRELS, BASE)
  await page.goto('/settings')
  const { text } = await downloadText(page, () => page.getByRole('button', { name: 'Export all my data (JSON)' }).click())
  const j = JSON.parse(text)
  expect(j.app).toBe('rag-eval')
  expect(j.projects[0].dataset.runs[0].rows).toHaveLength(6)
  expect(j.projects[0].dataset.corpus).toHaveLength(9)
})

test('public pages load, unknown routes and projects say so, and only fonts are requested from outside', async ({ page, external }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.goto('/docs')
  await expect(page.getByRole('heading', { name: 'Getting your data in' })).toBeVisible()
  await page.goto('/app/p/not-a-project')
  await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible()
  await page.goto('/nope/nothing')
  await expect(page.getByRole('heading', { name: 'Zero hits for this page' })).toBeVisible()
  expect([...new Set(external)].every(h => h.startsWith('fonts.'))).toBe(true)
})

test('a sample that cannot be downloaded says so instead of showing scores', async ({ page }) => {
  await page.route('**/samples/nq-beir-80.json', r => r.fulfill({ status: 500, body: '' }))
  await page.goto('/app?sample=nq-beir')
  await expect(page.getByText('Could not load the sample. Check your connection and try again.')).toBeVisible()
})
