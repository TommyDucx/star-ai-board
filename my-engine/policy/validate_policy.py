#!/usr/bin/env python3
"""验证 policy.onnx：对给定 FEN 推理并解码 top 走法"""
import sys
import numpy as np
import onnxruntime as ort

def fen_to_tensor(fen: str):
    PIECE = {"P":0,"N":1,"B":2,"R":3,"Q":4,"K":5,
             "p":6,"n":7,"b":8,"r":9,"q":10,"k":11}
    t = np.zeros((13, 8, 8), dtype=np.float32)
    rows = fen.split()[0].split("/")
    for r, row in enumerate(rows):
        c = 0
        for ch in row:
            if ch.isdigit():
                c += int(ch)
            else:
                t[PIECE[ch]][r][c] = 1.0
                c += 1
    if fen.split()[1] == "b":
        t[12].fill_(1.0) if False else t[12].fill(1.0)
    return t

def idx_to_sq(i):
    return f"{chr(97 + i % 8)}{i // 8 + 1}"

def main():
    fen = sys.argv[1] if len(sys.argv) > 1 else \
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    sess = ort.InferenceSession(
        "/Users/tommydu/Documents/Default Project/star/my-engine/policy/policy.onnx",
        providers=["CPUExecutionProvider"])
    out = sess.run(["policy"], {"board": fen_to_tensor(fen)[None]})[0][0]
    top = np.argsort(-out)[:n]
    for i, lab in enumerate(top):
        fi, ti = divmod(lab, 64)
        print(f"{i+1}. {idx_to_sq(fi)}{idx_to_sq(ti)}  p={np.exp(out[lab]) / np.sum(np.exp(out)):.4f}")

if __name__ == "__main__":
    main()
