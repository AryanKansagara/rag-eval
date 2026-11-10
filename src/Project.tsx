import { lazy, Suspense, useEffect, useState } from 'react'
import type { Dataset, Level } from './engine/types.ts'
import { makeSnapshot, pickRuns, useProject, useWorkspace, type Workspace } from './projectData.ts'
import type { Project as P, Settings } from './store.ts'
import { Empty, go, isTyping, Link, Modal, SyntheticBadge, toast } from './ui.tsx'

const Overview = lazy(() => import('./Overview.tsx'))
const Queries = lazy(() => import('./Queries.tsx'))
const Chunks = lazy(() => import('./Chunks.tsx'))
const WhatIfTab = lazy(() => import('./WhatIf.tsx'))
const Compare = lazy(() => import('./Compare.tsx'))
const Label = lazy(() => import('./Label.tsx'))
const History = lazy(() => import('./History.tsx'))
const DataTab = lazy(() => import('./Import.tsx'))

export const TABS = [['overview', 'Overview'], ['queries', 'Failures'], ['chunks', 'Chunking'], ['whatif', 'Rerank what-if'], ['compare', 'Regression'], ['label', 'Label'], ['history', 'History'], ['data', 'Data']] as const
export type Tab = (typeof TABS)[number][0]

export interface TabProps {
  project: P
  ds: Dataset
  w: Workspace
  update(p: Partial<P>): void
  setSettings(p: Partial<Settings>): void
}

const LEVELS: [Level, string][] = [['chunk', 'Chunk'], ['doc', 'Doc'], ['span', 'Gold span']]

export default function ProjectView({ id, tab: rawTab }: { id: string; tab: string }) {
  const { loading, project, ds, update, setSettings } = useProject(id)
  const tab = (TABS.some(t => t[0] === rawTab) ? rawTab : 'overview') as Tab
  const w = useWorkspace(ds, project)
  const [help, setHelp] = useState(false)

  useEffect(() => { if (project) document.title = `${project.name} · RAG Eval Desk` }, [project?.name])
  const setTab = (t: Tab) => go(`/app/p/${id}${t === 'overview' ? '' : '/' + t}`, { keepScroll: true })

  const saveSnapshot = () => {
    if (!project || !w || !ds?.runs.length) { toast('Import a run first', { tone: 'error' }); return }
    const { cand } = pickRuns(ds, project.settings)
    const label = `${cand.name} · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    const snap = makeSnapshot(w, cand, project.settings, label)
    const before = project.snapshots
    void update({ snapshots: [...before, snap] })
    toast(`Saved a snapshot of ${cand.name}`, { tone: 'ok', undo: () => void update({ snapshots: before }) })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || tab === 'label') return
      const n = Number(e.key)
      if (n >= 1 && n <= TABS.length) { e.preventDefault(); setTab(TABS[n - 1][0]) }
      else if (e.key === '?') setHelp(true)
      else if (e.key === 's') saveSnapshot()
      else if (e.key === 'p') go(`/app/p/${id}/report`)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (loading) return <div className="boot" role="status"><span className="spinner" /> Scoring runs</div>
  if (!project || !ds) return (
    <section className="page narrow center">
      <Empty title="Project not found"><p className="muted">It may have been deleted, or it lives on another device.</p><Link href="/app" className="btn primary">All projects</Link></Empty>
    </section>
  )
  const empty = !ds.runs.length
  const s = project.settings

  return (
    <section className="page">
      <div className="proj-head">
        <div>
          <div className="eyebrow"><Link href="/app">Projects</Link></div>
          <h1 className="row gap wrap">{project.name} {project.sampleId && <SyntheticBadge />}</h1>
          {!empty && <p className="muted small" style={{ margin: 0 }}>{ds.runs.length} runs · {ds.corpus.length.toLocaleString()} chunks · {Object.keys(w!.qrels).length} judged queries</p>}
        </div>
        {!empty && (
          <div className="toolbar">
            <label className="sr-only" htmlFor="run">Run</label>
            <select id="run" value={pickRuns(ds, s).cand.id} onChange={e => setSettings({ candRunId: e.target.value })} aria-label="Run under study">
              {ds.runs.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <div className="seg-control" role="radiogroup" aria-label="Evaluation level">
              {LEVELS.map(([l, t]) => <button key={l} type="button" role="radio" aria-checked={s.level === l} className={s.level === l ? 'on' : ''} disabled={l === 'span' && !ds.spans.length} title={l === 'span' && !ds.spans.length ? 'Import gold spans to evaluate at span level' : undefined} onClick={() => setSettings({ level: l })}>{t}</button>)}
            </div>
            <label className="k-pick">k <select value={s.k} onChange={e => setSettings({ k: Number(e.target.value) })} aria-label="k for triage">{[1, 3, 5, 10, 20].map(k => <option key={k}>{k}</option>)}</select></label>
            <button type="button" className="btn outline" onClick={saveSnapshot} title="Save a snapshot (S)">Snapshot</button>
            <Link href={`/app/p/${id}/report`} className="btn primary" title="Regression report (P)">Report</Link>
          </div>
        )}
      </div>
      <nav className="tabs" aria-label="Project sections">
        {TABS.map(([t, l], i) => <Link key={t} href={`/app/p/${id}${t === 'overview' ? '' : '/' + t}`} aria-current={t === tab ? 'page' : undefined} title={`${l} (${i + 1})`}>{l}</Link>)}
      </nav>
      <Suspense fallback={<div className="boot"><span className="spinner" /></div>}>
        {(() => {
          const props = { project, ds, w: w!, update, setSettings }
          if (tab === 'data' || (empty && tab !== 'label' && tab !== 'chunks')) return <DataTab {...props} />
          if (tab === 'overview') return <Overview {...props} />
          if (tab === 'queries') return <Queries {...props} />
          if (tab === 'chunks') return <Chunks {...props} />
          if (tab === 'whatif') return <WhatIfTab {...props} />
          if (tab === 'compare') return <Compare {...props} />
          if (tab === 'label') return <Label {...props} />
          return <History {...props} />
        })()}
      </Suspense>
      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts">
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>8</kbd></dt><dd>Switch sections</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Snapshot the run under study</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Open the printable regression report</dd></div>
          <div><dt><kbd>0</kbd>&ndash;<kbd>3</kbd></dt><dd>Grade the focused chunk (Label tab)</dd></div>
          <div><dt><kbd>J</kbd> <kbd>K</kbd></dt><dd>Next / previous chunk (Label tab)</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last delete</dd></div>
        </dl>
      </Modal>
    </section>
  )
}
