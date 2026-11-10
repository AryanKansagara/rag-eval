import { useMemo, useState } from 'react'
import { Hist } from './charts.tsx'
import { rebuildDocs, recommend, simulate, strategyLabel, type SimResult, type Strategy } from './engine/chunks.ts'
import type { TabProps } from './Project.tsx'
import { getDefaults } from './store.ts'
import { Code, Empty, fmtN, fmtPct, Link } from './ui.tsx'

function snippet(s: Strategy) {
  if (s.kind === 'fixed') return `# LangChain: fixed windows (tokens counted as words here; use your tokenizer's count)
from langchain_text_splitters import TokenTextSplitter
splitter = TokenTextSplitter(chunk_size=${s.size}, chunk_overlap=${s.overlap})

# LlamaIndex
from llama_index.core.node_parser import TokenTextSplitter
parser = TokenTextSplitter(chunk_size=${s.size}, chunk_overlap=${s.overlap})`
  if (s.kind === 'sentence') return `# LlamaIndex: pack whole sentences up to the budget
from llama_index.core.node_parser import SentenceSplitter
parser = SentenceSplitter(chunk_size=${s.size}, chunk_overlap=0)

# LangChain: split on sentence ends before falling back to words
from langchain_text_splitters import RecursiveCharacterTextSplitter
splitter = RecursiveCharacterTextSplitter.from_tiktoken_encoder(
    chunk_size=${s.size}, chunk_overlap=0, separators=["\\n\\n", "\\n", ". ", "? ", "! ", " "])`
  return `# LangChain: split at markdown headings, then pack sentences inside each section
from langchain_text_splitters import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter
headers = MarkdownHeaderTextSplitter([("#", "h1"), ("##", "h2"), ("###", "h3")], strip_headers=False)
inner = RecursiveCharacterTextSplitter.from_tiktoken_encoder(
    chunk_size=${s.size}, chunk_overlap=0, separators=["\\n\\n", "\\n", ". ", " "])
chunks = inner.split_documents(headers.split_text(markdown))

# LlamaIndex
from llama_index.core.node_parser import MarkdownNodeParser, SentenceSplitter
nodes = SentenceSplitter(chunk_size=${s.size}).get_nodes_from_documents(MarkdownNodeParser().get_nodes_from_documents(docs))`
}

export default function Chunks({ ds, w, project }: TabProps) {
  const [custom, setCustom] = useState<Strategy>({ kind: 'sentence', size: 256 })
  const [showDups, setShowDups] = useState(false)
  const has = ds.corpus.length > 0
  const d = has ? w.diag() : null
  const docs = useMemo(() => has ? rebuildDocs(ds.corpus) : [], [ds.corpus, has])
  const rec = useMemo(() => ds.spans.length && docs.some(x => x.hasOffsets) ? recommend(docs.filter(x => x.hasOffsets), ds.spans) : null, [docs, ds.spans])
  const mine = useMemo<SimResult | null>(() => rec ? simulate(docs.filter(x => x.hasOffsets), ds.spans, custom) : null, [rec, docs, ds.spans, custom])

  if (!has || !d) return <Empty title="No corpus yet"><p className="muted">Import your chunks file (id, doc id, text, and ideally start/end offsets) to see size distribution, boundary cuts, duplicates and a re-chunking simulation.</p><Link href={`/app/p/${project.id}/data`} className="btn primary">Import chunks</Link></Empty>

  const cutPct = d.cutRate
  const median = d.sizes.median
  const markBin = d.sizes.bins.find(b => { const [lo, hi] = b.label.split('-').map(x => parseInt(x)); return median >= lo && (isNaN(hi) || median <= hi) })?.label
  const best = rec?.best

  return (
    <>
      <div className="kpis">
        <div className="kpi"><small>Chunks / docs</small><b>{fmtN(d.sizes.n)}</b><p>{new Set(ds.corpus.map(c => c.docId)).size} documents</p></div>
        <div className="kpi"><small>Median size</small><b>{fmtN(median)}</b><p>p10 {d.sizes.p10} · p90 {d.sizes.p90} tokens</p></div>
        <div className={`kpi${cutPct > 0.1 ? ' alert' : ''}`}><small>Boundary-cut rate</small><b>{Number.isFinite(cutPct) ? fmtPct(cutPct, 1) : '—'}</b><p>{Number.isFinite(cutPct) ? `${d.spans.filter(s => s.status === 'cut').length} of ${d.spans.filter(s => s.status === 'cut' || s.status === 'whole').length} gold spans split` : 'Needs gold spans + offsets'}</p></div>
        <div className="kpi"><small>Near-duplicates</small><b>{fmtN(d.dups.length)}</b><p>{d.dups.filter(x => x.exact).length} exact pairs · MinHash J ≥ 0.8</p></div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h2>Size distribution</h2><span className="muted small">tokens = whitespace words</span></div>
          <Hist bins={d.sizes.bins} label="Chunk sizes in tokens" mark={markBin} />
          <ul className="facts">
            <li><b>{d.tiny.length}</b> tiny chunks (under {getDefaults().minTokens} tokens): headings, footers and stubs that match many queries weakly. {d.tiny.length > 0 && <code className="tiny">{d.tiny.slice(0, 3).join(', ')}{d.tiny.length > 3 ? '…' : ''}</code>}</li>
            <li><b>{d.orphans.length}</b> orphans: no doc id, or a doc that is a single tiny chunk. {d.orphans.length > 0 && <code className="tiny">{d.orphans.slice(0, 3).join(', ')}</code>}</li>
            <li><b>{fmtPct(d.midSentence.length / d.sizes.n)}</b> of chunks start mid-sentence, a sign of fixed windows ignoring sentence ends.</li>
          </ul>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Gold spans vs chunk boundaries</h2></div>
          {!ds.spans.length ? <p className="muted">Import gold spans (query id, doc id, start, end, or the answer text) to measure how often your chunker cuts answers in half.</p> : (
            <>
              <div className="span-strip" role="img" aria-label="Status of each gold span">
                {d.spans.map((s, i) => <i key={i} className={s.status} title={`${s.span.queryId} in ${s.span.docId}: ${s.status}${s.chunkIds.length ? ' (' + s.chunkIds.join(', ') + ')' : ''}`} />)}
              </div>
              <div className="legend"><span><i className="sw whole" />Inside one chunk</span><span><i className="sw cut" />Cut across chunks</span><span><i className="sw missing" />Not covered</span><span><i className="sw unknown" />No offsets</span></div>
              <p className="small" style={{ marginTop: 12 }}>A cut answer means no single chunk contains the full evidence: the retriever can only return half of it, and the generator sees a fragment. The cut queries are flagged on the Failures tab.</p>
            </>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Duplicate and near-duplicate chunks</h2><button type="button" className="btn ghost sm" onClick={() => setShowDups(!showDups)} aria-expanded={showDups}>{showDups ? 'Hide' : 'Show'} pairs</button></div>
        <p className="muted small" style={{ margin: 0 }}>Duplicates crowd the top k with the same evidence and split relevance between copies. Usually boilerplate footers, legacy pages, or the same doc ingested twice.</p>
        {showDups && (d.dups.length ? (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="compact"><thead><tr><th>Chunk</th><th>Duplicate of</th><th className="num">Jaccard</th><th>Text</th></tr></thead>
              <tbody>{d.dups.slice(0, 40).map(p => <tr key={p.a + p.b}><td><code>{p.a}</code></td><td><code>{p.b}</code></td><td className="num">{p.exact ? 'exact' : p.similarity.toFixed(2)}</td><td className="small muted">{w.ctx.chunks.get(p.a)?.text.slice(0, 90)}…</td></tr>)}</tbody>
            </table>
          </div>
        ) : <p className="muted">None found.</p>)}
      </div>

      <div className="panel tint">
        <div className="panel-head"><h2>Re-chunking simulator</h2><span className="muted small">No embeddings needed: chunk the rebuilt documents and check every gold span</span></div>
        {!rec || !mine ? <p className="muted">Needs chunk offsets and gold spans. Without offsets the original documents cannot be rebuilt.</p> : (
          <>
            <div className="sim-controls">
              <div className="seg-control" role="radiogroup" aria-label="Strategy">
                {(['fixed', 'sentence', 'heading'] as const).map(k => <button key={k} type="button" role="radio" aria-checked={custom.kind === k} className={custom.kind === k ? 'on' : ''} onClick={() => setCustom(k === 'fixed' ? { kind: k, size: custom.size, overlap: 0 } : { kind: k, size: custom.size })}>{k === 'fixed' ? 'Fixed size' : k === 'sentence' ? 'Sentence packing' : 'Heading sections'}</button>)}
              </div>
              <label className="field inline"><span>Size {custom.size}</span><input type="range" min={32} max={1024} step={32} value={custom.size} onChange={e => setCustom({ ...custom, size: Number(e.target.value) })} /></label>
              {custom.kind === 'fixed' && <label className="field inline"><span>Overlap {custom.overlap}</span><input type="range" min={0} max={Math.floor(custom.size / 2)} step={8} value={custom.overlap} onChange={e => setCustom({ ...custom, overlap: Number(e.target.value) })} /></label>}
            </div>
            <div className="sim-result">
              <div><small>Cut rate</small><b className={mine.cutRate < cutPct ? 'good-text' : mine.cutRate > cutPct ? 'error' : ''}>{fmtPct(mine.cutRate, 1)}</b><span className="muted tiny">now {fmtPct(cutPct, 1)}</span></div>
              <div><small>Chunks</small><b>{fmtN(mine.chunks)}</b><span className="muted tiny">now {fmtN(d.sizes.n)}</span></div>
              <div><small>Median tokens</small><b>{fmtN(mine.medianTokens)}</b><span className="muted tiny">now {fmtN(median)}</span></div>
              <div><small>Index size</small><b>{fmtN(mine.indexedTokens)}</b><span className="muted tiny">tokens incl. overlap</span></div>
            </div>
          </>
        )}
      </div>

      {rec && best && (
        <div className="panel recommend">
          <div className="panel-head"><h2>Recommended chunking</h2><span className="badge">{strategyLabel(best.strategy)}</span></div>
          <p>
            <strong>{strategyLabel(best.strategy)}</strong> cuts {fmtPct(best.cutRate, 1)} of gold answers (now {fmtPct(cutPct, 1)}) with a median of {best.medianTokens} tokens across {fmtN(best.chunks)} chunks.
            {' '}It ranks first of {rec.results.length} configurations on cut rate, with small penalties for large chunks (diluted embeddings) and overlap (bigger index).
            {' '}Confirm with a retrieval run: re-index, log the same queries, and compare on the Regression tab.
          </p>
          <Code code={snippet(best.strategy)} label="Splitter config" />
          <details>
            <summary>Evidence: all {rec.results.length} configurations</summary>
            <div className="table-wrap">
              <table className="compact">
                <thead><tr><th>Strategy</th><th className="num">Cut rate</th><th className="num">Chunks</th><th className="num">Median tokens</th><th className="num">Indexed tokens</th><th className="num">Score</th></tr></thead>
                <tbody>{rec.results.map(r => <tr key={r.label} className={r === best ? 'current' : ''}><th scope="row"><button type="button" className="linkish left" onClick={() => setCustom(r.strategy)}>{r.label}</button></th><td className="num">{fmtPct(r.cutRate, 1)}</td><td className="num">{fmtN(r.chunks)}</td><td className="num">{r.medianTokens}</td><td className="num">{fmtN(r.indexedTokens)}</td><td className="num">{r.score.toFixed(3)}</td></tr>)}</tbody>
              </table>
            </div>
            <p className="muted small">Score = cut rate + 0.05 × median tokens / 1000 + 0.02 × overlap bloat. Lower is better. Click a row to load it into the simulator.</p>
          </details>
        </div>
      )}
    </>
  )
}
