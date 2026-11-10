import { useMemo, useRef, useState } from 'react'
import { autoMap, corpusToJsonl, FIELDS, FORMATS, mergeFragment, qrelsToTsv, queriesToJsonl, readFile, runToJsonl, validate, type Format, type Mapping, type Parsed } from './engine/parse.ts'
import { emptyDataset, type Dataset } from './engine/types.ts'
import type { TabProps } from './Project.tsx'
import { createBlankProject, summarize } from './projectData.ts'
import { putData, saveProject, uuid } from './store.ts'
import { RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, go, Link, toast } from './ui.tsx'

interface Pending { id: string; p: Parsed; format: Format; map: Mapping; name: string }

export default function DataTab({ project, ds, update }: TabProps) {
  const [pending, setPending] = useState<Pending[]>([])
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const sync = useSync()
  const rawSize = useMemo(() => project.sampleId ? 0 : JSON.stringify(ds).length, [ds, project.sampleId])

  const readFiles = async (files: FileList | File[]) => {
    setBusy(true)
    const next: Pending[] = []
    // Corpus first, so later files in the same drop can match retrieved text and gold answers against it.
    const sorted = [...files].sort((a, b) => Number(/corpus|chunk/i.test(b.name)) - Number(/corpus|chunk/i.test(a.name)))
    for (const f of sorted) {
      if (f.size > 200_000_000) { toast(`${f.name} is over 200 MB. Split it by query range.`, { tone: 'error' }); continue }
      try {
        const p = readFile(f.name, await f.text())
        if (!p.recs.length && !p.raw.trim()) { toast(`${f.name} is empty`, { tone: 'error' }); continue }
        next.push({ id: uuid(), p, format: p.format, map: autoMap(FORMATS[p.format].kind, p.headers), name: f.name.replace(/\.(jsonl?|csv|tsv|txt)$/i, '') })
      } catch (e) { toast(`${f.name}: ${e instanceof Error ? e.message : 'could not be read'}`, { tone: 'error' }) }
    }
    setPending(x => [...x, ...next])
    setBusy(false)
  }

  const commit = async (pd: Pending) => {
    const v = validate(pd.p, pd.format, pd.map, ds.corpus)
    const kind = FORMATS[pd.format].kind
    // Samples are read-only: importing into one starts a new project.
    const target = project.sampleId ? await createBlankProject('My RAG eval') : project
    const base: Dataset = project.sampleId ? emptyDataset() : ds
    const runMeta = kind === 'run' ? { id: uuid(), name: pd.name || `Run ${base.runs.length + 1}`, createdAt: Date.now() } : undefined
    const next = mergeFragment(base, v.fragment, runMeta)
    await putData(target.id, next)
    const meta = { id: uuid(), kind: pd.format, fileName: pd.p.fileName, rows: v.ok, skipped: v.skipped, at: Date.now(), summary: v.summary }
    const settings = { ...target.settings }
    if (runMeta) { if (!settings.baseRunId || !next.runs.some(r => r.id === settings.baseRunId)) settings.baseRunId = next.runs[0].id; settings.candRunId = runMeta.id }
    if (kind === 'qrels' && next.spans.length && !Object.keys(next.qrels).length) settings.level = 'span'
    await saveProject({ ...target, settings, imports: [...(project.sampleId ? [] : project.imports), meta], summary: summarize(next, target.labels), dataMissing: false })
    setPending(x => x.filter(y => y.id !== pd.id))
    toast(`Imported ${pd.p.fileName}: ${v.summary}${v.skipped ? `, skipped ${v.skipped} rows` : ''}`, { tone: 'ok' })
    if (project.sampleId) go(`/app/p/${target.id}/data`)
  }

  const save = async (next: Dataset, msg: string, before: Dataset) => {
    await putData(project.id, next)
    void update({ summary: summarize(next, project.labels) })
    toast(msg, { undo: async () => { await putData(project.id, before); void update({ summary: summarize(before, project.labels), imports: [...project.imports] }) } })
  }

  return (
    <>
      {project.dataMissing && <div className="banner warn"><span><strong>This project&rsquo;s data is on another device.</strong> Settings, labels and snapshots synced; datasets over {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB stay where they were imported. Re-import here to recompute.</span></div>}
      {!ds.runs.length && !pending.length && (
        <div className="banner"><span><strong>Start here.</strong> Drop a retrieval log (one ranked list per query) plus qrels or gold spans, and ideally the chunks file. <Link href="/docs#logging">How to log them</Link>.</span></div>
      )}
      <div className="panel">
        <div className="panel-head"><h2>Import</h2><span className="muted small">JSONL · JSON · CSV · TSV · TREC run/qrels · LangChain · LlamaIndex · Ragas · BEIR</span></div>
        {project.sampleId && <p className="muted small">This is a synthetic sample, so its data is read-only. Importing here starts a new project. Want to rehearse? Download the sample files below and drop them back in.</p>}
        <div className={`drop${drag ? ' over' : ''}`} role="button" tabIndex={0} aria-label="Choose files to import"
          onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
          onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); void readFiles(e.dataTransfer.files) }}>
          <h3>{busy ? 'Reading files' : 'Drop files here, or click to choose'}</h3>
          <p className="muted small" style={{ margin: 0 }}>Runs, qrels, gold spans, corpus and queries, in any order. Parsed in your browser; nothing is uploaded.</p>
          <input ref={input} type="file" accept=".csv,.tsv,.txt,.json,.jsonl,.trec,.qrels" multiple hidden onChange={e => { if (e.target.files) void readFiles(e.target.files); e.target.value = '' }} />
        </div>
      </div>

      {pending.map(pd => <PendingFile key={pd.id} pd={pd} ds={ds} onChange={n => setPending(x => x.map(y => y.id === pd.id ? n : y))} onCancel={() => setPending(x => x.filter(y => y.id !== pd.id))} onCommit={() => void commit(pd)} />)}

      <div className="grid-2">
        <div className="panel">
          <h2>In this project</h2>
          <dl className="mini-stats wide">
            <div><dt>Chunks</dt><dd>{ds.corpus.length.toLocaleString()}</dd></div>
            <div><dt>Queries</dt><dd>{ds.queries.length.toLocaleString()}</dd></div>
            <div><dt>Judged</dt><dd>{Object.keys(ds.qrels).length.toLocaleString()}</dd></div>
            <div><dt>Gold spans</dt><dd>{ds.spans.length.toLocaleString()}</dd></div>
          </dl>
          <h3 style={{ marginTop: 16 }}>Runs</h3>
          {ds.runs.length === 0 ? <p className="muted small">No runs yet.</p> : (
            <ul className="run-list">{ds.runs.map(r => (
              <li key={r.id}>
                <input defaultValue={r.name} aria-label="Run name" disabled={!!project.sampleId} onBlur={e => { const v = e.target.value.trim(); if (v && v !== r.name) void save({ ...ds, runs: ds.runs.map(x => x.id === r.id ? { ...x, name: v } : x) }, 'Run renamed', ds) }} />
                <span className="muted tiny">{r.rows.length} queries · {new Date(r.createdAt).toLocaleDateString()}</span>
                {!project.sampleId && <button type="button" className="btn danger-ghost sm" onClick={async () => { if (await ask(`Delete run "${r.name}"?`, 'Its snapshots stay in History. You can undo for a few seconds.', 'Delete run')) void save({ ...ds, runs: ds.runs.filter(x => x.id !== r.id) }, `Deleted ${r.name}`, ds) }}>Delete</button>}
              </li>
            ))}</ul>
          )}
          {!project.sampleId && sync.user && rawSize > RAW_SYNC_LIMIT && <p className="warn-text small">This dataset is {(rawSize / 1e6).toFixed(1)} MB, over the {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB sync limit: it stays on this device. Settings, labels and snapshots still sync.</p>}
          {!project.sampleId && ds.runs.length + ds.corpus.length > 0 && <button type="button" className="btn danger-ghost sm" style={{ marginTop: 12 }} onClick={async () => { if (await ask('Clear all data?', 'Removes corpus, queries, qrels and runs from this project. Labels and snapshots stay. You can undo for a few seconds.', 'Clear data')) void save(emptyDataset(), 'Data cleared', ds) }}>Clear all data</button>}
        </div>
        <div className="panel">
          <h2>Import history</h2>
          {project.imports.length === 0 ? <p className="muted small">{project.sampleId ? 'Built from the synthetic sample.' : 'Nothing imported yet.'}</p> : (
            <ul className="plain small">{[...project.imports].reverse().map(i => <li key={i.id}><b>{i.fileName}</b> <span className="muted">· {FORMATS[i.kind]?.label ?? i.kind} · {i.summary}{i.skipped ? ` · ${i.skipped} skipped` : ''} · {new Date(i.at).toLocaleString()}</span></li>)}</ul>
          )}
          <h3 style={{ marginTop: 16 }}>Download as files</h3>
          <p className="muted small">The same formats the importer reads. Useful to rehearse an import, or to feed your own scripts.</p>
          <div className="row gap-sm wrap">
            <button type="button" className="btn outline sm" disabled={!ds.corpus.length} onClick={() => download('corpus.jsonl', corpusToJsonl(ds.corpus), 'application/jsonl')}>corpus.jsonl</button>
            <button type="button" className="btn outline sm" disabled={!ds.queries.length} onClick={() => download('queries.jsonl', queriesToJsonl(ds.queries), 'application/jsonl')}>queries.jsonl</button>
            <button type="button" className="btn outline sm" disabled={!Object.keys(ds.qrels).length && !ds.spans.length} onClick={() => download('qrels.tsv', qrelsToTsv(ds.qrels, ds.spans), 'text/tab-separated-values')}>qrels.tsv</button>
            {ds.runs.map(r => <button key={r.id} type="button" className="btn outline sm" onClick={() => download(`${r.name.replace(/\W+/g, '-')}.jsonl`, runToJsonl(r), 'application/jsonl')}>{r.name}.jsonl</button>)}
          </div>
        </div>
      </div>
    </>
  )
}

function PendingFile({ pd, ds, onChange, onCancel, onCommit }: { pd: Pending; ds: Dataset; onChange(p: Pending): void; onCancel(): void; onCommit(): void }) {
  const kind = FORMATS[pd.format].kind
  const v = useMemo(() => validate(pd.p, pd.format, pd.map, ds.corpus), [pd, ds.corpus])
  const errors = v.issues.filter(i => i.level === 'error')
  const blocking = errors.some(i => i.line === 0) || v.ok === 0
  return (
    <div className="panel pending">
      <div className="panel-head">
        <h2 className="break">{pd.p.fileName}</h2>
        <label className="row gap-sm small">Detected as
          <select value={pd.format} onChange={e => { const f = e.target.value as Format; onChange({ ...pd, format: f, map: autoMap(FORMATS[f].kind, pd.p.headers) }) }}>
            {(Object.keys(FORMATS) as Format[]).map(f => <option key={f} value={f}>{FORMATS[f].label}</option>)}
          </select>
        </label>
      </div>
      {FORMATS[pd.format].flat && pd.p.headers.length > 0 && (
        <>
          <h3 className="small-h">Column mapping</h3>
          <div className="map-grid">
            {FIELDS[kind].map(f => (
              <label key={f.key} className="field">
                <span>{f.label}{f.required ? ' *' : ''}</span>
                <select value={pd.map[f.key] ?? ''} onChange={e => onChange({ ...pd, map: { ...pd.map, [f.key]: e.target.value || undefined } as Mapping })}>
                  <option value="">Not in file</option>
                  {pd.p.headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>
        </>
      )}
      {kind === 'run' && <label className="field" style={{ maxWidth: 360 }}><span>Run name (pipeline version)</span><input value={pd.name} onChange={e => onChange({ ...pd, name: e.target.value })} placeholder="v3 sentence chunks + rerank" /></label>}
      <h3 className="small-h">Validation report</h3>
      <p className="small"><b>{v.summary}</b> · {v.ok.toLocaleString()} rows OK · <span className={v.skipped ? 'error' : ''}>{v.skipped} skipped</span> · {v.issues.filter(i => i.level === 'warning').length} warnings</p>
      {v.issues.length > 0 && (
        <div className="issues" role="log" aria-label="Validation issues">
          {v.issues.slice(0, 300).map((i, n) => <div key={n} className={`${i.level}-row`}><span className="ln">{i.line ? `line ${i.line}` : 'file'}</span><span>{i.message}</span></div>)}
          {v.issues.length > 300 && <div><span className="ln" /><span className="muted">and {v.issues.length - 300} more</span></div>}
        </div>
      )}
      <div className="row gap end" style={{ marginTop: 14 }}>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn primary" disabled={blocking} onClick={onCommit}>{blocking ? 'Fix the mapping first' : `Import ${v.skipped ? `${v.ok} good rows` : ''}`.trim()}</button>
      </div>
    </div>
  )
}
