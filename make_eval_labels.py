#!/usr/bin/env python3
"""教师引擎深度搜索打标签（NNUE 蒸馏的标准数据范式）。

对每个 FEN 用教师引擎（默认 Stockfish，任意 UCI 引擎）搜索到指定深度，
把「搜索返回的 eval（cp）」作为标签输出。

核心思想（与 9 连败的「静态局面 + 对局结果」范式对立）：
  让待训练的静态 eval 网络逼近「深度搜索才能算出的准确估值」，
  而不是逼近「浅薄的胜负结果」。前者是 Stockfish NNUE 成功的根基，
  后者正是 9 连败（尤其两次 Texel 崩溃）的元凶。

输出：每行 `FEN<TAB>eval_cp`，eval_cp 为**行棋方视角**（正=行棋方优）。

用法：
  python3 make_eval_labels.py --eng ./public/stockfish --data data/fens.txt \
      --depth 10 --out data/eval_labels.txt --sample 200000 --workers 8
"""
import argparse
import multiprocessing as mp
import re
import subprocess
import time

import chess

MATE_SCORE = 30000  # mate 转换的 cp 上界


def mirror_fen(fen):
    """黑白互换镜像（棋盘旋转 180° + 颜色互换 + 轮走方互换），用于对称增广消偏置。"""
    try:
        return chess.Board(fen).mirror().fen()
    except Exception:
        return None


class UCIEngine:
    """极简 UCI 引擎封装：对给定 FEN 搜索到指定深度，返回搜索后的 eval(cp)。"""

    def __init__(self, eng_path, depth, threads=1):
        self.depth = depth
        # stderr 合并到 stdout：不同引擎的 info 走不同流（my-engine 走 stderr，Stockfish 走 stdout）
        self.proc = subprocess.Popen(
            [eng_path], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, bufsize=1,
        )
        self._send("uci")
        self._wait_until("uciok", 20)
        self._send(f"setoption name Threads value {threads}")
        self._send("isready")
        self._wait_until("readyok", 20)

    def _send(self, cmd):
        try:
            self.proc.stdin.write(cmd + "\n")
            self.proc.stdin.flush()
        except Exception:
            pass

    def _wait_until(self, token, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                return False
            if line.strip() == token:
                return True
        return False

    def eval_at(self, fen):
        """返回行棋方视角的 eval(cp)；搜索异常返回 None。"""
        self._send(f"position fen {fen}")
        self._send(f"go depth {self.depth}")
        eval_cp = None
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                break
            if line.startswith("bestmove"):
                break
            m = re.search(r"score cp (-?\d+)", line)
            if m:
                eval_cp = int(m.group(1))
            else:
                m = re.search(r"score mate (-?\d+)", line)
                if m:
                    n = int(m.group(1))
                    eval_cp = (MATE_SCORE - abs(n)) * (1 if n > 0 else -1)
        return eval_cp

    def quit(self):
        try:
            self._send("quit")
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def load_fens(path, sample, seed):
    """读 FEN 文件（支持纯 FEN 或 `FEN\tresult` 两种格式），返回 FEN 列表。"""
    fens = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            fen = line.split("\t")[0]  # 忽略 result 部分（若有）
            fens.append(fen)
    if sample and sample < len(fens):
        import random
        random.seed(seed)
        fens = random.sample(fens, sample)
    return fens


# worker 全局引擎（Pool initializer 里创建，每进程一个）
_engine = None


def _init_worker(eng_path, depth, threads):
    global _engine
    _engine = UCIEngine(eng_path, depth, threads)


def _label_one(fen):
    try:
        ev = _engine.eval_at(fen)
        return fen, ev
    except Exception:
        return fen, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eng", required=True, help="教师引擎二进制路径")
    ap.add_argument("--data", required=True, help="输入 FEN 文件（FEN 或 FEN\\tresult）")
    ap.add_argument("--out", required=True, help="输出 FEN\\teval_cp 文件")
    ap.add_argument("--depth", type=int, default=10, help="教师引擎搜索深度")
    ap.add_argument("--threads", type=int, default=1, help="每个教师引擎的搜索线程数")
    ap.add_argument("--workers", type=int, default=mp.cpu_count() or 4, help="并行引擎进程数")
    ap.add_argument("--sample", type=int, default=0, help="随机采样 N 个 FEN（0=全部）")
    ap.add_argument("--augment", action="store_true",
                    help="对称增广：额外输出黑白互换镜像（eval 取反），消白方偏置、数据翻倍")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    fens = load_fens(args.data, args.sample, args.seed)
    print(f"待打标签 {len(fens)} 个 FEN（depth {args.depth} / {args.workers} 进程"
          f"{' / 对称增广' if args.augment else ''}）", flush=True)

    t0 = time.time()
    n_ok = n_bad = n_rows = 0
    with mp.Pool(args.workers, initializer=_init_worker,
                 initargs=(args.eng, args.depth, args.threads)) as pool:
        with open(args.out, "w") as fout:
            for i, (fen, ev) in enumerate(pool.imap(_label_one, fens, chunksize=8)):
                if ev is None:
                    n_bad += 1
                    continue
                fout.write(f"{fen}\t{ev}\n")
                n_ok += 1
                n_rows += 1
                if args.augment:
                    mf = mirror_fen(fen)
                    if mf:
                        fout.write(f"{mf}\t{-ev}\n")
                        n_rows += 1
                if (i + 1) % 2000 == 0:
                    rate = (i + 1) / (time.time() - t0)
                    print(f"  {i + 1}/{len(fens)}  ok={n_ok} bad={n_bad} "
                          f"{rate:.0f} 局面/s  t={time.time() - t0:.0f}s", flush=True)

    print(f"完成：{n_ok} 个标签 / {n_bad} 个失败，输出 {n_rows} 行（含增广），"
          f"耗时 {time.time() - t0:.0f}s -> {args.out}")


if __name__ == "__main__":
    main()
