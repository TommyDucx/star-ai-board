#!/usr/bin/env python3
"""NNUE 数据 QA —— golden test（Rust ETL vs python-chess 逐位一致）。

1. 特征比对：对每个 .scnn 记录，用 python-chess 按同一 HalfK-768 规则编码，
   与 Rust 输出的 768 字节逐位比较。
2. 最优线验证：按 FEN 分组 parquet，检查 .scnn 的 cp_stm 是否为该局面最优线。
3. 分布统计。

用法:
  python3 qa_nnue.py --scnn data/nnue/train.scnn --sidecar data/nnue/train_sidecar.tsv \
      [--parquet data_0000.parquet --n-check 2000]
"""
import argparse
import random
import struct
import sys

import chess
import numpy as np

RANK1 = 0
MATE_CP = 30000


def piece_plane(piece, color):
    base = {"P": 0, "N": 1, "B": 2, "R": 3, "Q": 4, "K": 5}[piece.symbol().upper()]
    return base + (6 if color == chess.BLACK else 0)


def encode_py(fen):
    """与 data-etl/src/halfk.rs::encode 逐位一致的 HalfK-768 编码。"""
    b = chess.Board(fen)
    stm_white = b.turn == chess.WHITE
    feat = np.zeros(768, dtype=np.uint8)
    for sq in chess.SQUARES:
        pc = b.piece_at(sq)
        if pc is None:
            continue
        col = pc.color
        eff = col if stm_white else (not col)
        plane = piece_plane(pc, eff)
        feat[plane * 64 + sq] = 255
    return feat


def cp_stm_from_line(fen, cp_white, mate):
    """同 main.rs：白方视角 → 轮走方视角。"""
    stm_white = fen.split()[1] == "w"
    if mate is not None:
        m = mate if stm_white else -mate
        return 30000 - 2 * m if m > 0 else -30000 - 2 * m
    return cp_white if stm_white else -cp_white


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scnn", required=True)
    ap.add_argument("--sidecar", required=True)
    ap.add_argument("--parquet", default="")
    ap.add_argument("--n-check", type=int, default=2000)
    ap.add_argument("--scan-rows", type=int, default=0, help="最优线验证扫描行数（0=全部）")
    args = ap.parse_args()

    with open(args.scnn, "rb") as f:
        magic = f.read(4)
        ver = struct.unpack("<I", f.read(4))[0]
        n = struct.unpack("<Q", f.read(8))[0]
        dim = struct.unpack("<I", f.read(4))[0]
        print(f"header: magic={magic} v={ver} N={n} dim={dim}")
        assert magic == b"SCNN" and ver == 1 and dim == 768
        recs = f.read()
    assert len(recs) == n * (768 + 8), f"record bytes mismatch {len(recs)}"

    feats = np.frombuffer(recs, dtype=np.uint8).reshape(n, 768 + 8)[:, :768].copy()
    cps = np.frombuffer(recs, dtype=np.uint8).reshape(n, 768 + 8)[:, 768:772].copy()
    cps = cps.view(np.float32).reshape(-1)

    fens = []
    with open(args.sidecar) as f:
        for line in f:
            fen = line.split("\t")[0]
            fens.append(fen)
    assert len(fens) == n, f"sidecar rows {len(fens)} != records {n}"

    random.seed(42)
    idx = random.sample(range(n), min(args.n_check, n))
    bad = 0
    for i in idx:
        ref = encode_py(fens[i])
        if not np.array_equal(ref, feats[i]):
            bad += 1
            if bad <= 3:
                diff = np.where(ref != feats[i])[0][:8]
                print(f"  FEATURE MISMATCH row {i}: {fens[i]} diffs={diff}")
    print(f"feature golden test: {len(idx) - bad}/{len(idx)} match"
          f"{'  FAIL' if bad else ''}")

    if args.parquet:
        import pyarrow.parquet as pq
        want = set(fens)
        pf = pq.ParquetFile(args.parquet)
        best = {}
        rows_done = 0
        for rg in range(pf.num_row_groups):
            rows = pf.read_row_group(rg).select(["fen", "cp", "mate"]).to_pylist()
            rows_done += len(rows)
            for r in rows:
                fen = r["fen"]
                if fen not in want:
                    continue
                key = (fen, fen.split()[1])
                c = cp_stm_from_line(fen, r["cp"] or 0, r["mate"])
                if key not in best or c > best[key]:
                    best[key] = c
            if args.scan_rows and rows_done > args.scan_rows:
                break
        bad2 = 0
        checked = 0
        for i in idx:
            fen = fens[i]
            key = (fen, fen.split()[1])
            if key not in best:
                continue
            checked += 1
            want = max(-2000, min(2000, best[key]))
            if abs(want - cps[i]) > 1:
                bad2 += 1
                if bad2 <= 3:
                    print(f"  LABEL MISMATCH row {i}: got {cps[i]} want {best[key]} {fen}")
        print(f"best-line label check: {checked - bad2}/{checked} match"
              f"{'  FAIL' if bad2 else ''}")

    c = cps[~np.isnan(cps)]
    print(f"cp_stm stats: mean={c.mean():.1f} std={c.std():.1f} "
          f"p(|cp|<=50)={np.mean(np.abs(c)<=50):.3f} "
          f"p(|cp|>=1000)={np.mean(np.abs(c)>=1000):.3f}")


if __name__ == "__main__":
    main()
