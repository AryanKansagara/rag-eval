# RAG Eval Desk

Retrieval evaluation for RAG systems, without an LLM judge. Import the ranked lists your retriever logged, your qrels or gold answer spans, and your chunks file, and see where retrieval breaks and whether the new pipeline version is actually better.

Live: https://rag-eval.vercel.app

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
- **Imports**: JSONL/CSV logs, LangChain/LangSmith and LlamaIndex traces, Ragas datasets, TREC runs and qrels, BEIR qrels, with format detection, column mapping and line-numbered validation.

The sample (a help centre for a made-up invoicing app, 80 labelled queries and two runs) is synthetic.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine tests
npm run build
```

Optional sync: copy `.env.example` to `.env` (public Supabase URL and publishable key).
