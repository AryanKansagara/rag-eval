import type { Chunk, GoldSpan } from './types.ts'
import { nearDuplicates, tokenCount, wordSpans, type DupPair } from './text.ts'

export interface Doc { id: string; text: string; title?: string; chunkIds: string[]; hasOffsets: boolean }

/** Rebuild each document's text from its chunks using their offsets (overlaps are merged). */
export function rebuildDocs(corpus: Chunk[]): Doc[] {
  const by = new Map<string, Chunk[]>()
  for (const c of corpus) { const k = c.docId || ''; const l = by.get(k); if (l) l.push(c); else by.set(k, [c]) }
  const docs: Doc[] = []
  for (const [id, list] of by) {
    if (!id) continue
    const hasOffsets = list.every(c => c.start !== undefined && c.end !== undefined)
    let text = ''
    if (hasOffsets) {
      for (const c of [...list].sort((a, b) => a.start! - b.start!)) {
        if (c.start! >= text.length) text += ' '.repeat(c.start! - text.length) + c.text
        else if (c.start! + c.text.length > text.length) text += c.text.slice(text.length - c.start!)
      }
    } else text = list.map(c => c.text).join('\n\n')
    docs.push({ id, text, title: list.find(c => c.title)?.title, chunkIds: list.map(c => c.id), hasOffsets })
  }
  return docs
}

// ---------- Diagnostics on the chunks you have ----------

export type SpanStatus = 'whole' | 'cut' | 'missing' | 'unknown'
export interface SpanCheck { span: GoldSpan; status: SpanStatus; chunkIds: string[] }

/** Is each gold span inside one chunk, split across several, or not covered at all? */
export function checkSpans(corpus: Chunk[], spans: GoldSpan[]): SpanCheck[] {
  const by = new Map<string, Chunk[]>()
  for (const c of corpus) { const l = by.get(c.docId); if (l) l.push(c); else by.set(c.docId, [c]) }
  return spans.map(span => {
    const list = by.get(span.docId) ?? []
    if (!list.length || list.some(c => c.start === undefined || c.end === undefined)) return { span, status: list.length ? 'unknown' : 'missing', chunkIds: [] }
    const over = list.filter(c => Math.min(c.end!, span.end) > Math.max(c.start!, span.start))
    if (!over.length) return { span, status: 'missing', chunkIds: [] }
    const whole = over.find(c => c.start! <= span.start && c.end! >= span.end)
    return whole ? { span, status: 'whole', chunkIds: [whole.id] } : { span, status: 'cut', chunkIds: over.map(c => c.id) }
  })
}

export const cutRate = (checks: SpanCheck[]) => {
  const known = checks.filter(c => c.status === 'whole' || c.status === 'cut')
  return known.length ? known.filter(c => c.status === 'cut').length / known.length : NaN
}

export interface SizeStats { n: number; mean: number; median: number; p10: number; p90: number; min: number; max: number; bins: { label: string; n: number }[] }
const BINS = [0, 32, 64, 128, 256, 384, 512, 768, 1024, Infinity]

export function sizeStats(sizes: number[]): SizeStats {
  const s = [...sizes].sort((a, b) => a - b)
  const at = (q: number) => s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN
  const bins = BINS.slice(0, -1).map((lo, i) => ({ label: BINS[i + 1] === Infinity ? `${lo}+` : `${lo}-${BINS[i + 1] - 1}`, n: s.filter(x => x >= lo && x < BINS[i + 1]).length }))
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / (s.length || 1), median: at(0.5), p10: at(0.1), p90: at(0.9), min: s[0] ?? NaN, max: s.at(-1) ?? NaN, bins }
}

export interface Diagnostics {
  sizes: SizeStats
  tokens: Map<string, number>
  spans: SpanCheck[]
  cutRate: number
  dups: DupPair[]
  tiny: string[]
  orphans: string[]
  midSentence: string[]
}

export function diagnose(corpus: Chunk[], spans: GoldSpan[], opts: { minTokens?: number; dupThreshold?: number } = {}): Diagnostics {
  const minTokens = opts.minTokens ?? 25
  const tokens = new Map(corpus.map(c => [c.id, tokenCount(c.text)]))
  const perDoc = new Map<string, number>()
  for (const c of corpus) perDoc.set(c.docId, (perDoc.get(c.docId) ?? 0) + 1)
  const checks = checkSpans(corpus, spans)
  return {
    sizes: sizeStats([...tokens.values()]),
    tokens,
    spans: checks,
    cutRate: cutRate(checks),
    dups: nearDuplicates(corpus, opts.dupThreshold ?? 0.8),
    tiny: corpus.filter(c => tokens.get(c.id)! < minTokens).map(c => c.id),
    orphans: corpus.filter(c => !c.docId || (perDoc.get(c.docId) === 1 && tokens.get(c.id)! < minTokens)).map(c => c.id),
    // A chunk that opens on a lowercase word usually started mid-sentence.
    midSentence: corpus.filter(c => /^\s*[a-z]/.test(c.text)).map(c => c.id),
  }
}

// ---------- Re-chunking simulator ----------

export type Strategy =
  | { kind: 'fixed'; size: number; overlap: number }
  | { kind: 'sentence'; size: number }
  | { kind: 'heading'; size: number }

export const strategyLabel = (s: Strategy) => s.kind === 'fixed' ? `Fixed ${s.size} tokens, overlap ${s.overlap}` : s.kind === 'sentence' ? `Sentence packing up to ${s.size}` : `Heading sections up to ${s.size}`

type Range = { s: number; e: number }

function fixedRanges(text: string, base: number, size: number, overlap: number): Range[] {
  const w = wordSpans(text)
  const out: Range[] = []
  const step = Math.max(1, size - Math.min(overlap, size - 1))
  for (let i = 0; i < w.length; i += step) {
    out.push({ s: base + w[i].s, e: base + w[Math.min(i + size, w.length) - 1].e })
    if (i + size >= w.length) break
  }
  return out
}

/** Sentence-ish units: split after . ! ? or at newlines. */
export function sentences(text: string): Range[] {
  const out: Range[] = []
  const push = (s: number, e: number) => {
    const seg = text.slice(s, e), t = seg.trim()
    if (t) { const lead = seg.indexOf(t); out.push({ s: s + lead, e: s + lead + t.length }) }
  }
  const re = /[.!?]+(?=\s)|\n/g
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(text))) { const e = m.index + m[0].length; push(last, e); last = e }
  push(last, text.length)
  return out
}

function pack(text: string, units: Range[], size: number): Range[] {
  const out: Range[] = []
  let cur: Range | null = null, n = 0
  for (const u of units) {
    const t = tokenCount(text.slice(u.s, u.e))
    if (t > size) {
      if (cur) { out.push(cur); cur = null; n = 0 }
      out.push(...fixedRanges(text.slice(u.s, u.e), u.s, size, 0))
      continue
    }
    if (cur && n + t > size) { out.push(cur); cur = null; n = 0 }
    cur = cur ? { s: cur.s, e: u.e } : { ...u }
    n += t
  }
  if (cur) out.push(cur)
  return out
}

/** Sections start at markdown headings; inside a section, paragraphs then sentences are packed. */
function headingRanges(text: string, size: number): Range[] {
  const starts = [0]
  const re = /\n(?=#{1,6}\s)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) starts.push(m.index + 1)
  const out: Range[] = []
  starts.forEach((s, i) => {
    const e = starts[i + 1] ?? text.length
    const sec = text.slice(s, e)
    if (tokenCount(sec) <= size) { const t = sec.trim(); if (t) { const lead = sec.indexOf(t); out.push({ s: s + lead, e: s + lead + t.length }) }; return }
    out.push(...pack(text, sentences(sec).map(r => ({ s: r.s + s, e: r.e + s })), size))
  })
  return out
}

export function chunkText(text: string, st: Strategy): Range[] {
  if (st.kind === 'fixed') return fixedRanges(text, 0, st.size, st.overlap)
  if (st.kind === 'sentence') return pack(text, sentences(text), st.size)
  return headingRanges(text, st.size)
}

export interface SimResult { strategy: Strategy; label: string; chunks: number; medianTokens: number; indexedTokens: number; cutRate: number; cut: number; whole: number; score: number }

export function simulate(docs: Doc[], spans: GoldSpan[], st: Strategy): SimResult {
  const byDoc = new Map(docs.map(d => [d.id, d]))
  const sizes: number[] = []
  const ranges = new Map<string, Range[]>()
  let raw = 0
  for (const d of docs) {
    const r = chunkText(d.text, st)
    ranges.set(d.id, r)
    raw += tokenCount(d.text)
    for (const x of r) sizes.push(tokenCount(d.text.slice(x.s, x.e)))
  }
  let cut = 0, whole = 0
  for (const sp of spans) {
    const d = byDoc.get(sp.docId)
    if (!d) continue
    const r = ranges.get(d.id)!
    const over = r.filter(x => Math.min(x.e, sp.end) > Math.max(x.s, sp.start))
    if (!over.length) continue
    if (over.some(x => x.s <= sp.start && x.e >= sp.end)) whole++
    else cut++
  }
  const indexed = sizes.reduce((a, b) => a + b, 0)
  const med = sizeStats(sizes).median
  const rate = cut + whole ? cut / (cut + whole) : NaN
  // Lower is better: cut rate, plus a mild penalty for big chunks (diluted embeddings) and for overlap (index bloat).
  const score = (Number.isFinite(rate) ? rate : 1) + 0.05 * (med / 1000) + 0.02 * Math.max(0, indexed / (raw || 1) - 1)
  return { strategy: st, label: strategyLabel(st), chunks: sizes.length, medianTokens: med, indexedTokens: indexed, cutRate: rate, cut, whole, score }
}

export function defaultGrid(): Strategy[] {
  const g: Strategy[] = []
  for (const size of [128, 256, 384, 512]) for (const ov of [0, 0.1, 0.25]) g.push({ kind: 'fixed', size, overlap: Math.round(size * ov) })
  for (const size of [128, 256, 384, 512]) g.push({ kind: 'sentence', size })
  for (const size of [256, 512]) g.push({ kind: 'heading', size })
  return g
}

export function recommend(docs: Doc[], spans: GoldSpan[], grid = defaultGrid()) {
  const results = grid.map(s => simulate(docs, spans, s)).sort((a, b) => a.score - b.score)
  return { best: results[0], results }
}
