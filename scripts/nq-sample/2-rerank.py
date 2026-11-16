import json, sys
from sentence_transformers import CrossEncoder
# usage: python 2-rerank.py <dir with corpus.jsonl and test.tsv> <bm25.json> <out rerank.json>
D = sys.argv[1].rstrip('/') + '/'
b = json.load(open(sys.argv[2]))
gold = {}
for l in open(D + 'test.tsv').read().strip().split('\n')[1:]:
    q, d, s = l.split('\t')
    if int(s) > 0: gold.setdefault(q, []).append(d)
need = set()
for i, q in enumerate(b['queries']):
    need.update(x['id'] for x in b['titleText'][i]); need.update(x['id'] for x in b['text'][i][:10]); need.update(gold[q['_id']])
docs = {}
with open(D + 'corpus.jsonl') as f:
    for l in f:
        i = l[9:l.index('"', 9)]
        if i in need: docs[i] = json.loads(l)
assert len(docs) == len(need), (len(docs), len(need))
m = CrossEncoder('cross-encoder/ms-marco-MiniLM-L-6-v2', max_length=512)
out = []
for i, q in enumerate(b['queries']):
    ids = [x['id'] for x in b['titleText'][i]]
    s = m.predict([(q['text'], (docs[d]['title'] + '. ' + docs[d]['text'])) for d in ids], batch_size=32)
    out.append([{'id': d, 'ce': round(float(v), 4)} for d, v in zip(ids, s)])
    print(i, file=sys.stderr, end=' ', flush=True)
json.dump({'rerank': out, 'docs': docs, 'gold': gold}, open(sys.argv[3], 'w'), ensure_ascii=False)
