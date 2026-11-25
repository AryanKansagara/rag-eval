import { rebuildDocs } from './chunks.ts'
import type { Chunk, Dataset, GoldSpan, Qrels, Query, Retrieved, Run, RunRow } from './types.ts'

// ---------- Low-level readers ----------

/** `unclosed` is the line of a quote that never closes. Its row runs to the end of the file, so it is left out. */
export function parseCsv(text: string): { rows: string[][]; lines: number[]; unclosed?: number } {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const nl = text.indexOf('\n')
  const head = text.slice(0, nl < 0 ? text.length : nl)
  const delim = [',', '\t', ';'].map(d => [d, head.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0]
  const rows: string[][] = [], lines: number[] = []
  let row: string[] = [], field = '', quoted = false, line = 1, rowLine = 1, quoteLine = 1
  const endRow = () => { row.push(field); field = ''; if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) }; row = [] }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false }
      else { if (c === '\n') line++; field += c }
    } else if (c === '"' && field === '') { quoted = true; quoteLine = line }
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); line++; rowLine = line }
    else field += c
  }
  if (quoted) return { rows, lines, unclosed: quoteLine }
  if (field !== '' || row.length) endRow()
  return { rows, lines }
}

export interface Rec { line: number; v: Record<string, unknown> }
export interface Issue { line: number; level: 'error' | 'warning'; message: string }

/** JSON array, JSON object with a list inside, or JSONL. Line numbers point at the JSONL line or array item. */
export function parseJsonRecords(text: string): { recs: Rec[]; issues: Issue[] } {
  const t = text.trim()
  const issues: Issue[] = []
  const recs: Rec[] = []
  const add = (line: number, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) recs.push({ line, v: v as Record<string, unknown> })
    else issues.push({ line, level: 'error', message: `Expected a JSON object, got ${v === null ? 'null' : Array.isArray(v) ? 'a list' : `a ${typeof v}`}` })
  }
  if (t.startsWith('[') || (t.startsWith('{') && !t.includes('\n{'))) {
    try {
      let j = JSON.parse(t)
      if (!Array.isArray(j)) {
        // Unwrap {"data": [...]}-style containers; any other object is a single record.
        const key = Object.keys(j).find(k => ['data', 'items', 'records', 'examples', 'runs', 'rows', 'samples', 'queries'].includes(k.toLowerCase()) && Array.isArray(j[k]))
        j = key ? j[key] : pivotColumns(j) ?? [j]
      }
      ;(j as unknown[]).forEach((v, i) => add(i + 1, v))
      return { recs, issues }
    } catch { /* fall through to JSONL */ }
  }
  text.split(/\r?\n/).forEach((l, i) => {
    if (!l.trim()) return
    let v: unknown
    try { v = JSON.parse(l) } catch { issues.push({ line: i + 1, level: 'error', message: 'Not valid JSON' }); return }
    add(i + 1, v)
  })
  return { recs, issues }
}

/** Column-oriented JSON, as written by Dataset.to_dict() ({"col": [...]}) or pandas to_json() ({"col": {"0": ...}}). */
function pivotColumns(j: Record<string, unknown>): Record<string, unknown>[] | null {
  const cols = Object.entries(j)
  if (cols.length < 2) return null
  const cells = cols.map(([, v]) => Array.isArray(v) ? v : v && typeof v === 'object' && Object.keys(v).every(k => /^\d+$/.test(k)) ? Object.values(v) : null)
  const n = cells[0]?.length
  if (!n || cells.some(c => !c || c.length !== n)) return null
  return Array.from({ length: n }, (_, i) => Object.fromEntries(cols.map(([k], c) => [k, cells[c]![i]])))
}

// ---------- Format detection ----------

export type Kind = 'run' | 'qrels' | 'corpus' | 'queries'
export type Format = 'run-jsonl' | 'langchain' | 'llamaindex' | 'ragas' | 'trec-run' | 'run-csv' | 'qrels-trec' | 'qrels' | 'corpus' | 'queries'

export const FORMATS: Record<Format, { label: string; kind: Kind; flat: boolean }> = {
  'run-jsonl': { label: 'Retrieval log (JSONL, retrieved list per query)', kind: 'run', flat: false },
  langchain: { label: 'LangChain / LangSmith trace export', kind: 'run', flat: false },
  llamaindex: { label: 'LlamaIndex response with source_nodes', kind: 'run', flat: false },
  ragas: { label: 'Ragas dataset (retrieved_contexts)', kind: 'run', flat: false },
  'trec-run': { label: 'TREC run file (qid Q0 docid rank score tag)', kind: 'run', flat: false },
  'run-csv': { label: 'Retrieval log (CSV, one row per retrieved chunk)', kind: 'run', flat: true },
  'qrels-trec': { label: 'TREC qrels (qid 0 docid rel)', kind: 'qrels', flat: false },
  qrels: { label: 'Qrels / gold spans (BEIR TSV, CSV or JSONL)', kind: 'qrels', flat: true },
  corpus: { label: 'Corpus / chunks (id, doc id, text, offsets)', kind: 'corpus', flat: true },
  queries: { label: 'Queries (id, text, tags, intent)', kind: 'queries', flat: true },
}

export interface FieldSpec { key: string; label: string; required?: boolean; aliases: string[] }
export const FIELDS: Record<Kind, FieldSpec[]> = {
  run: [
    { key: 'queryId', label: 'Query id', required: true, aliases: ['query_id', 'qid', 'query-id', 'queryid', 'question_id'] },
    { key: 'query', label: 'Query text', aliases: ['query', 'question', 'query_text', 'user_input', 'input'] },
    { key: 'chunkId', label: 'Retrieved chunk id', aliases: ['chunk_id', 'doc_id', 'corpus-id', 'corpus_id', 'docid', 'passage_id', 'context_id', 'retrieved_id', 'node_id'] },
    { key: 'retrievedIds', label: 'Retrieved ids (one cell, | separated)', aliases: ['retrieved_ids', 'retrieved', 'chunk_ids', 'context_ids', 'retrieved_context_ids'] },
    { key: 'rank', label: 'Rank', aliases: ['rank', 'position', 'pos'] },
    { key: 'score', label: 'Retriever score', aliases: ['score', 'similarity', 'dense_score', 'vector_score'] },
    { key: 'rerank', label: 'Rerank score', aliases: ['rerank_score', 'rerank', 'relevance_score', 'reranker_score', 'cohere_score'] },
    { key: 'answer', label: 'Answer', aliases: ['answer', 'response', 'output'] },
    { key: 'cited', label: 'Cited chunk ids (| separated)', aliases: ['cited', 'cited_ids', 'citations', 'cited_chunk_ids'] },
  ],
  qrels: [
    { key: 'queryId', label: 'Query id', required: true, aliases: ['query_id', 'query-id', 'qid', 'queryid', 'question_id'] },
    { key: 'id', label: 'Relevant chunk or doc id', aliases: ['chunk_id', 'corpus-id', 'corpus_id', 'docid', 'passage_id', 'id', 'doc_id'] },
    { key: 'grade', label: 'Relevance grade (0-3)', aliases: ['relevance', 'grade', 'label', 'rel', 'score', 'judgment'] },
    { key: 'docId', label: 'Gold span doc id', aliases: ['doc_id', 'document_id', 'gold_doc_id'] },
    { key: 'start', label: 'Gold span start (char)', aliases: ['start', 'span_start', 'answer_start', 'start_char'] },
    { key: 'end', label: 'Gold span end (char)', aliases: ['end', 'span_end', 'answer_end', 'end_char'] },
    { key: 'answer', label: 'Gold answer text', aliases: ['answer_text', 'gold_answer', 'span_text', 'answer', 'reference'] },
  ],
  corpus: [
    { key: 'id', label: 'Chunk id', required: true, aliases: ['chunk_id', 'id', '_id', 'node_id', 'passage_id'] },
    { key: 'docId', label: 'Doc id', aliases: ['doc_id', 'document_id', 'parent_id', 'source', 'doc'] },
    { key: 'text', label: 'Text', required: true, aliases: ['text', 'content', 'page_content', 'chunk', 'body', 'passage'] },
    { key: 'start', label: 'Start offset', aliases: ['start', 'start_char', 'start_offset', 'char_start', 'start_char_idx', 'start_index'] },
    { key: 'end', label: 'End offset', aliases: ['end', 'end_char', 'end_offset', 'char_end', 'end_char_idx', 'end_index'] },
    { key: 'title', label: 'Title / heading', aliases: ['title', 'heading', 'section', 'doc_title'] },
  ],
  queries: [
    { key: 'id', label: 'Query id', required: true, aliases: ['query_id', 'qid', '_id', 'id'] },
    { key: 'text', label: 'Query text', required: true, aliases: ['query', 'text', 'question', 'query_text'] },
    { key: 'tags', label: 'Tags (| separated)', aliases: ['tags', 'tag', 'labels', 'category', 'topic'] },
    { key: 'intent', label: 'Intent', aliases: ['intent', 'type', 'query_type'] },
  ],
}

export const norm = (h: string) => h.trim().toLowerCase().replace(/^"|"$/g, '').replace(/[\s.]+/g, '_')
export type Mapping = Record<string, string>

export function autoMap(kind: Kind, headers: string[]): Mapping {
  const m: Mapping = {}
  const used = new Set<string>()
  for (const f of FIELDS[kind]) {
    const h = f.aliases.map(a => headers.find(x => norm(x) === a && !used.has(x))).find(Boolean)
    if (h) { m[f.key] = h; used.add(h) }
  }
  return m
}

const has = (keys: string[], ...names: string[]) => names.some(n => keys.includes(n))

/** BEIR ships queries.jsonl with the corpus keys (_id, title, text): tell them apart by empty titles and short texts. */
function looksLikeQueries(recs: Rec[]) {
  const s = recs.slice(0, 50).map(r => r.v ?? {})
  const len = s.reduce((a, v) => a + String(v.text ?? '').length, 0) / (s.length || 1)
  return s.every(v => !v.title) && len < 160
}

export function detect(fileName: string, recs: Rec[], textHead: string): Format {
  const lines = textHead.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')).slice(0, 5)
  if (!recs.length && lines.length) {
    const cols = lines[0].trim().split(/\s+/)
    if (cols.length === 6 && cols[1] === 'Q0') return 'trec-run'
    if (cols.length === 4 && /^-?\d+(\.\d+)?$/.test(cols[3]) && !/[a-z]{4,}_id/i.test(lines[0])) return 'qrels-trec'
  }
  const first = recs[0]?.v ?? {}
  const keys = Object.keys(first).map(norm)
  const name = fileName.toLowerCase()
  if (has(keys, 'source_nodes')) return 'llamaindex'
  if (has(keys, 'outputs', 'source_documents') || (has(keys, 'inputs') && has(keys, 'run_type'))) return 'langchain'
  if (has(keys, 'retrieved_contexts', 'contexts', 'user_input')) return 'ragas'
  if (keys.some(k => ['retrieved', 'results', 'hits', 'documents', 'docs', 'chunks'].includes(k) && Array.isArray(first[Object.keys(first)[keys.indexOf(k)]]))) return 'run-jsonl'
  if (has(keys, 'rank', 'rerank_score', 'retrieved_ids', 'position') || /run|trace|log|retriev/.test(name)) return 'run-csv'
  if (has(keys, 'relevance', 'grade', 'rel', 'judgment', 'corpus-id', 'span_start', 'answer_start', 'answer_text') || /qrel|gold|judg|label/.test(name)) return 'qrels'
  if (/quer/.test(name) && !/corpus|chunk/.test(name) && has(keys, 'text', 'query', 'question')) return 'queries'
  if (has(keys, 'text') && has(keys, '_id') && !/corpus|chunk/.test(name) && looksLikeQueries(recs)) return 'queries'
  if (has(keys, 'text', 'content', 'page_content', 'chunk', 'passage') && !has(keys, 'query_id', 'qid', 'query') || /corpus|chunk/.test(name)) return 'corpus'
  if (has(keys, 'query', 'question', 'query_text') || /quer/.test(name)) return 'queries'
  return 'run-csv'
}

export interface Parsed { fileName: string; format: Format; recs: Rec[]; headers: string[]; issues: Issue[]; raw: string }

export function readFile(fileName: string, text: string): Parsed {
  const t = text.replace(/^﻿/, '')
  const head = t.slice(0, 4000)
  const looksJson = /^\s*[[{]/.test(t)
  if (looksJson) {
    const { recs, issues } = parseJsonRecords(t)
    const headers = [...new Set(recs.slice(0, 50).flatMap(r => Object.keys(r.v ?? {})))]
    return { fileName, format: detect(fileName, recs, ''), recs, headers, issues, raw: t }
  }
  const firstLine = head.split(/\r?\n/).find(l => l.trim() && !l.startsWith('#')) ?? ''
  const ws = firstLine.trim().split(/\s+/)
  // TREC files are whitespace separated: real ones mix tabs and padded spaces, so check them before CSV/TSV.
  if (!/[,;]/.test(firstLine) && (ws.length === 6 && ws[1] === 'Q0' || ws.length === 4 && /^-?\d+(\.\d+)?$/.test(ws[3]))) {
    return { fileName, format: detect(fileName, [], head), recs: [], headers: [], issues: [], raw: t }
  }
  const csv = parseCsv(t)
  const headers = csv.rows[0] ?? []
  const recs = csv.rows.slice(1).map((r, i) => ({ line: csv.lines[i + 1], v: Object.fromEntries(headers.map((h, j) => [h, r[j] ?? ''])) }))
  const issues: Issue[] = csv.unclosed ? [{ line: csv.unclosed, level: 'error', message: 'A quote opened on this line is never closed, so this row and everything after it was not read' }] : []
  // When the open quote took the only row, the header still says what the file is.
  const sample = csv.unclosed && !recs.length && headers.length ? [{ line: 1, v: Object.fromEntries(headers.map(h => [h, ''])) }] : recs
  return { fileName, format: detect(fileName, sample, head), recs, headers, issues, raw: t }
}

// ---------- Validation into dataset fragments ----------

export interface Fragment { corpus?: Chunk[]; queries?: Query[]; qrels?: Qrels; spans?: GoldSpan[]; run?: Omit<Run, 'id' | 'name' | 'createdAt'> }
export interface Validated { fragment: Fragment; issues: Issue[]; ok: number; skipped: number; summary: string }

const str = (x: unknown) => x === undefined || x === null ? '' : typeof x === 'string' ? x.trim() : typeof x === 'number' ? String(x) : ''
const num = (x: unknown) => { const s = str(x); if (!s) return undefined; const n = Number(s); return Number.isFinite(n) ? n : NaN }
/** A list in one cell. With a | in it, only | separates, so items may hold spaces; without one, ids may be separated by ; or spaces. */
const list = (x: unknown, without = /[;\s]+/) => Array.isArray(x) ? x.map(str).filter(Boolean) : str(x).split(str(x).includes('|') ? '|' : without).map(s => s.trim()).filter(Boolean)
const tagList = (x: unknown) => list(x, /[;\r\n]+/)
const get = (o: unknown, ...path: string[]): unknown => path.reduce<unknown>((a, k) => a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined, o)
const pick = (o: Record<string, unknown>, ...names: string[]) => { for (const n of names) { const k = Object.keys(o).find(x => norm(x) === n); if (k && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k] } return undefined }

export function hashId(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return 'h' + (h >>> 0).toString(36)
}
/** JSON numbers past 2^53 are rounded when read, so such an id may not be the one in the file. */
const rounded = (x: unknown) => typeof x === 'number' && Number.isInteger(x) && !Number.isSafeInteger(x)
const normText = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** Turns a retrieved document object from any common shape into an id, matching the corpus by text when needed. */
type Ref = Retrieved & { matched: boolean; text?: string }
function docRef(d: unknown, byText: Map<string, string>): Ref {
  if (typeof d === 'string') {
    const id = byText.get(normText(d))
    if (id) return { id, matched: true }
    // A bare string with spaces is a passage (Ragas contexts), not an id.
    return /\s/.test(d.trim()) ? { id: hashId(normText(d)), matched: false, text: d } : { id: d.trim(), matched: true }
  }
  if (typeof d === 'number' && Number.isFinite(d)) return { id: String(d), matched: true }
  const o = (d ?? {}) as Record<string, unknown>
  const node = (o.node ?? o) as Record<string, unknown>
  const meta = (node.metadata ?? o.metadata ?? {}) as Record<string, unknown>
  const id = str(pick(meta, 'chunk_id', 'id', 'node_id') ?? pick(node, 'chunk_id', 'id_', 'id', 'node_id', 'doc_id', 'docid', 'corpus_id', '_id'))
  const text = str(node.page_content ?? node.text ?? node.content)
  const score = num(o.score ?? meta.score ?? o.similarity)
  const rerank = num(o.rerank_score ?? o.relevance_score ?? meta.rerank_score ?? meta.relevance_score)
  const r: Ref = { id, matched: true }
  if (score !== undefined && !Number.isNaN(score)) r.score = score
  if (rerank !== undefined && !Number.isNaN(rerank)) r.rerank = rerank
  if (!id && text) { const m = byText.get(normText(text)); r.id = m ?? hashId(normText(text)); r.matched = !!m; if (!m) r.text = text }
  return r
}

const ROUNDED = 'Some numeric ids are too large for JSON numbers and were rounded; write them as strings'

export function validate(p: Parsed, format: Format, map: Mapping, corpus: Chunk[] = []): Validated {
  const issues: Issue[] = [...p.issues]
  const err = (line: number, message: string) => issues.push({ line, level: 'error', message })
  const warn = (line: number, message: string) => issues.push({ line, level: 'warning', message })
  const byText = new Map(corpus.map(c => [normText(c.text), c.id]))
  const field = (r: Rec, key: string) => map[key] ? r.v[map[key]] : undefined
  // Lines the reader could not use are rows the import leaves out.
  let ok = 0, skipped = p.issues.filter(i => i.level === 'error').length

  if (format === 'trec-run' || format === 'qrels-trec') {
    const rows = new Map<string, Retrieved[]>()
    const qrels: Qrels = {}
    p.raw.split(/\r?\n/).forEach((l, i) => {
      if (!l.trim() || l.startsWith('#')) return
      const c = l.trim().split(/\s+/)
      if (format === 'trec-run') {
        if (c.length < 5) { err(i + 1, `Expected "qid Q0 docid rank score tag", got ${c.length} columns`); skipped++; return }
        const score = Number(c[4])
        const lst = rows.get(c[0]) ?? []
        lst.push({ id: c[2], ...(Number.isFinite(score) ? { score } : {}), rank: Number(c[3]) } as Retrieved)
        rows.set(c[0], lst); ok++
      } else {
        const g = Number(c[3])
        if (c.length < 4 || !Number.isFinite(g)) { err(i + 1, 'Expected "qid 0 docid relevance"'); skipped++; return }
        ;(qrels[c[0]] ??= {})[c[2]] = g; ok++
      }
    })
    if (format === 'qrels-trec') return { fragment: { qrels }, issues, ok, skipped, summary: `${Object.keys(qrels).length} queries, ${ok} judgments` }
    const runRows: RunRow[] = [...rows].map(([queryId, l]) => ({ queryId, retrieved: l.sort((a, b) => ((a as unknown as { rank: number }).rank - (b as unknown as { rank: number }).rank) || (b.score ?? 0) - (a.score ?? 0)).map(({ id, score }) => ({ id, ...(score !== undefined ? { score } : {}) })) }))
    return { fragment: { run: { rows: runRows } }, issues, ok, skipped, summary: `${runRows.length} queries, ${ok} retrieved items` }
  }

  if (FORMATS[format].kind === 'run' && !FORMATS[format].flat) {
    const rows: RunRow[] = []
    let unmatched = 0
    // Passages logged as text with no id become chunks, so they can still be read and labelled.
    const derived = new Map<string, Chunk>()
    const qrels: Qrels = {}
    for (const r of p.recs) {
      const v = r.v ?? {}
      let qid = '', query = '', docs: unknown[] | undefined, answer = '', cited: string[] | undefined
      if (format === 'llamaindex') {
        query = str(pick(v, 'query', 'query_str', 'question'))
        qid = str(pick(v, 'query_id', 'qid', 'id')) || str(get(v, 'metadata', 'query_id'))
        docs = pick(v, 'source_nodes') as unknown[]
        answer = str(pick(v, 'response', 'answer'))
      } else if (format === 'langchain') {
        const inputs = (v.inputs ?? {}) as Record<string, unknown>
        const outputs = (v.outputs ?? {}) as Record<string, unknown>
        query = str(pick(inputs, 'query', 'question', 'input') ?? pick(v, 'query', 'question'))
        qid = str(get(v, 'extra', 'metadata', 'query_id') ?? get(v, 'metadata', 'query_id') ?? pick(inputs, 'query_id') ?? pick(v, 'query_id'))
        docs = (pick(outputs, 'documents', 'source_documents', 'context', 'output') ?? pick(v, 'source_documents', 'documents')) as unknown[]
        answer = str(pick(outputs, 'answer', 'result', 'output_text') ?? pick(v, 'answer', 'result'))
        if (!qid) qid = str(v.id)
      } else if (format === 'ragas') {
        query = str(pick(v, 'user_input', 'question', 'query'))
        qid = str(pick(v, 'query_id', 'qid', 'id'))
        const ids = pick(v, 'retrieved_context_ids') as unknown[] | undefined
        docs = Array.isArray(ids) ? ids : pick(v, 'retrieved_contexts', 'contexts') as unknown[]
        answer = str(pick(v, 'response', 'answer'))
        const gold = pick(v, 'reference_context_ids', 'reference_contexts')
        if (Array.isArray(gold) && gold.length) {
          const key = qid || (query ? hashId(normText(query)) : '')
          const refs = gold.map(x => docRef(x, byText))
          if (refs.some(x => !x.id)) warn(r.line, 'Some reference contexts had no id or text and were dropped')
          if (gold.some(rounded)) warn(r.line, ROUNDED)
          for (const g of refs) if (key && g.id) { (qrels[key] ??= {})[g.id] = 1; if (g.text) derived.set(g.id, { id: g.id, docId: g.id, text: g.text }) }
        }
      } else {
        qid = str(pick(v, 'query_id', 'qid', 'query-id', 'id'))
        query = str(pick(v, 'query', 'question', 'query_text'))
        docs = pick(v, 'retrieved', 'results', 'hits', 'documents', 'docs', 'chunks') as unknown[]
        const ids = pick(v, 'retrieved_ids')
        if (!docs && ids) docs = Array.isArray(ids) ? ids : list(ids).map(id => ({ id }))
        answer = str(pick(v, 'answer', 'response'))
        const c = pick(v, 'cited', 'cited_ids', 'citations', 'cited_chunk_ids')
        if (c !== undefined) cited = list(c)
      }
      if (!qid && query) qid = hashId(normText(query))
      if (!qid) { err(r.line, 'No query id or query text'); skipped++; continue }
      if (!Array.isArray(docs)) { err(r.line, 'No retrieved list found (expected retrieved, documents, source_nodes or contexts)'); skipped++; continue }
      const retrieved = docs.map(d => docRef(d, byText))
      if (docs.some(rounded)) warn(r.line, ROUNDED)
      unmatched += retrieved.filter(x => !x.matched).length
      for (const x of retrieved) if (x.text && x.id) derived.set(x.id, { id: x.id, docId: x.id, text: x.text })
      if (retrieved.some(x => !x.id)) warn(r.line, 'Some retrieved items had no id or text and were dropped')
      const clean = retrieved.filter(x => x.id).map(({ matched: _m, text: _t, ...x }) => x)
      if (!clean.length) warn(r.line, 'Empty retrieved list')
      if (cited === undefined) { const c = pick(v, 'cited', 'cited_ids', 'citations'); if (c !== undefined) cited = list(c) }
      rows.push({ queryId: qid, ...(query ? { query } : {}), retrieved: clean, ...(answer ? { answer } : {}), ...(cited ? { cited } : {}) })
      ok++
    }
    if (unmatched) warn(0, `${unmatched} retrieved passages were logged as text without ids${byText.size ? ' and did not match any chunk in the corpus' : ''}. ${derived.size} distinct passages were added as chunks with hashed ids so you can read and label them. To score against existing qrels, import the chunks file first or log chunk ids.`)
    const nGold = Object.keys(qrels).length
    return { fragment: { run: { rows: dedupeRows(rows, issues) }, ...(derived.size ? { corpus: [...derived.values()] } : {}), ...(nGold ? { qrels } : {}) }, issues, ok, skipped, summary: `${rows.length} queries${derived.size ? `, ${derived.size} passages` : ''}${nGold ? `, ${nGold} with reference contexts` : ''}` }
  }

  const kind = FORMATS[format].kind
  for (const f of FIELDS[kind]) if (f.required && !map[f.key]) err(0, `Map a column to "${f.label}"`)
  if (kind === 'run' && !map.chunkId && !map.retrievedIds) err(0, 'Map either "Retrieved chunk id" or "Retrieved ids"')
  if (issues.some(i => i.line === 0 && i.level === 'error')) return { fragment: {}, issues, ok: 0, skipped: skipped + p.recs.length, summary: 'Mapping incomplete' }

  if (kind === 'corpus') {
    const corpusOut: Chunk[] = []
    const seen = new Set<string>()
    for (const r of p.recs) {
      const id = str(field(r, 'id')), text = typeof field(r, 'text') === 'string' ? field(r, 'text') as string : str(field(r, 'text'))
      if (!id) { err(r.line, 'Missing chunk id'); skipped++; continue }
      if (!text.trim()) { err(r.line, `Chunk ${id} has no text`); skipped++; continue }
      if (seen.has(id)) { warn(r.line, `Duplicate chunk id ${id}; kept the first`); skipped++; continue }
      const start = num(field(r, 'start')), end = num(field(r, 'end'))
      const c: Chunk = { id, docId: str(field(r, 'docId')) || id, text }
      if (start !== undefined || end !== undefined) {
        if (!Number.isFinite(start) || !Number.isFinite(end) || end! < start!) warn(r.line, `Bad offsets for ${id}; ignored`)
        else { c.start = start; c.end = end; if (Math.abs(end! - start! - text.length) > 2) warn(r.line, `Offsets of ${id} span ${end! - start!} chars but text has ${text.length}`) }
      }
      const title = str(field(r, 'title')); if (title) c.title = title
      seen.add(id); corpusOut.push(c); ok++
    }
    const docs = new Set(corpusOut.map(c => c.docId)).size
    return { fragment: { corpus: corpusOut }, issues, ok, skipped, summary: `${corpusOut.length} chunks in ${docs} docs` }
  }

  if (kind === 'queries') {
    const qs: Query[] = []
    for (const r of p.recs) {
      const id = str(field(r, 'id')), text = str(field(r, 'text'))
      if (!id || !text) { err(r.line, !id ? 'Missing query id' : 'Missing query text'); skipped++; continue }
      const tags = map.tags ? tagList(field(r, 'tags')) : []
      const q: Query = { id, text }
      if (tags.length) q.tags = tags
      const intent = str(field(r, 'intent')); if (intent) q.intent = intent
      qs.push(q); ok++
    }
    return { fragment: { queries: qs }, issues, ok, skipped, summary: `${qs.length} queries` }
  }

  if (kind === 'qrels') {
    const qrels: Qrels = {}
    const spans: GoldSpan[] = []
    const docText = new Map(rebuildDocs(corpus).filter(d => d.hasOffsets).map(d => [d.id, d.text]))
    for (const r of p.recs) {
      const qid = str(field(r, 'queryId'))
      if (!qid) { err(r.line, 'Missing query id'); skipped++; continue }
      const id = str(field(r, 'id'))
      const gv = field(r, 'grade')
      const gRaw = typeof gv === 'boolean' ? Number(gv) : num(gv)
      if (Number.isNaN(gRaw)) { err(r.line, `Relevance "${str(field(r, 'grade'))}" is not a number`); skipped++; continue }
      const g = gRaw === undefined ? 1 : gRaw
      if (g < 0 || g > 3) warn(r.line, `Grade ${g} is outside 0-3`)
      const doc = str(field(r, 'docId')) || (map.start || map.answer ? id : '')
      const start = num(field(r, 'start')), end = num(field(r, 'end'))
      const ans = str(field(r, 'answer'))
      const hasSpan = !!doc && (start !== undefined && end !== undefined || !!ans && !!map.answer)
      // The default grade is for files without a grade column; a blank cell in one means nobody judged the row.
      if (map.grade && gRaw === undefined && id && !hasSpan) { err(r.line, `Relevance of ${id} is blank`); skipped++; continue }
      let used = false
      if (id) { (qrels[qid] ??= {})[id] = g; used = true }
      if (g <= 0) { /* A span graded not relevant is a judgment, but not a gold answer. */ }
      else if (doc && start !== undefined && end !== undefined) {
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) err(r.line, 'Span end must be after start')
        else { spans.push({ queryId: qid, docId: doc, start, end }); used = true }
      } else if (doc && ans && map.answer) {
        const t = docText.get(doc)
        const at = t ? t.indexOf(ans) : -1
        if (at < 0) warn(r.line, t ? `Gold answer text not found in doc ${doc}` : `Import the corpus with offsets first to locate answer text in ${doc}`)
        else { spans.push({ queryId: qid, docId: doc, start: at, end: at + ans.length }); used = true }
      }
      if (!used) {
        if (!id && !doc && g !== 0) { err(r.line, 'Row has neither a relevant id nor a span'); skipped++; continue }
        // A query explicitly labelled with nothing relevant still counts as labelled.
        qrels[qid] ??= {}
      }
      ok++
    }
    return { fragment: { qrels, spans }, issues, ok, skipped, summary: `${Object.keys(qrels).length} queries judged${spans.length ? `, ${spans.length} gold spans` : ''}` }
  }

  // Flat run log: long (one row per retrieved chunk) or wide (one row per query with a list of ids).
  const by = new Map<string, { row: RunRow; ranks: number[]; line: number }>()
  for (const r of p.recs) {
    const qid = str(field(r, 'queryId'))
    if (!qid) { err(r.line, 'Missing query id'); skipped++; continue }
    const e = by.get(qid) ?? { row: { queryId: qid, retrieved: [] }, ranks: [], line: r.line }
    const q = str(field(r, 'query')); if (q) e.row.query = q
    const a = str(field(r, 'answer')); if (a) e.row.answer = a
    if (map.cited && str(field(r, 'cited'))) e.row.cited = list(field(r, 'cited'))
    if (map.retrievedIds && str(field(r, 'retrievedIds'))) {
      for (const id of list(field(r, 'retrievedIds'))) { e.row.retrieved.push({ id }); e.ranks.push(e.ranks.length + 1) }
    } else {
      const id = str(field(r, 'chunkId'))
      if (!id) { err(r.line, 'Missing retrieved chunk id'); skipped++; continue }
      const rank = num(field(r, 'rank')), score = num(field(r, 'score')), rerank = num(field(r, 'rerank'))
      if (Number.isNaN(rank)) warn(r.line, 'Rank is not a number; using file order')
      const it: Retrieved = { id }
      if (score !== undefined && !Number.isNaN(score)) it.score = score
      if (rerank !== undefined && !Number.isNaN(rerank)) it.rerank = rerank
      e.row.retrieved.push(it)
      e.ranks.push(rank !== undefined && !Number.isNaN(rank) ? rank : e.ranks.length + 1e6)
    }
    by.set(qid, e); ok++
  }
  const rows = [...by.values()].map(({ row, ranks }) => {
    const hasRank = !!map.rank
    const order = row.retrieved.map((x, i) => ({ x, i, r: ranks[i] }))
    order.sort((a, b) => hasRank ? a.r - b.r || a.i - b.i : map.score && a.x.score !== undefined && b.x.score !== undefined ? b.x.score - a.x.score || a.i - b.i : a.i - b.i)
    return { ...row, retrieved: order.map(o => o.x) }
  })
  return { fragment: { run: { rows: dedupeRows(rows, issues) } }, issues, ok, skipped, summary: `${rows.length} queries, ${ok} rows` }
}

function dedupeRows(rows: RunRow[], issues: Issue[]): RunRow[] {
  const seen = new Map<string, RunRow>()
  for (const r of rows) {
    if (seen.has(r.queryId)) issues.push({ line: 0, level: 'warning', message: `Query ${r.queryId} appears more than once; kept the last log` })
    const ids = new Set<string>()
    r.retrieved = r.retrieved.filter(x => ids.has(x.id) ? false : (ids.add(x.id), true))
    seen.set(r.queryId, r)
  }
  return [...seen.values()]
}

/** Folds an import into the dataset. Corpus and queries merge by id; qrels merge per query; runs are added. */
export function mergeFragment(ds: Dataset, f: Fragment, runMeta?: { id: string; name: string; createdAt: number; notes?: string }): Dataset {
  const next: Dataset = { ...ds }
  if (f.corpus) { const m = new Map(ds.corpus.map(c => [c.id, c])); for (const c of f.corpus) m.set(c.id, c); next.corpus = [...m.values()] }
  if (f.queries) { const m = new Map(ds.queries.map(q => [q.id, q])); for (const q of f.queries) m.set(q.id, q); next.queries = [...m.values()] }
  if (f.qrels) { next.qrels = { ...ds.qrels }; for (const [q, j] of Object.entries(f.qrels)) next.qrels[q] = { ...(ds.qrels[q] ?? {}), ...j } }
  if (f.spans?.length) {
    const key = (s: GoldSpan) => `${s.queryId}|${s.docId}|${s.start}|${s.end}`
    const m = new Map(ds.spans.map(s => [key(s), s])); for (const s of f.spans) m.set(key(s), s); next.spans = [...m.values()]
  }
  if (f.run && runMeta) {
    next.runs = [...ds.runs, { ...runMeta, rows: f.run.rows }]
    // Query text from the log fills in queries the user never imported separately.
    const known = new Set(next.queries.map(q => q.id))
    const extra = f.run.rows.filter(r => r.query && !known.has(r.queryId)).map(r => ({ id: r.queryId, text: r.query! }))
    if (extra.length) next.queries = [...next.queries, ...extra]
  }
  return next
}

/** Brings back a dataset as it was before an edit, keeping anything added since. */
export function restoreDataset(before: Dataset, now: Dataset): Dataset {
  const added = now.runs.filter(r => !before.runs.some(b => b.id === r.id))
  return { ...mergeFragment(before, { corpus: now.corpus, queries: now.queries, qrels: now.qrels, spans: now.spans }), runs: [...before.runs, ...added] }
}

// ---------- Writers (round-trip the sample, export data) ----------

export const runToJsonl = (run: Run) => run.rows.map(r => JSON.stringify({ query_id: r.queryId, query: r.query, retrieved: r.retrieved.map(x => ({ id: x.id, score: x.score, ...(x.rerank !== undefined ? { rerank_score: x.rerank } : {}) })), answer: r.answer, cited: r.cited })).join('\n') + '\n'
export const corpusToJsonl = (c: Chunk[]) => c.map(x => JSON.stringify({ chunk_id: x.id, doc_id: x.docId, title: x.title, start: x.start, end: x.end, text: x.text })).join('\n') + '\n'
export const queriesToJsonl = (q: Query[]) => q.map(x => JSON.stringify({ query_id: x.id, query: x.text, tags: x.tags, intent: x.intent })).join('\n') + '\n'
export function qrelsToTsv(qrels: Qrels, spans: GoldSpan[]): string {
  const lines = ['query-id\tcorpus-id\tscore\tdoc_id\tstart\tend']
  for (const [q, j] of Object.entries(qrels)) {
    const entries = Object.entries(j)
    if (!entries.length) lines.push(`${q}\t\t0\t\t\t`)
    for (const [id, g] of entries) lines.push(`${q}\t${id}\t${g}\t\t\t`)
  }
  for (const s of spans) lines.push(`${s.queryId}\t\t3\t${s.docId}\t${s.start}\t${s.end}`)
  return lines.join('\n') + '\n'
}
