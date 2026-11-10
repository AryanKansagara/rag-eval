import type { Chunk, Retrieved } from './types.ts'

const STOP = new Set('a an and are as at be but by can do does for from has have how i if in into is it its me my of on or our so that the their them then there this to was we what when where which who why will with you your'.split(' '))

/** Lowercased word tokens with stopwords removed. Keeps codes like e-4012 as "e" + "4012". */
export function terms(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t && !STOP.has(t))
}

/** Whitespace tokens with character offsets. Used as the token unit for chunk sizes. */
export function wordSpans(text: string): { s: number; e: number }[] {
  const out: { s: number; e: number }[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push({ s: m.index, e: m.index + m[0].length })
  return out
}

export const tokenCount = (text: string) => wordSpans(text).length

// ---------- BM25 ----------

export interface Bm25 { search(q: string, depth?: number): Retrieved[]; score(q: string, id: string): number; size: number }

export function bm25(chunks: Pick<Chunk, 'id' | 'text' | 'title'>[], k1 = 1.2, b = 0.75): Bm25 {
  const tf: Map<string, number>[] = []
  const len: number[] = []
  const df = new Map<string, number>()
  const post = new Map<string, number[]>()
  const index = new Map<string, number>()
  chunks.forEach((c, i) => {
    const t = terms((c.title ? c.title + ' ' : '') + c.text)
    const m = new Map<string, number>()
    for (const w of t) m.set(w, (m.get(w) ?? 0) + 1)
    tf.push(m); len.push(t.length); index.set(c.id, i)
    for (const w of m.keys()) { df.set(w, (df.get(w) ?? 0) + 1); let p = post.get(w); if (!p) post.set(w, p = []); p.push(i) }
  })
  const N = chunks.length
  const avg = len.reduce((a, x) => a + x, 0) / (N || 1)
  const idf = (w: string) => { const n = df.get(w) ?? 0; return Math.log(1 + (N - n + 0.5) / (n + 0.5)) }
  const termScore = (w: string, i: number) => {
    const f = tf[i].get(w) ?? 0
    return f ? idf(w) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len[i] / (avg || 1))) : 0
  }
  const qterms = (q: string) => [...new Set(terms(q))]
  return {
    size: N,
    score(q, id) { const i = index.get(id); return i === undefined ? 0 : qterms(q).reduce((s, w) => s + termScore(w, i), 0) },
    search(q, depth = 100) {
      const acc = new Map<number, number>()
      for (const w of qterms(q)) for (const i of post.get(w) ?? []) acc.set(i, (acc.get(i) ?? 0) + termScore(w, i))
      return [...acc].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, depth).map(([i, s]) => ({ id: chunks[i].id, score: s }))
    },
  }
}

/** Reciprocal rank fusion of several ranked lists. */
export function rrf(lists: Retrieved[][], k = 60, depth = 100): Retrieved[] {
  const s = new Map<string, number>()
  for (const l of lists) l.forEach((r, i) => s.set(r.id, (s.get(r.id) ?? 0) + 1 / (k + i + 1)))
  return [...s].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, depth).map(([id, score]) => ({ id, score }))
}

// ---------- MinHash near-duplicates ----------

function hash32(s: string, seed: number) {
  let h = 2166136261 ^ seed
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15
  return h >>> 0
}

export function shingles(text: string, n = 5): Set<string> {
  const w = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const out = new Set<string>()
  if (w.length < n) { if (w.length) out.add(w.join(' ')); return out }
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '))
  return out
}

export const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size && !b.size) return 1
  let i = 0
  for (const x of a) if (b.has(x)) i++
  return i / (a.size + b.size - i)
}

export function minhash(sh: Set<string>, perms = 64): Uint32Array {
  const sig = new Uint32Array(perms).fill(0xffffffff)
  for (const s of sh) for (let p = 0; p < perms; p++) { const h = hash32(s, p * 0x9e3779b1); if (h < sig[p]) sig[p] = h }
  return sig
}

export interface DupPair { a: string; b: string; similarity: number; exact: boolean }

/** Exact and near-duplicate chunk pairs via MinHash LSH (16 bands x 4 rows), verified with exact Jaccard. */
export function nearDuplicates(chunks: Pick<Chunk, 'id' | 'text'>[], threshold = 0.8): DupPair[] {
  const norm = chunks.map(c => c.text.toLowerCase().replace(/\s+/g, ' ').trim())
  const sh = chunks.map(c => shingles(c.text))
  const sigs = sh.map(s => minhash(s))
  const cand = new Set<string>()
  const bands = 16, rows = 4
  for (let bnd = 0; bnd < bands; bnd++) {
    const buckets = new Map<string, number[]>()
    sigs.forEach((sig, i) => {
      if (!sh[i].size) return
      const key = Array.from(sig.slice(bnd * rows, bnd * rows + rows)).join(',')
      const l = buckets.get(key); if (l) l.push(i); else buckets.set(key, [i])
    })
    for (const l of buckets.values()) if (l.length > 1 && l.length < 200) for (let x = 0; x < l.length; x++) for (let y = x + 1; y < l.length; y++) cand.add(l[x] + ':' + l[y])
  }
  const out: DupPair[] = []
  for (const k of cand) {
    const [i, j] = k.split(':').map(Number)
    const exact = norm[i] === norm[j]
    const sim = exact ? 1 : jaccard(sh[i], sh[j])
    if (sim >= threshold) out.push({ a: chunks[i].id, b: chunks[j].id, similarity: sim, exact })
  }
  return out.sort((x, y) => y.similarity - x.similarity || x.a.localeCompare(y.a))
}
