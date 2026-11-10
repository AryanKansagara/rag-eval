import { useMemo, useState } from 'react'
import { Grade } from './charts.tsx'
import { BUCKETS, bucketCounts, SUGGEST, triage, worklistCsv, type Bucket } from './engine/analysis.ts'
import { judge } from './engine/metrics.ts'
import type { Run } from './engine/types.ts'
import type { TabProps } from './Project.tsx'
import { pickRuns, type Workspace } from './projectData.ts'
import { download, fmt3, Link } from './ui.tsx'

export function RankList({ w, run, queryId, k, limit = 10 }: { w: Workspace; run: Run; queryId: string; k: number; limit?: number }) {
  const row = run.rows.find(r => r.queryId === queryId)
  if (!row) return <p className="muted small">Not in this run.</p>
  const j = judge(w.ctx, queryId, row.retrieved)
  const cited = new Set(row.cited ?? [])
  const items = w.ctx.level === 'doc' ? j.ids.map((id, i) => ({ id, g: j.grades[i], text: w.ds.corpus.find(c => c.docId === id)?.title ?? '', score: undefined as number | undefined })) :
    row.retrieved.map((r, i) => ({ id: r.id, g: j.grades[i], text: w.ctx.chunks.get(r.id)?.text ?? '', score: r.score }))
  return (
    <ol className="ranklist">
      {items.slice(0, limit).map((it, i) => (
        <li key={it.id} className={`${it.g > 0 ? 'rel' : ''}${i + 1 === k ? ' cutoff' : ''}`}>
          <span className="rk">{i + 1}</span>
          <Grade g={it.g} />
          <div className="rl-body">
            <div className="row gap-sm wrap"><code>{it.id}</code>{cited.has(it.id) && <span className="badge">cited</span>}{it.score !== undefined && <span className="muted tiny">score {it.score.toFixed(3)}</span>}</div>
            {it.text && <p className="snippet">{it.text.replace(/^#+\s.*\n+/, '').slice(0, 220)}{it.text.length > 220 ? '…' : ''}</p>}
          </div>
        </li>
      ))}
    </ol>
  )
}

export default function Queries({ project, ds, w }: TabProps) {
  const { cand } = pickRuns(ds, project.settings)
  const s = project.settings
  const ev = w.evalRun(cand)
  const spans = ds.corpus.length ? w.diag().spans : []
  const t = useMemo(() => triage(ev, cand.rows, w.ctx, spans, s.k, s.minGrade), [ev, cand, w, spans, s.k, s.minGrade])
  const counts = bucketCounts(t)
  const [filter, setFilter] = useState<Bucket | 'all' | 'cut'>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const scores = useMemo(() => new Map(ev.perQuery.map(x => [x.queryId, x.scores['ndcg@10']])), [ev])
  const text = (id: string) => w.queries.get(id)?.text ?? cand.rows.find(r => r.queryId === id)?.query ?? ''
  const list = t.filter(r => (filter === 'all' ? r.bucket !== 'ok' : filter === 'cut' ? r.boundaryCut : r.bucket === filter) && (!q || (r.queryId + ' ' + text(r.queryId)).toLowerCase().includes(q.toLowerCase())))

  return (
    <>
      <div className="buckets">
        {BUCKETS.map(b => (
          <button key={b.id} type="button" className={`bucket b-${b.id}${filter === b.id ? ' on' : ''}`} onClick={() => setFilter(filter === b.id ? 'all' : b.id)} aria-pressed={filter === b.id}>
            <b>{counts[b.id]}</b><span>{b.label}</span>
          </button>
        ))}
        <button type="button" className={`bucket b-cut${filter === 'cut' ? ' on' : ''}`} onClick={() => setFilter(filter === 'cut' ? 'all' : 'cut')} aria-pressed={filter === 'cut'} disabled={!ds.spans.length}>
          <b>{ds.spans.length ? counts.boundaryCut : '—'}</b><span>Missed because the answer was cut</span>
        </button>
      </div>
      <p className="muted small">{filter === 'cut' ? 'Queries whose gold span is split across two chunks, so neither chunk holds the whole answer. Fix these with chunking, not the retriever.' : filter === 'all' ? `Everything except working queries. "Ranked low" means the first relevant item is below k = ${s.k}.` : BUCKETS.find(b => b.id === filter)!.hint}</p>

      <div className="panel">
        <div className="panel-head">
          <h2>Worklist <span className="muted small">{list.length}</span></h2>
          <div className="row gap-sm wrap">
            <input type="search" placeholder="Filter queries" value={q} onChange={e => setQ(e.target.value)} aria-label="Filter queries" style={{ width: 200 }} />
            <button type="button" className="btn outline sm" onClick={() => download(`${cand.name.replace(/\W+/g, '-')}-failures.csv`, worklistCsv(t, w.queries, cand.rows, scores, 'ndcg@10'))}>Download worklist CSV</button>
          </div>
        </div>
        {list.length === 0 ? <p className="muted">Nothing in this bucket. {filter === 'unlabelled' ? '' : 'Nice.'}</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Query</th><th>Bucket</th><th className="num">First relevant</th><th className="num">nDCG@10</th><th>Fix</th></tr></thead>
              <tbody>{list.slice(0, 200).map(r => (
                <FragmentRow key={r.queryId} open={open === r.queryId} onToggle={() => setOpen(open === r.queryId ? null : r.queryId)}
                  cells={<>
                    <th scope="row"><button type="button" className="linkish left" aria-expanded={open === r.queryId}>{text(r.queryId) || r.queryId}</button><div className="muted tiny mono">{r.queryId}{w.queries.get(r.queryId)?.tags?.length ? ' · ' + w.queries.get(r.queryId)!.tags!.join(', ') : ''}</div></th>
                    <td><span className={`badge bk-${r.bucket}`}>{BUCKETS.find(b => b.id === r.bucket)!.label}</span>{r.boundaryCut && <span className="badge bk-cut" title="Gold span split across chunks">cut</span>}</td>
                    <td className="num">{r.firstRank || '—'}</td>
                    <td className="num">{fmt3(scores.get(r.queryId))}</td>
                    <td className="small muted">{r.boundaryCut ? 'Re-chunk: the answer is split. ' : ''}{SUGGEST[r.bucket]}{r.bucket === 'unlabelled' && <> · <Link href={`/app/p/${project.id}/label?q=${encodeURIComponent(r.queryId)}`}>label</Link></>}</td>
                  </>}>
                  <div className="detail">
                    <div>
                      <h4>Retrieved ({cand.name})</h4>
                      <RankList w={w} run={cand} queryId={r.queryId} k={s.k} />
                    </div>
                    <div>
                      <h4>Gold</h4>
                      {r.goldIds.length ? <ul className="plain">{r.goldIds.map(id => <li key={id}><code>{id}</code> <span className="muted tiny">{w.qrels[r.queryId]?.[id] !== undefined ? `grade ${w.qrels[r.queryId][id]}` : 'span'}</span><p className="snippet">{w.ctx.chunks.get(id)?.text.slice(0, 200) ?? 'Not in the corpus file.'}</p></li>)}</ul> : <p className="muted small">No gold for this query.</p>}
                      {cand.rows.find(x => x.queryId === r.queryId)?.answer && <><h4>Logged answer</h4><p className="small">{cand.rows.find(x => x.queryId === r.queryId)!.answer}</p></>}
                    </div>
                  </div>
                </FragmentRow>
              ))}</tbody>
            </table>
            {list.length > 200 && <p className="muted small">Showing 200 of {list.length}. The CSV has all of them.</p>}
          </div>
        )}
      </div>
    </>
  )
}

function FragmentRow({ open, onToggle, cells, children }: { open: boolean; onToggle(): void; cells: React.ReactNode; children: React.ReactNode }) {
  return (
    <>
      <tr className={`click${open ? ' open' : ''}`} onClick={e => { if (!(e.target as HTMLElement).closest('a')) onToggle() }}>{cells}</tr>
      {open && <tr className="detail-row"><td colSpan={5}>{children}</td></tr>}
    </>
  )
}
