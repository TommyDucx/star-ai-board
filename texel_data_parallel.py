#!/usr/bin/env python3
"""多进程并行 Texel 数据提取：split 分片 + 流式写 + 两遍降采样。

相比 texel_data.py 的单进程内存累积版，本脚本：
  1. 用 split 按行分片，多进程并行清洗（8 核并行，快 5~8 倍）；
  2. 每个 worker 流式写文件（不累积内存，避免 GB 级 swap）；
  3. 降采样用两遍法（统计 + 抽样），内存 O(1)。

用法：
  python3 texel_data_parallel.py --pgn games.pgn --out texel.txt \
      --min-ply 10 --draw-frac 0.3 --max-per-game 30 --workers 8
"""
import argparse
import multiprocessing as mp
import os
import random
import subprocess

import chess
import chess.pgn

RESULT_MAP = {"1-0": 1.0, "0-1": 0.0, "1/2-1/2": 0.5}


def extract_part(part_path, out_path, min_ply, max_per_game):
    """清洗一个分片，流式写 FEN\\tresult。返回 (对局数, 样本数)。"""
    n_games = 0
    n_rows = 0
    with open(part_path) as f, open(out_path, "w") as fout:
        while True:
            try:
                game = chess.pgn.read_game(f)
            except Exception:
                game = None
            if game is None:
                break
            n_games += 1
            wres = RESULT_MAP.get(game.headers.get("Result", "*"))
            if wres is None:
                continue
            board = game.board()
            sampled = 0
            try:
                moves = list(game.mainline_moves())
            except Exception:
                continue  # 截断对局，跳过
            for k, move in enumerate(moves):
                cap = board.is_capture(move)
                promo = move.promotion is not None
                board.push(move)
                if k + 1 < min_ply or cap or promo:
                    continue
                if board.is_check():
                    continue
                if board.is_game_over():
                    break
                fout.write(f"{board.fen()}\t{wres}\n")
                n_rows += 1
                sampled += 1
                if sampled >= max_per_game:
                    break
    return n_games, n_rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pgn", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-ply", type=int, default=10)
    ap.add_argument("--max-per-game", type=int, default=30)
    ap.add_argument("--draw-frac", type=float, default=0.3)
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 4)
    ap.add_argument("--tmpdir", default="/tmp/texel_par")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    os.makedirs(args.tmpdir, exist_ok=True)

    # 1. 按行分片
    total_lines = sum(1 for _ in open(args.pgn))
    lines_per_part = total_lines // args.workers + 1
    subprocess.run(["split", "-l", str(lines_per_part), args.pgn,
                    os.path.join(args.tmpdir, "part_")], check=True)
    parts = sorted(p for p in os.listdir(args.tmpdir) if p.startswith("part_"))
    parts = [os.path.join(args.tmpdir, p) for p in parts]
    print(f"分片 {len(parts)} 个，每片 ~{lines_per_part} 行", flush=True)

    # 2. 并行清洗
    tasks = [(p, os.path.join(args.tmpdir, f"out_{i}.txt"),
              args.min_ply, args.max_per_game) for i, p in enumerate(parts)]
    with mp.Pool(args.workers) as pool:
        results = pool.starmap(extract_part, tasks)
    n_games = sum(r[0] for r in results)
    n_rows = sum(r[1] for r in results)
    print(f"清洗完成：{n_games} 局 → {n_rows} 个安静局面", flush=True)

    # 3. 合并
    all_rows = os.path.join(args.tmpdir, "all.txt")
    with open(all_rows, "w") as fout:
        for i in range(len(parts)):
            with open(os.path.join(args.tmpdir, f"out_{i}.txt")) as fin:
                fout.write(fin.read())

    # 4. 两遍降采样
    n_w = n_d = n_l = 0
    with open(all_rows) as f:
        for line in f:
            r = line.rstrip("\n").split("\t")[-1]
            if r == "1.0":
                n_w += 1
            elif r == "0.5":
                n_d += 1
            else:
                n_l += 1
    decisive = n_w + n_l
    max_draws = (int(decisive * args.draw_frac / (1.0 - args.draw_frac))
                 if args.draw_frac < 1.0 else n_d)
    keep_draws = min(n_d, max_draws)
    draw_ratio = keep_draws / n_d if n_d > 0 else 1.0
    random.seed(args.seed)
    out_n = 0
    with open(all_rows) as f, open(args.out, "w") as fout:
        for line in f:
            line = line.rstrip("\n")
            if line.split("\t")[-1] == "0.5" and random.random() > draw_ratio:
                continue
            fout.write(line + "\n")
            out_n += 1

    print(f"降采样后 {out_n} 个局面：胜 {n_w} / 和 {keep_draws} / 负 {n_l}")
    print(f"-> {args.out}")


if __name__ == "__main__":
    main()
