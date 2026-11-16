// Public benchmark sample: 80 test queries from BEIR's Natural Questions with their real judgments, and three
// real runs scored over the full 2.68M-passage corpus (see scripts/nq-sample). Nothing in it is generated.
import type { Dataset } from './types.ts'

export const PUBLIC_SAMPLE_ID = 'nq-beir'
export const PUBLIC_SAMPLE_META = {
  id: PUBLIC_SAMPLE_ID,
  name: 'Natural Questions (BEIR subset)',
  blurb: '80 real search queries, Wikipedia passages, BEIR judgments, BM25 vs cross-encoder rerank',
  kind: 'public' as const,
  file: '/samples/nq-beir-80.json',
  baseRunId: 'nq-bm25-title',
  candRunId: 'nq-bm25-ce',
}

export interface PublicSampleFile {
  id: string; name: string; source: string; url: string; licence: string; retrieved: string; selection: string; corpusSize: number
  queries: { id: string; text: string }[]
  qrels: Record<string, Record<string, number>>
  corpus: { id: string; title: string; text: string }[]
  /** Rows are [chunk id, score, rerank score?] in ranked order. */
  runs: { id: string; name: string; notes: string; rows: { q: string; r: [string, number, number?][] }[] }[]
}

const WH = ['who', 'when', 'where', 'what', 'which', 'how', 'why']
/** Question word, for the intent slice. NQ queries are lowercased search queries, so many have none. */
export const questionWord = (text: string) => WH.find(w => new RegExp(`\\b${w}\\b`).test(text.toLowerCase().split(/\s+/).slice(0, 3).join(' '))) ?? 'other'

export function buildPublicSample(f: PublicSampleFile): Dataset {
  const at = Date.parse(f.retrieved)
  return {
    // Passages of one Wikipedia article share a title, so the article is the document.
    corpus: f.corpus.map(c => ({ id: c.id, docId: c.title || c.id, title: c.title, text: c.text })),
    queries: f.queries.map(q => ({ id: q.id, text: q.text, intent: questionWord(q.text) })),
    qrels: f.qrels,
    spans: [],
    runs: f.runs.map((r, i) => ({
      id: r.id, name: r.name, notes: r.notes, createdAt: at + i * 60_000,
      rows: r.rows.map(row => ({ queryId: row.q, retrieved: row.r.map(([id, score, rerank]) => ({ id, score, ...(rerank !== undefined && rerank !== null ? { rerank } : {}) })) })),
    })),
  }
}
