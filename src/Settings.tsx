import { useState } from 'react'
import { deleteProject, getDefaults, getProjects, setDefaults, type Defaults } from './store.ts'
import { exportAll, RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, setTheme, toast, useDark } from './ui.tsx'

export default function Settings() {
  const [d, setD] = useState<Defaults>(getDefaults)
  const dark = useDark()
  const sync = useSync()
  const save = (p: Partial<Defaults>) => { const next = { ...d, ...p }; setD(next); setDefaults(next); toast('Saved', { tone: 'ok', ttl: 1500 }) }

  return (
    <section className="page narrow settings">
      <div className="eyebrow">Settings</div>
      <h1>Settings</h1>

      <div className="panel">
        <h2>Defaults</h2>
        <p className="muted small">New projects start with these; each project keeps its own level, k and thresholds after that.</p>
        <div className="inline-fields">
          <label className="field"><span>Evaluation level</span><select value={d.level} onChange={e => save({ level: e.target.value as Defaults['level'] })}><option value="chunk">Chunk</option><option value="doc">Doc</option><option value="span">Gold span</option></select></label>
          <label className="field"><span>Triage k</span><select value={d.k} onChange={e => save({ k: Number(e.target.value) })}>{[1, 3, 5, 10, 20].map(k => <option key={k}>{k}</option>)}</select></label>
          <label className="field"><span>Relevant from grade</span><select value={d.minGrade} onChange={e => save({ minGrade: Number(e.target.value) })}>{[1, 2, 3].map(k => <option key={k}>{k}</option>)}</select></label>
          <label className="field"><span>Significance alpha</span><input type="number" min="0.001" max="0.5" step="0.01" value={d.alpha} onChange={e => save({ alpha: Number(e.target.value) || 0.05 })} /></label>
          <label className="field"><span>Bootstrap iterations</span><select value={d.iters} onChange={e => save({ iters: Number(e.target.value) })}>{[500, 1000, 2000, 5000].map(k => <option key={k}>{k}</option>)}</select></label>
          <label className="field"><span>Tiny chunk under (tokens)</span><input type="number" min="1" max="200" value={d.minTokens} onChange={e => save({ minTokens: Math.max(1, Number(e.target.value)) })} /></label>
        </div>
      </div>

      <div className="panel">
        <h2>Appearance</h2>
        <div className="seg-control" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" aria-checked={!dark} className={!dark ? 'on' : ''} onClick={() => setTheme('light')}>Light</button>
          <button type="button" role="radio" aria-checked={dark} className={dark ? 'on' : ''} onClick={() => setTheme('dark')}>Dark</button>
        </div>
      </div>

      <div className="panel">
        <h2>Your data</h2>
        <p>Projects live in this browser (IndexedDB). {sync.user ? <>Signed in as <b>{sync.user.email}</b>: settings, labels, snapshots and datasets under {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB per project sync to your account.</> : 'Sign in from the account menu (top right) to sync across devices. It is optional.'}</p>
        <div className="row gap wrap">
          <button type="button" className="btn ghost" onClick={async () => download(`rag-eval-export-${new Date().toISOString().slice(0, 10)}.json`, await exportAll())}>Export all my data (JSON)</button>
          <button type="button" className="btn danger-ghost" onClick={async () => {
            const list = getProjects()
            if (!list.length) { toast('Nothing to delete'); return }
            if (!(await ask('Delete all local projects?', `Removes ${list.length} project${list.length > 1 ? 's' : ''} from this browser${sync.user ? ' and from your cloud account' : ''}. You can undo for a few seconds.`, 'Delete everything'))) return
            const undos = await Promise.all(list.map(p => deleteProject(p.id)))
            toast(`Deleted ${list.length} projects`, { undo: () => { for (const u of undos) void u() } })
          }}>Delete all projects</button>
        </div>
      </div>

      <div className="panel">
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>8</kbd></dt><dd>Switch project sections</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Snapshot the run under study</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Printable regression report</dd></div>
          <div><dt><kbd>0</kbd>&ndash;<kbd>3</kbd>, <kbd>J</kbd> <kbd>K</kbd>, <kbd>N</kbd> <kbd>P</kbd>, <kbd>X</kbd></dt><dd>Label tab: grade, move between chunks and queries, mark no gold</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last delete</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>Show shortcuts on a project page</dd></div>
        </dl>
      </div>
    </section>
  )
}
