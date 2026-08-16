#!/usr/bin/env python3
"""Texel 数据准备：从 PGN 提取「安静局面 + 对局结果」。

标准 Texel 采样规则：
  - 跳过开局前 min_ply 步（避免开局理论重复，局面多样性差）；
  - 跳过「被将军」的局面（下一步必须应将，静态 eval 不可靠）；
  - 跳过「刚发生吃子」的局面（下一步有强制回吃，不稳定）；
  - 跳过「升变走法」的局面（升变后子力突变，静态 eval 不可靠）；
  - 和棋样本降采样到 draw_frac 比例（避免和棋主导，防止 eval 趋于保守）；
  - 每局最多采样 max_per_game 个，避免单局主导。

输出：每行 `FEN\tresult`，result 为白方视角 1 / 0.5 / 0。

用法：
  python3 texel_data.py --pgn data/games.pgn --out data/texel_data.txt \
      --min-ply 8 --draw-frac 0.3 --max-per-game 20
"""
import argparse
import random

import chess
import chess.pgn


def extract(pgn_path, min_ply, max_per_game):
    out = []
    games = 0
    with open(pgn_path) as f:
        while True:
            game = chess.pgn.read_game(f)
            if game is None:
                break
            games += 1
            result = game.headers.get("Result", "*")
            if result == "1-0":
                wres = 1.0
            elif result == "0-1":
                wres = 0.0
            elif result == "1/2-1/2":
                wres = 0.5
            else:
                continue  # 未知/未完成结果，跳过
            board = game.board()
            sampled = 0
            for i, move in enumerate(game.mainline_moves()):
                is_capture = board.is_capture(move)
                is_promo = move.promotion is not None
                board.push(move)
                if i + 1 < min_ply:
                    continue
                if is_capture or is_promo:
                    continue
                if board.is_check():
                    continue
                if board.is_game_over():
                    break
                out.append((board.fen(), wres))
                sampled += 1
                if sampled >= max_per_game:
                    break
    return out, games


def downsample_draws(rows, draw_frac):
    """把和棋(0.5)样本降采样到不超过 draw_frac 比例。

    目标：draws / (draws + decisive) <= draw_frac。
    引擎对局和棋率极高（CCRL 顶级引擎 60~80%），不降采样会让
    eval 把所有局面拉向 0 分，丧失分辨力。
    """
    wins = [(f, r) for f, r in rows if r == 1.0]
    losses = [(f, r) for f, r in rows if r == 0.0]
    draws = [(f, r) for f, r in rows if r == 0.5]
    decisive = len(wins) + len(losses)
    if not draws or decisive == 0:
        return rows
    max_draws = int(decisive * draw_frac / (1.0 - draw_frac)) if draw_frac < 1.0 else len(draws)
    if len(draws) > max_draws:
        random.shuffle(draws)
        draws = draws[:max_draws]
    merged = wins + losses + draws
    random.shuffle(merged)
    return merged


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pgn", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-ply", type=int, default=8)
    ap.add_argument("--max-per-game", type=int, default=20)
    ap.add_argument("--draw-frac", type=float, default=0.3,
                    help="和棋样本占比上限（0.3 = 和棋最多占 30%）")
    ap.add_argument("--seed", type=int, default=42, help="降采样随机种子")
    args = ap.parse_args()

    random.seed(args.seed)
    rows, games = extract(args.pgn, args.min_ply, args.max_per_game)
    n_before = len(rows)
    rows = downsample_draws(rows, args.draw_frac)

    with open(args.out, "w", encoding="utf-8") as f:
        for fen, res in rows:
            f.write(f"{fen}\t{res}\n")

    n_w = sum(1 for _, r in rows if r == 1.0)
    n_d = sum(1 for _, r in rows if r == 0.5)
    n_l = sum(1 for _, r in rows if r == 0.0)
    print(f"从 {games} 局提取 {n_before} 个安静局面，降采样后 {len(rows)} 个")
    print(f"  胜 {n_w} / 和 {n_d} / 负 {n_l} "
          f"(和棋占比 {n_d / max(1, len(rows)) * 100:.1f}%)")
    print(f"-> {args.out}")


if __name__ == "__main__":
    main()
