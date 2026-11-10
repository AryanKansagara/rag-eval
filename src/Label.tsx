import { useEffect, useMemo, useState } from 'react'
import { Grade } from './charts.tsx'
import type { TabProps } from './Project.tsx'
import { isTyping, toast } from './ui.tsx'

const GRADES = [['0', 'Not relevant'], ['1', 'Related'], ['2', 'Partly answers'], ['3', 'Fully answers']] as const

export default function Label({ project, ds, w, update }: TabProps) {
  const [scope, setScope] = useState<'todo' | 'all'>('todo')
  const allIds = useMemo(() => [...new Set([...ds.queries.map(q => q.id), ...ds.runs.flatMap(r => r.rows.map(x => x.queryId))])], [ds])
  const imported = ds.qrels
  // The queue is fixed per session so labelling a query does not make it jump out from under you.
  const queue = useMemo(() => scope === 'all' ? allIds : allIds.filter(id => !imported[id] && !project.labels[id]), [scope, allIds, imported])
  const [qi, setQi] = useState(() => { const q = new URLSearchParams(location.search).get('q'); return Math.max(0, q ? queue.indexOf(q) : 0) })
  const [fi, setFi] = useState(0)
  const qid = queue[Math.min(qi, queue.length - 1)]
  const text = qid ? w.queries.get(qid)?.text ?? ds.runs.map(r => r.rows.find(x => x.queryId === qid)?.query).find(Boolean) ?? qid : ''

  // Candidates: the union of every run's top 10, by best rank.
  const cands = useMemo(() => {
    if (!qid) return []
    const best = new Map<string, number>()
    for (const r of ds.runs) r.rows.find(x => x.queryId === qid)?.retrieved.slice(0, 10).forEach((x, i) => best.set(x.id, Math.min(best.get(x.id) ?? 99, i)))
    return [...best].sort((a, b) => a[1] - b[1]).map(([id, rank]) => ({ id, rank: rank + 1, chunk: w.ctx.chunks.get(id) }))
  }, [qid, ds.runs, w])

  const grades = { ...(imported[qid] ?? {}), ...(project.labels[qid] ?? {}) }
  const done = queue.filter(id => project.labels[id] || imported[id]).length

  const setGrade = (id: string, g: number) => {
    const next = { ...project.labels, [qid]: { ...(project.labels[qid] ?? {}), [id]: g } }
    void update({ labels: next })
    if (fi < cands.length - 1) setFi(fi + 1)
  }
  const noGold = () => {
    const prev = project.labels
    const zeros = Object.fromEntries(cands.map(c => [c.id, 0]))
    void update({ labels: { ...prev, [qid]: { ...(prev[qid] ?? {}), ...zeros } } })
    toast('Marked as no relevant chunk: it now counts as "too vague"', { undo: () => void update({ labels: prev }) })
    nextQ(1)
  }
  const nextQ = (d: number) => { setQi(i => Math.max(0, Math.min(queue.length - 1, i + d))); setFi(0) }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || !qid) return
      if (/^[0-3]$/.test(e.key) && cands[fi]) { e.preventDefault(); setGrade(cands[fi].id, Number(e.key)) }
      else if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); setFi(f => Math.min(cands.length - 1, f + 1)) }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); setFi(f => Math.max(0, f - 1)) }
      else if (e.key === 'n' || e.key === 'ArrowRight') nextQ(1)
      else if (e.key === 'p' || e.key === 'ArrowLeft') nextQ(-1)
      else if (e.key === 'x') noGold()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })
  useEffect(() => { document.getElementById(`cand-${fi}`)?.scrollIntoView({ block: 'nearest' }) }, [fi])

  const labelled = Object.keys(project.labels).length
  return (
    <>
      <div className="row between wrap gap" style={{ marginBottom: 14 }}>
        <div className="seg-control" role="radiogroup" aria-label="Queue">
          <button type="button" role="radio" aria-checked={scope === 'todo'} className={scope === 'todo' ? 'on' : ''} onClick={() => { setScope('todo'); setQi(0); setFi(0) }}>Unlabelled</button>
          <button type="button" role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => { setScope('all'); setQi(0); setFi(0) }}>All queries</button>
        </div>
        <div className="progress-wrap" aria-label={`${done} of ${queue.length} labelled`}>
          <span className="progress"><span style={{ width: `${queue.length ? (done / queue.length) * 100 : 100}%` }} /></span>
          <span className="small tab-nums">{done} / {queue.length} labelled</span>
        </div>
      </div>
      {!qid ? (
        <div className="panel center"><h2>All caught up</h2><p className="muted">Every query has judgments. {labelled ? `${labelled} queries carry labels made here; they sync with the project and override imported qrels.` : ''}</p></div>
      ) : (
        <div className="label-grid">
          <div className="panel label-query">
            <div className="muted tiny mono">{qid} · {qi + 1} of {queue.length}</div>
            <h2>{text}</h2>
            <div className="row gap-sm wrap">{w.queries.get(qid)?.tags?.map(t => <span key={t} className="badge">{t}</span>)}{w.queries.get(qid)?.intent && <span className="badge">{w.queries.get(qid)!.intent}</span>}</div>
            <dl className="shortcuts" style={{ marginTop: 16 }}>
              {GRADES.map(([k, l]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{l}</dd></div>)}
              <div><dt><kbd>J</kbd> <kbd>K</kbd></dt><dd>Next / previous chunk</dd></div>
              <div><dt><kbd>N</kbd> <kbd>P</kbd></dt><dd>Next / previous query</dd></div>
              <div><dt><kbd>X</kbd></dt><dd>Nothing here answers it</dd></div>
            </dl>
            <div className="row gap-sm wrap" style={{ marginTop: 12 }}>
              <button type="button" className="btn ghost sm" onClick={() => nextQ(-1)} disabled={qi === 0}>Previous</button>
              <button type="button" className="btn ghost sm" onClick={noGold}>No relevant chunk</button>
              <button type="button" className="btn primary sm" onClick={() => nextQ(1)} disabled={qi >= queue.length - 1}>Next query</button>
            </div>
          </div>
          <ol className="cands" aria-label="Candidate chunks">
            {cands.map((c, i) => (
              <li key={c.id} id={`cand-${i}`} className={i === fi ? 'focus' : ''} onClick={() => setFi(i)}>
                <div className="row between gap-sm wrap">
                  <span className="row gap-sm"><span className="muted tiny">best rank {c.rank}</span><code>{c.id}</code></span>
                  <span className="grade-pick" role="radiogroup" aria-label={`Relevance of ${c.id}`}>
                    {[0, 1, 2, 3].map(g => <button key={g} type="button" role="radio" aria-checked={grades[c.id] === g} className={grades[c.id] === g ? 'on g' + g : ''} onClick={e => { e.stopPropagation(); setFi(i); setGrade(c.id, g) }}>{g}</button>)}
                  </span>
                </div>
                {c.chunk ? <p className="snippet full">{c.chunk.text}</p> : <p className="muted small">Text not in the corpus file. Import chunks to read it here.</p>}
                {grades[c.id] !== undefined && <Grade g={grades[c.id]} />}
              </li>
            ))}
            {!cands.length && <li className="muted">No run retrieved anything for this query.</li>}
          </ol>
        </div>
      )}
    </>
  )
}
