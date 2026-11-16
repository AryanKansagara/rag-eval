import sys, json, pyarrow.parquet as pq
src, dst = sys.argv[1], sys.argv[2]
f = pq.ParquetFile(src)
print(f.schema_arrow, f.metadata.num_rows)
with open(dst, 'w') as out:
    for b in f.iter_batches(batch_size=50000):
        for r in b.to_pylist():
            out.write(json.dumps(r, ensure_ascii=False) + '\n')
