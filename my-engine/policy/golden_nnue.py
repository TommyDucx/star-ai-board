#!/usr/bin/env python3
"""NNUE golden test —— nnue.rs（Rust 手写前向）vs PyTorch EvalNet 逐位一致。

1. 读 nnue.bin（export_bin 格式：NNUE + u32/u32 + float32 参数，顺序 = model.parameters()），
   重建 EvalNet 权重。
2. 对每行 FEN 用 PyTorch 算 logit（输入编码 = HalfK-768，stm 视角颜色互换）。
3. 调用 my-engine 的 nnue_eval 二进制算 Rust logit。
4. 比对（float32 累加顺序差异允许小容差）。

用法:
  cargo build --release --bin nnue_eval
  python3 golden_nnue.py --nnue my-engine/policy/nnue.bin \
      --fens my-engine/policy/golden_fens.txt \
      --rust-bin my-engine/target/release/nnue_eval
"""
import argparse
import struct
import subprocess
import sys

import numpy as np
import torch

from train_nnue import EvalNet  # 复用网络结构（同目录）

TOL = 1e-3


def load_into_model(path, model):
    raw = open(path, "rb").read()
    assert raw[:4] == b"NNUE", "bad magic"
    ver, n = struct.unpack("<II", raw[4:12])
    assert ver == 1
    flat = np.frombuffer(raw[12:12 + n * 4], dtype="<f4")
    off = 0
    for p in model.parameters():
        cnt = p.numel()
        p.data = torch.from_numpy(flat[off:off + cnt].copy()).view_as(p.data)
        off += cnt
    assert off == n, f"param count mismatch {off} != {n}"


def pytorch_logits(model, fens):
    model.eval()
    out = []
    with torch.no_grad():
        for fen in fens:
            b = torch.zeros(1, 12, 8, 8)
            pieces, stm = parse_fen(fen)
            for sq, (color, pc) in pieces.items():
                eff = color if stm == "w" else (not color)
                ch = (0, 1, 2, 3, 4, 5)[pc] + (0 if eff else 6)
                b[0, ch, sq // 8, sq % 8] = 1.0
            out.append(model(b).item())
    return out


def parse_fen(fen):
    board, active = fen.split()[:2]
    sym = {"P": (True, 0), "N": (True, 1), "B": (True, 2), "R": (True, 3),
           "Q": (True, 4), "K": (True, 5),
           "p": (False, 0), "n": (False, 1), "b": (False, 2), "r": (False, 3),
           "q": (False, 4), "k": (False, 5)}
    pieces = {}
    r = 7
    for row in board.split("/"):
        c = 0
        for ch in row:
            if ch.isdigit():
                c += int(ch)
            else:
                color, pc = sym[ch]
                sq = r * 8 + c  # a1=0..h8=63, row7=a8
                pieces[sq] = (color, pc)
                c += 1
        r -= 1
    return pieces, active


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nnue", required=True)
    ap.add_argument("--fens", required=True)
    ap.add_argument("--rust-bin", required=True)
    args = ap.parse_args()

    fens = [l.strip() for l in open(args.fens) if l.strip()]
    model = EvalNet()
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
