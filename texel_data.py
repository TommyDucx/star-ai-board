#!/usr/bin/env python3
"""Texel 数据准备：从自对弈 PGN 提取「安静局面 + 对局结果」。

标准 Texel 采样规则：
  - 跳过开局前 min_ply 步（避免开局理论重复，局面多样性差）；
  - 跳过「被将军」的局面（下一步必须应将，静态 eval 不可靠）；
  - 跳过「刚发生吃子」的局面（下一步有强制回吃，不稳定）；
  - 每局最多采样 max_per_game 个，避免单局主导。

输出：每行 `FEN\tresult`，result 为白方视角 1 / 0.5 / 0。

用法：
  python3 texel_data.py --pgn data/selfplay.pgn --out data/texel_data.txt --min-ply 8
"""
import argparse
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
                continue
            board = game.board()
            sampled = 0
            for i, move in enumerate(game.mainline_moves()):
                is_capture = board.is_capture(move)
                board.push(move)
                if i + 1 < min_ply:
                    continue
                if is_capture:
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pgn", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-ply", type=int, default=8)
    ap.add_argument("--max-per-game", type=int, default=20)
    args = ap.parse_args()

    rows, games = extract(args.pgn, args.min_ply, args.max_per_game)
    with open(args.out, "w", encoding="utf-8") as f:
        for fen, res in rows:
            f.write(f"{fen}\t{res}\n")
    print(f"从 {games} 局提取 {len(rows)} 个安静局面 -> {args.out}")


if __name__ == "__main__":
    main()
