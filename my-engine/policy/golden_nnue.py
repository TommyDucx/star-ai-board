#!/usr/bin/env python3
"""NNUE golden test —— nnue.rs v2 增量架构（Rust 手写前向）vs PyTorch 逐位一致。

1. 读 nnue_inc.bin（v2：NNUE + u32/u32 + float32 参数，顺序 = NnueInc.parameters()）。
2. 对每行 FEN 用 PyTorch 算 logit（输入 = HalfK-768 **fixed-color**，不按 stm 翻色）。
3. 调用 my-engine 的 nnue_eval 二进制算 Rust logit。
4. 比对（float32 累加顺序差异允许小容差）。

用法:
  cargo build --release --bin nnue_eval
  python3 golden_nnue.py --nnue my-engine/policy/nnue_inc.bin \
      --fens my-engine/policy/golden_fens.txt \
      --rust-bin my-engine/nnue/target/release/nnue_eval
"""
import argparse
import struct
import subprocess
import sys

import numpy as np
import torch

from train_nnue_incremental import NnueInc  # 复用增量架构（同目录）

TOL = 1e-3


def load_into_model(path, model):
    raw = open(path, "rb").read()
    assert raw[:4] == b"NNUE", "bad magic"
    ver, n = struct.unpack("<II", raw[4:12])
    assert ver == 2, f"需要 v2 增量架构，got {ver}"
    flat = np.frombuffer(raw[12:12 + n * 4], dtype="<f4")
    off = 0
    for p in model.parameters():
        cnt = p.numel()
        p.data = torch.from_numpy(flat[off:off + cnt].copy()).view_as(p.data)
        off += cnt
    assert off == n, f"param count mismatch {off} != {n}"


def parse_fen_fixed(fen):
    """fixed-color：白=0-5/黑=6-11，不按 stm 翻色。"""
    board, _ = fen.split()[:2]
    sym = {"P": (True, 0), "N": (True, 1), "B": (True, 2), "R": (True, 3),
           "Q": (True, 4), "K": (True, 5),
           "p": (False, 0), "n": (False, 1), "b": (False, 2), "r": (False, 3),
           "q": (False, 4), "k": (False, 5)}
    feats = {}
    r = 7
    for row in board.split("/"):
        c = 0
        for ch in row:
            if ch.isdigit():
                c += int(ch)
            else:
                is_white, pc = sym[ch]
                sq = r * 8 + c
                feats[sq] = (is_white, pc)
                c += 1
        r -= 1
    return feats


def pytorch_logits(model, fens):
    model.eval()
    out = []
    with torch.no_grad():
        for fen in fens:
            x = torch.zeros(1, 768)
            for sq, (is_white, pc) in parse_fen_fixed(fen).items():
                ch = pc + (0 if is_white else 6)
                x[0, ch * 64 + sq] = 1.0
            out.append(model(x).item())
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nnue", required=True)
    ap.add_argument("--fens", required=True)
    ap.add_argument("--rust-bin", required=True)
    args = ap.parse_args()

    fens = [l.strip() for l in open(args.fens) if l.strip()]
    model = NnueInc()
    load_into_model(args.nnue, model)

    py = pytorch_logits(model, fens)
    rs = subprocess.run([args.rust_bin, args.nnue],
                        input="\n".join(fens) + "\n",
                        capture_output=True, text=True)
    if rs.returncode != 0:
        print("rust bin 失败:", rs.stderr)
        sys.exit(1)
    rust = [float(x) for x in rs.stdout.split()]

    assert len(py) == len(rust) == len(fens), f"长度不一致 {len(py)}/{len(rust)}/{len(fens)}"
    diffs = [abs(a - b) for a, b in zip(py, rust)]
    maxd = max(diffs)
    bad = sum(d > TOL for d in diffs)
    print(f"fens={len(fens)} max_abs_diff={maxd:.6f} over_tol={bad}")
    for i, d in enumerate(diffs):
        if d > TOL:
            print(f"  MISMATCH {i}: py={py[i]:.6f} rust={rust[i]:.6f} diff={d:.6f} {fens[i]}")
    if bad:
        print("GOLDEN TEST FAIL")
        sys.exit(1)
    print("GOLDEN TEST PASS")


if __name__ == "__main__":
    main()
