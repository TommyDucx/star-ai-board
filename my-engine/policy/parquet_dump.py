#!/usr/bin/env python3
"""Lichess chess-position-evaluations parquet → TSV 流式转换。

输出每行: `FEN<TAB>cp_white<TAB>mate<TAB>depth`（cp/mate 为**白方视角**，
mate 行为空 cp；cp 行为空 mate）。直接走 stdout，可管道给 data-etl。

用法:
  python3 parquet_dump.py --parquet data_0000.parquet --min-depth 15
    | ../data-etl/target/release/data-etl --input - --output data/nnue/train.scnn ...
"""
import argparse
import sys

import pyarrow.parquet as pq


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", required=True)
    ap.add_argument("--min-depth", type=int, default=15, help="预过滤深度下限（减少管道体积）")
    ap.add_argument("--max-rows", type=int, default=0, help="仅处理前 N 行（调试用，0=全部）")
    args = ap.parse_args()

    pf = pq.ParquetFile(args.parquet)
    out = sys.stdout
    wrote = 0
    for rg in range(pf.num_row_groups):
        batch = pf.read_row_group(rg)
        if args.max_rows and wrote >= args.max_rows:
            break
        cols = batch.select(["fen", "cp", "mate", "depth"])
        for row in cols.to_pylist():
            fen = row["fen"]
            if fen is None:
                continue
            cp = "" if row["cp"] is None else row["cp"]
            mate = "" if row["mate"] is None else row["mate"]
            depth = row["depth"]
            if args.min_depth and depth < args.min_depth:
                continue
            out.write(f"{fen}\t{cp}\t{mate}\t{depth}\n")
            wrote += 1
            if args.max_rows and wrote >= args.max_rows:
                break
        if args.max_rows and wrote >= args.max_rows:
            break
        out.flush()
    sys.stderr.write(f"dumped {wrote} rows\n")


if __name__ == "__main__":
    main()
