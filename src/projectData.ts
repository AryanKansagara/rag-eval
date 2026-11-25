import { useEffect, useMemo, useState } from 'react'
import { applyWhatIf, bucketCounts, triage, type Snapshot, type WhatIf } from './engine/analysis.ts'
import { diagnose, type Diagnostics } from './engine/chunks.ts'
import { evaluateRows, makeCtx, METRICS, type Ctx, type RunEval } from './engine/metrics.ts'
import { buildPublicSample, PUBLIC_SAMPLE_META, type PublicSampleFile } from './engine/publicSample.ts'
import { buildSample, SAMPLE_META } from './engine/sample.ts'
import { bm25, type Bm25 } from './engine/text.ts'
import { emptyDataset, type Dataset, type Query, type Qrels, type Run } from './engine/types.ts'
import { blankSettings, getData, getDefaults, getProject, getProjects, saveProject, useDataVersion, useProjects, uuid, type Project, type Settings } from './store.ts'

export const SAMPLES: { id: string; name: string; blurb: string; kind?: 'public' }[] = [SAMPLE_META, PUBLIC_SAMPLE_META]
export const isPublicSample = (id?: string) => id === PUBLIC_SAMPLE_META.id

let publicFile: Promise<PublicSampleFile> | null = null
/** Source, licence and selection notes of the public sample (fetched once, on demand). */
export const publicSampleFile = () => publicFile ??= fetch(PUBLIC_SAMPLE_META.file).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<PublicSampleFile> }).catch(e => { publicFile = null; throw e })
let publicDs: Dataset | null = null
export async function sampleDataset(id: string): Promise<Dataset> {
  if (!isPublicSample(id)) return buildSample().ds
  return publicDs ??= buildPublicSample(await publicSampleFile())
}

export function summarize(ds: Dataset, labels: Qrels = {}): NonNullable<Project['summary']> {
  return { chunks: ds.corpus.length, docs: new Set(ds.corpus.map(c => c.docId)).size, queries: new Set([...ds.queries.map(q => q.id), ...ds.runs.flatMap(r => r.rows.map(x => x.queryId))]).size, runs: ds.runs.length, judged: Object.keys({ ...ds.qrels, ...labels }).length }
}

export async function createSampleProject(id: string = SAMPLE_META.id): Promise<Project> {
  const meta = SAMPLES.find(s => s.id === id) ?? SAMPLE_META
  const existing = getProjects().find(p => p.sampleId === meta.id)
  if (existing) return existing
  const ds = await sampleDataset(meta.id)
  const now = Date.now()
  const pub = isPublicSample(meta.id)
  const settings: Settings = { ...blankSettings(), baseRunId: pub ? PUBLIC_SAMPLE_META.baseRunId : ds.runs[0].id, candRunId: pub ? PUBLIC_SAMPLE_META.candRunId : ds.runs[1].id }
  // Absolute floors depend on the system; open-domain search over Wikipedia sits far below a help centre, so gate on drops only.
  if (pub) settings.thresholds = settings.thresholds.map(({ min: _min, ...t }) => t)
  const p: Project = { id: uuid(), name: meta.name, createdAt: now, updatedAt: now, settings, labels: {}, snapshots: [], sampleId: meta.id, summary: summarize(ds), imports: [] }
  // One snapshot per run, so History has something to compare from the first visit.
  const w = workspace(ds, {}, settings.level, settings.minGrade)
  p.snapshots = ds.runs.map(r => makeSnapshot(w, r, settings, r.name, r.createdAt))
  return saveProject(p)
}

export async function createBlankProject(name: string): Promise<Project> {
  const now = Date.now()
  return saveProject({ id: uuid(), name, createdAt: now, updatedAt: now, settings: blankSettings(), labels: {}, snapshots: [], imports: [] })
}

export function useProject(id: string) {
  const list = useProjects()
  const project = list?.find(p => p.id === id) ?? null
  const [ds, setDs] = useState<Dataset | null>(null)
  const [loadError, setLoadError] = useState(false)
  const dataVersion = useDataVersion(id)
  useEffect(() => {
    if (!project) return
    let live = true
    setLoadError(false)
    if (project.sampleId) { void sampleDataset(project.sampleId).then(d => { if (live) setDs(d) }, () => { if (live) setLoadError(true) }); return () => { live = false } }
    void getData(project.id).then(d => { if (live) setDs(d ?? emptyDataset()) })
    return () => { live = false }
  }, [project?.id, project?.sampleId, dataVersion])
  // Patches apply to the project as it is now, not as it was when the caller rendered (an Undo can run seconds later).
  const update = (patch: Partial<Project> | ((now: Project) => Partial<Project>)) => {
    const now = getProject(id)
    if (now) void saveProject({ ...now, ...(typeof patch === 'function' ? patch(now) : patch) })
  }
  const setSettings = (patch: Partial<Settings>) => update(now => ({ settings: { ...now.settings, ...patch } }))
  return { loading: list === null || (project !== null && ds === null && !loadError), loadError, project, ds, update, setSettings }
}

// ---------- Shared derived state, memoised per dataset + labels + level ----------

export interface Workspace {
  ds: Dataset
  /** Imported qrels with the user's labels applied on top. */
  qrels: Qrels
  ctx: Ctx
  queries: Map<string, Query>
  bm: () => Bm25 | undefined
  diag: () => Diagnostics
  evalRun(run: Run, mode?: WhatIf): RunEval
}

const wsCache = new WeakMap<Dataset, Map<string, Workspace>>()

export function mergeLabels(qrels: Qrels, labels: Qrels): Qrels {
  if (!Object.keys(labels).length) return qrels
  const out: Qrels = { ...qrels }
  for (const [q, j] of Object.entries(labels)) out[q] = { ...(qrels[q] ?? {}), ...j }
  return out
}

export function workspace(ds: Dataset, labels: Qrels, level: Settings['level'], minGrade: number): Workspace {
  const { iters, gain } = getDefaults()
  const key = `${level}|${minGrade}|${iters}|${gain}|${JSON.stringify(labels)}`
  let m = wsCache.get(ds)
  if (!m) wsCache.set(ds, m = new Map())
  const hit = m.get(key)
  if (hit) return hit
  const qrels = mergeLabels(ds.qrels, labels)
  const full = { ...ds, qrels }
  const ctx = makeCtx(full, level)
  let bmv: Bm25 | undefined | null = null
  let dg: Diagnostics | null = null
  const evals = new Map<string, RunEval>()
  const w: Workspace = {
    ds: full, qrels, ctx,
    queries: new Map(ds.queries.map(q => [q.id, q])),
    bm: () => bmv === null ? (bmv = ds.corpus.length ? bm25(ds.corpus) : undefined) : bmv,
    diag: () => dg ??= diagnose(ds.corpus, ds.spans, { minTokens: getDefaults().minTokens }),
    evalRun(run, mode = 'baseline') {
      const k = run.id + '|' + mode
      let e = evals.get(k)
      if (!e) { e = evaluateRows(ctx, applyWhatIf(mode, run.rows, { bm: w.bm(), queries: w.queries }), METRICS, minGrade, iters, gain === 'linear'); evals.set(k, e) }
      return e
    },
  }
  if (m.size > 6) m.clear()
  m.set(key, w)
  return w
}

export function useWorkspace(ds: Dataset | null, project: Project | null) {
  return useMemo(() => ds && project ? workspace(ds, project.labels, project.settings.level, project.settings.minGrade) : null, [ds, project?.labels, project?.settings.level, project?.settings.minGrade])
}

export function makeSnapshot(w: Workspace, run: Run, s: Settings, label: string, at = Date.now()): Snapshot {
  const ev = w.evalRun(run)
  const d = w.ds.corpus.length ? w.diag() : null
  const t = triage(ev, run.rows, w.ctx, d?.spans ?? [], s.k, s.minGrade)
  return {
    id: uuid(), runId: run.id, runName: run.name, label, at, level: s.level, k: s.k, queries: ev.scored.length,
    metrics: ev.agg,
    perQuery: Object.fromEntries(ev.scored.map(q => [q.queryId, Math.round(q.scores['ndcg@10'] * 1e4) / 1e4])),
    buckets: bucketCounts(t),
    cutRate: d ? d.cutRate : NaN,
  }
}

export const runById = (ds: Dataset, id?: string) => ds.runs.find(r => r.id === id)
export function pickRuns(ds: Dataset, s: Settings) {
  const base = runById(ds, s.baseRunId) ?? ds.runs[0]
  const cand = runById(ds, s.candRunId) ?? ds.runs.find(r => r !== base) ?? base
  return { base, cand }
}
