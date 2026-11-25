import { readFile } from 'node:fs/promises'
import { test as base, expect, type Page } from '@playwright/test'

/** The only outside hosts the page asks for: web fonts in index.html. They are answered with an empty stylesheet. */
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])

/** `pageErrors` collects uncaught errors, and any error fails the test. `external` lists blocked or stubbed hosts. */
export const test = base.extend<{ external: string[]; pageErrors: string[] }>({
  external: async ({}, use) => { await use([]) },
  pageErrors: async ({}, use) => { await use([]) },
  context: async ({ context, baseURL, external, pageErrors }, use) => {
    const origin = new URL(baseURL!).origin
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin === origin) return route.continue()
      external.push(url.host)
      if (FONT_HOSTS.has(url.host)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
      return route.abort('blockedbyclient')
    })
    context.on('weberror', e => pageErrors.push(String(e.error())))
    await use(context)
    expect(pageErrors, 'uncaught page errors').toEqual([])
    expect(external.filter(h => !FONT_HOSTS.has(h)), 'requests to outside hosts').toEqual([])
  },
})

export { expect }

export interface F { name: string; text: string }
export const jsonl = (...rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'

export async function newProject(page: Page): Promise<string> {
  await page.goto('/app')
  await page.getByRole('button', { name: /^(Import your data|New project)$/ }).click()
  await expect(page).toHaveURL(/\/app\/p\/[\w-]+\/data$/)
  await expect(page.getByRole('heading', { name: 'Import', exact: true })).toBeVisible()
  return page.url().replace(/\/data$/, '')
}

/** Puts a file in the importer and returns its panel, without importing it. */
export async function offer(page: Page, f: F) {
  await page.locator('input[type=file]').setInputFiles({ name: f.name, mimeType: 'text/plain', buffer: Buffer.from(f.text) })
  const panel = page.locator('.panel.pending').filter({ has: page.getByRole('heading', { name: f.name, exact: true }) })
  await expect(panel).toBeVisible()
  return panel
}

/** Imports files one by one, and waits until each one is in the import history and its data is what the page shows. */
export async function importFiles(page: Page, ...files: F[]) {
  const history = page.locator('.panel', { has: page.getByRole('heading', { name: 'Import history' }) })
  for (const f of files) {
    const panel = await offer(page, f)
    await panel.getByRole('button', { name: /^Import/ }).click()
    await expect(panel).toBeHidden()
    await expect(history.locator('li b').getByText(f.name, { exact: true }).last()).toBeVisible()
    await expect.poll(async () => {
      const d = (await stored(page)).data[page.url().split('/')[5]]
      const shown = (await page.locator('.mini-stats.wide dd').allInnerTexts()).map(Number)
      return !!d && JSON.stringify([shown[0], shown[1], shown[2], shown[3], await page.getByRole('textbox', { name: 'Run name' }).count()]) === JSON.stringify([d.corpus.length, d.queries.length, Object.keys(d.qrels).length, d.spans.length, d.runs.length])
    }).toBe(true)
  }
}

export const openTab = async (page: Page, name: string) => {
  await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name, exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page')
}

export const kpi = (page: Page, label: string) => page.locator('.kpi', { has: page.getByText(label, { exact: true }) }).locator('b')

/** The numbers of one row of the first table on the page that has that row header. */
export async function cells(page: Page, rowHeader: string): Promise<string[]> {
  const r = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: rowHeader, exact: true }) }).first()
  await expect(r).toBeVisible()
  return (await r.getByRole('cell').allInnerTexts()).map(s => s.trim())
}

export async function downloadText(page: Page, click: () => Promise<void>): Promise<{ name: string; text: string }> {
  const [d] = await Promise.all([page.waitForEvent('download'), click()])
  return { name: d.suggestedFilename(), text: await readFile(await d.path(), 'utf8') }
}

// ---------- Reading what the app stored (read-only) ----------

export interface StoredProject { id: string; name: string; labels: Record<string, Record<string, number>>; snapshots: { label: string }[]; settings: { k: number; alpha: number; thresholds: { metric: string; min?: number; maxDrop?: number }[] }; imports: { fileName: string; skipped: number }[]; sampleId?: string }
export interface StoredData { runs: { name: string; rows: { queryId: string; retrieved: { id: string }[] }[] }[]; corpus: { id: string }[]; queries: unknown[]; spans: unknown[]; qrels: Record<string, Record<string, number>> }

export async function stored(page: Page): Promise<{ projects: StoredProject[]; data: Record<string, StoredData> }> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('rag-eval')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['projects', 'data'], 'readonly')
      const projects = tx.objectStore('projects').getAll()
      const data: Record<string, unknown> = {}
      const cur = tx.objectStore('data').openCursor()
      cur.onsuccess = () => { const c = cur.result; if (c) { data[String(c.key)] = c.value; c.continue() } }
      tx.oncomplete = () => { db.close(); resolve({ projects: projects.result, data } as never) }
      tx.onerror = () => reject(tx.error)
    }
  }))
}

// ---------- The hand-worked example (the arithmetic is in metrics.spec.ts) ----------

export const CORPUS: F = { name: 'corpus.jsonl', text: jsonl(...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => ({ chunk_id: `c${n}`, doc_id: `d${n}`, text: `Passage number ${n} about topic${n}` }))) }
export const QUERIES: F = { name: 'queries.csv', text: 'query_id,query,tags,intent\nqA,how do refunds work,billing,howto\nqB,late fee,billing,fact\nqC,reset two factor login,account,howto\nqD,what is love,other,fact\nqE,export a report,other,howto\nqF,delete my account,account,howto\n' }
export const QRELS: F = { name: 'qrels.tsv', text: 'query-id\tcorpus-id\tscore\nqA\tc1\t3\nqA\tc2\t1\nqB\tc3\t1\nqC\tc4\t1\nqC\tc5\t1\nqD\tc9\t0\nqF\tc5\t1\n' }
export const row = (query_id: string, ids: string[], extra: object = {}) => ({ query_id, retrieved: ids.map(id => ({ id })), ...extra })
export const BASE: F = { name: 'base.jsonl', text: jsonl(
  row('qA', ['c9', 'c1', 'c8', 'c2']),
  row('qB', ['c3'], { answer: 'Five dollars.', cited: ['c9'] }),
  row('qC', ['c9', 'c8', 'c7', 'c6', 'c2', 'c4']),
  row('qD', ['c9']),
  row('qE', ['c9']),
  row('qF', ['c9']),
) }
export const PERFECT: F = { name: 'perfect.jsonl', text: jsonl(
  row('qA', ['c1', 'c2']), row('qB', ['c3']), row('qC', ['c4', 'c5']), row('qF', ['c5']),
) }
