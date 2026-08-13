#!/usr/bin/env python3
"""
B(teacher): 用 Stockfish 为现有数据集的每一个 FEN 生成"强走法"标签，
替代原先 depth-1 自对弈的弱走法，直接提升监督质量。
输出: data/teacher_dataset.jsonl（schema 与 final_dataset 一致，仅 bestmove_uci 换成 SF 的着法）。
"""
import argparse, json, os, subprocess, sys, threading, time
import chess

SF = "/Users/tommydu/Documents/Default Project/star/public/stockfish"
DATA = "/Users/tommydu/Documents/Default Project/data/final_dataset.jsonl"
OUT = "/Users/tommydu/Documents/Default Project/data/teacher_dataset.jsonl"
DEPTH = 5


class SFEngine:
    def __init__(self, sf_path, depth):
        self.depth = depth
        self.proc = subprocess.Popen(
            [sf_path], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        self._send("uci")
        self._read_until("uciok", 15)
        self._send("setoption name Hash value 128")
        self._send("setoption name Threads value 4")
        self._send("isready")
        self._read_until("readyok", 15)

    def _send(self, c):
        try:
            self.proc.stdin.write(c + "\n"); self.proc.stdin.flush()
        except Exception:
            pass

    def _read_until(self, token, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                return None
            if line.strip() == token:
                return line.strip()
        return None

    def bestmove(self, fen):
        self._send(f"position fen {fen}")
        self._send(f"go depth {self.depth}")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                return None
            if line.startswith("bestmove"):
                parts = line.split()
                if len(parts) >= 2 and parts[1] != "(none)":
                    return parts[1]
                return None
        return None

    def quit(self):
        try:
            self._send("quit"); self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sf", default=SF)
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--depth", type=int, default=DEPTH)
    args = ap.parse_args()

    sf = SFEngine(args.sf, args.depth)
    rows = [json.loads(l) for l in open(args.data)]
    out = open(args.out, "w")
    n = len(rows)
    t0 = time.time()
    kept = 0
    for i, r in enumerate(rows):
        fen = r["fen"]
        # 跳过终局位置
        try:
            b = chess.Board(fen)
            if b.is_game_over():
                continue
        except Exception:
            continue
        bm = sf.bestmove(fen)
        if not bm:
            continue
        try:
            mv = chess.Move.from_uci(bm)
            if mv not in b.legal_moves:
                continue
        except Exception:
            continue
        rec = dict(r)
        rec["bestmove_uci"] = bm
        rec["meta"] = "stockfish_teacher_depth%d" % args.depth
        out.write(json.dumps(rec, ensure_ascii=False) + "\n")
        kept += 1
        if (i + 1) % 200 == 0:
            print(f"  {i+1}/{n}  kept={kept}  t={time.time()-t0:.0f}s", flush=True)
    out.close()
    sf.quit()
    print(f"done: {kept}/{n}  ->  {args.out}")


if __name__ == "__main__":
    main()
