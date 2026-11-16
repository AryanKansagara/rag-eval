# RAG Eval Desk

Retrieval evaluation for RAG systems, without an LLM judge. Import the ranked lists your retriever logged, your qrels or gold answer spans, and your chunks file, and see where retrieval breaks and whether the new pipeline version is actually better.

Live: https://rag-eval-seven.vercel.app

## The pain

Most RAG teams evaluate the generated answer with an LLM judge and end up debugging the judge. The retrieval half is cheaper to measure and is where many failures start: the gold chunk was never retrieved, it was ranked below k, the chunker cut the answer in half, or a duplicate page crowded it out.

## Features

- **Metrics with error bars**: Recall@k, Precision@k, Hit@k, nDCG@k (graded), MRR and MAP, each with a bootstrap confidence interval. Chunk, doc and gold-span levels.
- **Paired significance** between runs: paired bootstrap and sign-flip randomisation tests, per-query wins and losses.
- **Chunking diagnostics**: size distribution, boundary-cut rate (gold spans split across chunks), MinHash near-duplicates, tiny and orphan chunks.
- **Re-chunking simulator**: rebuild documents from chunk offsets and test fixed, sentence and heading strategies against gold spans, with a recommended config and splitter snippet.
- **Rerank what-if**: logged rerank scores, local BM25 rerank, BM25 only, and RRF hybrid of the logged ranking with BM25, with metric deltas and p-values.
- **Failure triage**: not retrieved, ranked low, wrong citation, too vague, unlabelled, plus boundary-cut causes. Slices by tag, intent and query length.
- **Labelling UI**: grade candidates 0 to 3 from the keyboard to build qrels.
- **Actions**: printable regression report with a ship / no-ship verdict, CI gate (thresholds JSON + dependency-free Node script), failure worklist CSV.
- **Workspace**: multiple projects in IndexedDB, snapshots with a compare view, optional Supabase sync, light and dark themes.
- **Imports**: JSONL/CSV logs, LangChain/LangSmith and LlamaIndex traces, Ragas datasets (row or column oriented, text-only contexts become labelable chunks), TREC runs and qrels, BEIR corpus, queries and qrels, with format detection, column mapping and line-numbered validation.

## Samples

- **Ledgerly help centre** is synthetic: a made-up invoicing app, 80 labelled queries with gold spans and two simulated runs. It exists to show chunk-boundary failures, which public benchmarks carry no offsets for.
- **Natural Questions (BEIR subset)** is public data: 80 test queries from the NQ split of [BEIR](https://huggingface.co/datasets/BeIR/nq) (every 43rd query from index 9) with BEIR's own judgments, and three real runs scored over the full 2,681,468-passage corpus: BM25 on passage text, BM25 with titles indexed, and BM25 top 100 reranked by `cross-encoder/ms-marco-MiniLM-L-6-v2`. The file `public/samples/nq-beir-80.json` holds the queries, judgments, runs and the 1,519 Wikipedia passages they touch. BEIR NQ is distributed as CC BY-SA 4.0, Natural Questions as CC BY-SA 3.0 and Wikipedia text as CC BY-SA; that file is shared under the same terms. Downloaded 13 November 2026. `scripts/nq-sample` rebuilds it.

## Checked against real files

- **trec_eval**: on the `qrels.test` / `results.test` pair from the [trec_eval repository](https://github.com/usnistgov/trec_eval), MAP, reciprocal rank, P@5/10/100, recall@5/10/100 and nDCG@5/10/100 match its published output to four decimals (`src/engine/real.test.ts`).
- **Ragas**: rows from [explodinggradients/amnesty_qa](https://huggingface.co/datasets/explodinggradients/amnesty_qa) (Apache-2.0), both schema versions.
- **BEIR**: `corpus.jsonl`, `queries.jsonl` and `qrels/test.tsv` of NQ.

## Known gaps

- nDCG uses gain 2^grade − 1 by default; trec_eval uses the grade itself. Settings has a linear option for graded qrels (identical on 0/1 judgments).
- The NQ sample's corpus is a pool, not all of Wikipedia, so its BM25 what-ifs search 1,519 passages. With 80 queries the intervals are wide and the numbers are not leaderboard figures.
- LangSmith and LlamaIndex importers follow the documented export shapes; they have not been run against a third-party production export.
- TREC runs are ordered by the rank column; trec_eval orders by score. The two differ only when a file's ranks and scores disagree.
- Datasets over 1.5 MB stay on the device where they were imported; only settings, labels and snapshots sync.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine tests
npm run build
```

Optional sync: copy `.env.example` to `.env` (public Supabase URL and publishable key).
