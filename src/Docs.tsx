import { Code, Link } from './ui.tsx'

const PLAIN = `# Plain Python: one JSON line per query, written wherever you call the retriever.
import json, time

def log_retrieval(f, query_id, query, hits, answer=None, cited=None):
    """hits: list of (chunk_id, score) or (chunk_id, score, rerank_score), best first."""
    f.write(json.dumps({
        "query_id": query_id,
        "query": query,
        "retrieved": [
            {"id": h[0], "score": float(h[1]), **({"rerank_score": float(h[2])} if len(h) > 2 else {})}
            for h in hits
        ],
        "answer": answer,
        "cited": cited or [],
        "ts": time.time(),
    }) + "\\n")

with open("run-v2.jsonl", "a") as f:
    for q in eval_queries:                      # your labelled queries
        hits = retriever.search(q["text"], k=10)
        log_retrieval(f, q["id"], q["text"], [(h.id, h.score) for h in hits])`

const LANGCHAIN = `# LangChain: a callback that logs every retriever call, with chunk ids from metadata.
import json
from langchain_core.callbacks import BaseCallbackHandler

class RetrievalLogger(BaseCallbackHandler):
    def __init__(self, path, query_id):
        self.f, self.query_id, self.query = open(path, "a"), query_id, None
    def on_retriever_start(self, serialized, query, **kw):
        self.query = query
    def on_retriever_end(self, documents, **kw):
        self.f.write(json.dumps({
            "query_id": self.query_id,
            "query": self.query,
            "retrieved": [{"id": d.metadata.get("chunk_id") or d.id,
                           "score": d.metadata.get("score"),
                           "rerank_score": d.metadata.get("relevance_score")} for d in documents],
        }) + "\\n")
        self.f.flush()

for q in eval_queries:
    chain.invoke(q["text"], config={"callbacks": [RetrievalLogger("run-v2.jsonl", q["id"])]})

# LangSmith exports also work as-is: export the retriever runs as JSONL.
# Put query_id in the run metadata (config={"metadata": {"query_id": ...}}) so it can be joined to qrels.`

const LLAMA = `# LlamaIndex: log source_nodes from each response (or dump the response objects as JSON).
import json
with open("run-v2.jsonl", "a") as f:
    for q in eval_queries:
        resp = query_engine.query(q["text"])
        f.write(json.dumps({
            "query_id": q["id"],
            "query": q["text"],
            "retrieved": [{"id": n.node.node_id, "score": n.score} for n in resp.source_nodes],
            "answer": str(resp),
        }) + "\\n")

# Corpus with offsets: SentenceSplitter and friends record start_char_idx / end_char_idx.
with open("corpus.jsonl", "w") as f:
    for n in nodes:
        f.write(json.dumps({"chunk_id": n.node_id, "doc_id": n.ref_doc_id, "text": n.text,
                            "start": n.start_char_idx, "end": n.end_char_idx}) + "\\n")`

const COHERE = `# Logging a rerank stage (for example Cohere Rerank) next to the first-stage score.
rr = co.rerank(model="rerank-v3.5", query=q["text"], documents=[h.text for h in hits], top_n=len(hits))
rerank = {hits[r.index].id: r.relevance_score for r in rr.results}
log_retrieval(f, q["id"], q["text"], [(h.id, h.score, rerank[h.id]) for h in hits])
# The Rerank what-if tab then shows what reordering by rerank_score does to every metric.`

const SQL = `-- If retrievals are logged to Postgres, export the long CSV format directly.
COPY (
  SELECT query_id, query_text AS query, rank, chunk_id, score, rerank_score
  FROM retrieval_log
  WHERE pipeline_version = 'v2' AND created_at >= now() - interval '7 days'
  ORDER BY query_id, rank
) TO STDOUT WITH CSV HEADER;`

export default function Docs() {
  return (
    <section className="page narrow docs">
      <div className="eyebrow">Docs</div>
      <h1>Getting your data in</h1>
      <p className="lede">Four files, all optional except one run: a <b>retrieval log</b> per pipeline version, <b>qrels</b> (or gold spans), the <b>chunks</b> file, and <b>queries</b> with tags. Everything is parsed in your browser.</p>
      <nav className="toc" aria-label="On this page">
        <a href="#logging">Logging runs</a><a href="#formats">Run formats</a><a href="#qrels">Qrels and gold spans</a><a href="#corpus">Corpus</a><a href="#queries">Queries</a><a href="#metrics">Metrics</a><a href="#ci">CI gate</a><a href="#privacy">Data and sync</a>
      </nav>

      <h2 id="logging">Logging retrieval runs</h2>
      <p>Run your labelled queries through the pipeline and write one line per query with the ranked chunk ids. Log the same queries for every version you want to compare, and keep chunk ids stable between runs (or re-import the corpus when you re-chunk).</p>
      <Code code={PLAIN} label="Plain Python" />
      <Code code={LANGCHAIN} label="LangChain / LangSmith" />
      <Code code={LLAMA} label="LlamaIndex" />
      <Code code={COHERE} label="Rerank scores" />
      <Code code={SQL} label="SQL export" />

      <h2 id="formats">Run formats the importer detects</h2>
      <ul>
        <li><b>JSONL</b> with <code>query_id</code>, <code>query</code>, and a list under <code>retrieved</code>, <code>results</code>, <code>hits</code> or <code>documents</code>. Items may be ids or objects with <code>id</code>/<code>chunk_id</code>, <code>score</code>, <code>rerank_score</code>. Optional <code>answer</code> and <code>cited</code> (chunk ids) feed the wrong-citation bucket.</li>
        <li><b>CSV, long</b>: one row per retrieved chunk with <code>query_id, query, rank, chunk_id, score, rerank_score</code>. <b>CSV, wide</b>: one row per query with <code>retrieved_ids</code> separated by <code>|</code>.</li>
        <li><b>LangChain / LangSmith</b> run exports (<code>inputs</code>/<code>outputs.documents</code>), <b>LlamaIndex</b> responses (<code>source_nodes</code>), <b>Ragas</b> rows (<code>user_input</code>, <code>retrieved_contexts</code> or <code>retrieved_context_ids</code>). Context strings are matched to chunks by text, so import the corpus first.</li>
        <li><b>TREC run</b> files: <code>qid Q0 docid rank score tag</code>.</li>
      </ul>
      <p>Anything else: pick the format by hand and map the columns. The validation report lists every skipped row with its line number before you commit.</p>

      <h2 id="qrels">Qrels and gold spans</h2>
      <p>Judgments say which chunks (or documents) answer each query, graded 0 to 3: 3 fully answers, 2 partly, 1 related, 0 explicitly not relevant. A query with only zero rows is "labelled, no gold" and lands in the too-vague bucket.</p>
      <ul>
        <li><b>BEIR TSV</b>: <code>query-id corpus-id score</code>. If the ids are document ids, chunk-level scoring credits the first chunk of that document once.</li>
        <li><b>TREC qrels</b>: <code>qid 0 docid relevance</code>.</li>
        <li><b>CSV or JSONL</b> with <code>query_id</code>, <code>chunk_id</code> or <code>doc_id</code>, <code>relevance</code>.</li>
        <li><b>Gold spans</b>: <code>query_id, doc_id, start, end</code> (character offsets into the document), or <code>query_id, doc_id, answer_text</code>, which is located in the document rebuilt from your chunks. Spans power gold-span scoring, the boundary-cut rate and the re-chunking simulator.</li>
      </ul>
      <p>No qrels yet? Import a run and use the <b>Label</b> tab: the union of every run&rsquo;s top 10 per query, graded with keys 0 to 3.</p>

      <h2 id="corpus">Corpus / chunks file</h2>
      <p>JSONL or CSV with <code>chunk_id</code>, <code>doc_id</code>, <code>text</code>, and <code>start</code>/<code>end</code> character offsets into the source document (LangChain: <code>add_start_index=True</code> gives <code>start_index</code>; LlamaIndex nodes carry <code>start_char_idx</code>/<code>end_char_idx</code>). Without offsets you still get sizes, duplicates and BM25, but not boundary cuts or re-chunking. A BEIR <code>corpus.jsonl</code> (<code>_id</code>, <code>title</code>, <code>text</code>) works too.</p>

      <h2 id="queries">Queries</h2>
      <p><code>query_id, query, tags, intent</code>. Tags (separated by <code>|</code>) and intent drive the slices on the Overview tab; length slices are automatic. Query text found in run logs is used when there is no queries file.</p>

      <h2 id="metrics">Metric definitions</h2>
      <ul>
        <li><b>Recall@k</b>: relevant items in the top k divided by all relevant items known for the query. <b>Precision@k</b>: relevant in the top k divided by k. <b>Hit@k</b>: 1 if anything relevant is in the top k.</li>
        <li><b>MRR</b>: 1 / rank of the first relevant item over the logged list. <b>MAP</b>: average precision at each relevant hit, divided by all relevant items.</li>
        <li><b>nDCG@k</b>: gain 2<sup>grade</sup> − 1, discount log2(rank + 1), normalised by the ideal ordering of every known grade.</li>
        <li>"Relevant" means grade ≥ 1 by default (Settings). Queries with no relevant item are excluded from means and reported separately; unlabelled queries are excluded too.</li>
        <li><b>Levels</b>: chunk (ids as judged), doc (chunks collapse to their documents), gold span (a chunk&rsquo;s grade is how much of the gold span its offsets cover: all 3, at least half 2, any 1).</li>
        <li><b>Confidence intervals</b>: 95% percentile bootstrap over queries (1,000 resamples by default, seeded). <b>Paired tests</b>: bootstrap of per-query differences shifted to the null, and a sign-flip randomisation test, 2,000 iterations each, over queries judged in both runs.</li>
        <li><b>BM25</b>: k1 = 1.2, b = 0.75, lowercase word tokens without stopwords. <b>RRF</b>: score = Σ 1 / (60 + rank), at the logged depth.</li>
        <li><b>Tokens</b> in chunk sizes are whitespace-separated words. Subword tokenizers count roughly 1.3 tokens per English word, so a 512-token splitter makes chunks of about 390 words.</li>
        <li><b>Near-duplicates</b>: 5-word shingles, 64-permutation MinHash, LSH with 16 bands of 4 rows, confirmed with exact Jaccard ≥ 0.8.</li>
      </ul>

      <h2 id="ci">CI gate</h2>
      <p>The Regression tab downloads <code>rag-thresholds.json</code>, a dependency-free <code>rag-gate.mjs</code>, and metrics files for both runs. In CI, produce the candidate metrics file with your own eval script (same JSON shape) and run <code>node rag-gate.mjs rag-thresholds.json baseline.json candidate.json</code>; it exits 1 when a floor is breached or a drop past the allowed delta is significant.</p>

      <h2 id="privacy">Data, accounts and sync</h2>
      <p>Projects live in your browser (IndexedDB). Accounts are optional: signing in syncs project settings, labels, thresholds and snapshots, plus the raw dataset when it is under 1.5 MB per project. Larger corpora and logs stay on the device where they were imported. Export everything as JSON or delete your cloud data and account from the account menu.</p>
      <p className="muted small">Assumptions as of November 2026. The sample help centre, its queries and both runs are synthetic, written for this demo. <Link href="/app?sample=ledgerly">Open the sample</Link>.</p>
    </section>
  )
}
