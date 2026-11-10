// Core data shapes. Everything the engine needs is plain JSON so it can live in IndexedDB and sync.

export interface Chunk {
  id: string
  docId: string
  text: string
  /** Character offsets into the source document, when the chunker recorded them. */
  start?: number
  end?: number
  title?: string
}

export interface Query {
  id: string
  text: string
  tags?: string[]
  intent?: string
}

export interface Retrieved {
  id: string
  score?: number
  /** A second-stage score the user logged (for example a reranker run). */
  rerank?: number
}

export interface RunRow {
  queryId: string
  query?: string
  retrieved: Retrieved[]
  answer?: string
  cited?: string[]
}

export interface Run {
  id: string
  name: string
  createdAt: number
  rows: RunRow[]
  /** Free text: chunker, embedder, k, anything that changed. */
  notes?: string
}

/** Graded judgments. Keys are chunk ids or doc ids (the engine resolves both). */
export type Qrels = Record<string, Record<string, number>>

export interface GoldSpan {
  queryId: string
  docId: string
  start: number
  end: number
}

export interface Dataset {
  corpus: Chunk[]
  queries: Query[]
  qrels: Qrels
  spans: GoldSpan[]
  runs: Run[]
}

export type Level = 'chunk' | 'doc' | 'span'

export const emptyDataset = (): Dataset => ({ corpus: [], queries: [], qrels: {}, spans: [], runs: [] })
