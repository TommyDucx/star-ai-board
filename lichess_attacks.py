#!/usr/bin/env python3
"""
Lichess 进攻型数据下载与筛选
==============================
从两个来源获取进攻风格训练数据：

  A. Lichess Puzzle 数据库（推荐，体积小）
     · 内置 sacrifice / mate / fork / 等战术标签
     · 直接筛选"弃子""杀棋""进攻"类题目
     · URL: https://database.lichess.org/#/puzzles

  B. Lichess 标准 PGN 月度库（完整对局，体积大）
     · 需要自行下载月度 PGN（数 GB）
     · 本脚本做本地解析+筛选
     · 筛选条件：大量弃子、王城攻击、短局速胜

输出:
  ├── lichess_attacks.pgn    进攻对局 PGN
  ├── lichess_attacks.jsonl  训练数据 JSONL
  └── lichess_stats.json     筛选统计

用法:
  # 方案A：Puzzle 数据（推荐先试这个）
  python lichess_attacks.py --puzzles --min-rating 1500 --output ../data/

  # 方案B：已有 PGN 文件时本地筛选
  python lichess_attacks.py --parse-pgn /path/to/games.pgn --output ../data/
"""

import argparse
import csv
import io
import json
import os
import sys
import tempfile
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import chess
import chess.pgn

# ── Puzzle 攻击主题标签 ────────────────────────────────
# 实际 Lichess Puzzle 主题名（空格分隔）
ATTACK_THEMES = {
    # 高进攻性
    "crushing": 12,          # 压倒性优势/攻杀
    "mate": 10,              # 杀棋
    "sacrifice": 10,         # 弃子
    "doubleCheck": 9,        # 双将
    "discoveredAttack": 8,   # 暗攻击
    "fork": 7,               # 双击
    "pin": 5,                # 牵制
    "skewer": 5,             # 串击
    "backRankMate": 8,       # 底线杀
    "attraction": 8,         # 引离（吸引战术）
    # 中等进攻性
    "hangingPiece": 4,       # 悬挂子
    "overload": 5,           # 过载
    "trappedPiece": 4,       # 困子
    "removalOfGuard": 6,     # 移除保护
    "interference": 5,       # 干扰
    # 低权重（保留部分但不过滤）
    "advantage": 2,          # 优势
    "middlegame": 1,         # 中局
    "short": 1,              # 短题
}

# ── 下载 Puzzle CSV ────────────────────────────────────
PUZZLE_URL = "https://database.lichess.org/lichess_db_puzzle.csv.zst"


def download_puzzles(output_dir: Path, min_rating: int = 1500,
                     max_puzzles: int = 5000) -> dict:
    """
    下载并筛选 Lichess Puzzle 数据库。
    只保留进攻主题 + 高评分题目。
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n{'='*60}", file=sys.stderr)
    print(f"  下载 Lichess Puzzle 数据库", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)

    # 尝试安装 zstd 解压支持
    try:
        import zstandard as zstd
    except ImportError:
        print("  安装 zstandard...", file=sys.stderr)
        import subprocess
        subprocess.check_call([
            sys.executable, "-m", "pip", "install", "zstandard", "-q"
        ])
        import zstandard as zstd

    tmp_zip = output_dir / "lichess_puzzles.csv.zst"
    tmp_csv = output_dir / "lichess_puzzles.csv"

    if not tmp_zip.exists():
        print(f"  正在下载 {PUZZLE_URL} ...", file=sys.stderr)
        try:
            urllib.request.urlretrieve(PUZZLE_URL, tmp_zip)
            print(f"  下载完成: {tmp_zip.stat().st_size / 1024 / 1024:.1f} MB",
                  file=sys.stderr)
        except Exception as e:
            print(f"  [ERROR] 下载失败: {e}", file=sys.stderr)
            return {"status": "download_failed", "error": str(e)}

    # 解压
    if not tmp_csv.exists() or tmp_csv.stat().st_size == 0:
        print(f"  解压中...", file=sys.stderr)
        with open(tmp_zip, "rb") as f_in:
            dctx = zstd.ZstdDecompressor()
            with open(tmp_csv, "wb") as f_out:
                dctx.copy_stream(f_in, f_out)
        print(f"  解压完成: {tmp_csv.stat().st_size / 1024 / 1024:.1f} MB",
              file=sys.stderr)

    # 解析并筛选
    print(f"  筛选进攻主题 (rating>={min_rating})...", file=sys.stderr)

    attack_positions: list[dict] = []
    total_read = 0
    theme_counts: dict[str, int] = defaultdict(int)

    with open(tmp_csv, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            total_read += 1

            # 评分过滤
            try:
                rating = int(row.get("Rating", "0"))
            except (ValueError, TypeError):
                continue
            if rating < min_rating:
                continue

            # 主题匹配
            themes_str = row.get("Themes", "")
            if not themes_str:
                continue
            themes = [t.strip() for t in themes_str.split()]  # 空格分隔

            attack_score = 0
            matched_themes = []
            for theme in themes:
                if theme in ATTACK_THEMES:
                    attack_score += ATTACK_THEMES[theme]
                    matched_themes.append(theme)
                    theme_counts[theme] += 1

            if attack_score < 5:  # 降低阈值以获取更多进攻数据
                continue

            if len(attack_positions) >= max_puzzles:
                break

            # 构造 FEN 和走法
            fen = row.get("FEN", "")
            moves_uci = row.get("Moves", "")
            solution_uci = row.get("Solution", "") or moves_uci

            attack_positions.append({
                "source": "lichess_puzzle",
                "puzzle_id": row.get(" PuzzleId", ""),
                "fen": fen,
                "solution_uci": solution_uci,
                "rating": rating,
                "themes": matched_themes,
                "attack_score": attack_score,
                "game_url": row.get("GameUrl", ""),
                "ply": len(moves_uci.split()) if moves_uci else 0,
            })

    # 写入 JSONL
    out_jsonl = output_dir / "lichess_attacks.jsonl"
    with open(out_jsonl, "w", encoding="utf-8") as f:
        for pos in attack_positions:
            f.write(json.dumps(pos, ensure_ascii=False) + "\n")

    # 写统计
    stats = {
        "type": "lichess_puzzles",
        "total_puzzles_db": total_read,
        "filtered_count": len(attack_positions),
        "min_rating": min_rating,
        "theme_distribution": dict(theme_counts),
        "jsonl_file": str(out_jsonl),
        "jsonl_size_mb": round(out_jsonl.stat().st_size / 1024 / 1024, 2) if out_jsonl.exists() else 0,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    stats_path = output_dir / "lichess_stats.json"
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2, ensure_ascii=False)

    print(f"\n  Puzzle 筛选完毕:", file=sys.stderr)
    print(f"    数据库总量:   {total_read:,}", file=sys.stderr)
    print(f"    筛选保留:     {len(attack_positions):,}", file=sys.stderr)
    print(f"    主题分布:", file=sys.stderr)
    for theme, count in sorted(theme_counts.items(), key=lambda x: -x[1])[:10]:
        print(f"      {theme}: {count}", file=sys.stderr)
    print(f"    输出文件:     {out_jsonl.name} ({stats['jsonl_size_mb']} MB)",
          file=sys.stderr)
    print(f"{'='*60}\n", file=sys.stderr)

    # 清理临时文件（保留原始下载以便复用）
    # tmp_csv.unlink()  # 可选：解压后删除 CSV 节省空间

    return stats


# ── PGN 本地筛选 ───────────────────────────────────────
def filter_pgn_file(pgn_path: Path, output_dir: Path,
                   num_games: int = 500, min_rating: int = 2000) -> dict:
    """
    从已有的 PGN 文件中筛选进攻型对局。
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    out_pgn = output_dir / "lichess_attacks.pgn"
    out_jsonl = output_dir / "lichess_attacks.jsonl"

    print(f"\n{'='*60}", file=sys.stderr)
    print(f"  筛选 PGN: {pgn_path.name}", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)

    filtered_pgns: list[str] = []
    attack_positions: list[dict] = []
    downloaded = 0
    filtered = 0

    with open(pgn_path, "r", encoding="utf-8", errors="ignore") as f:
        while downloaded < num_games * 3 and filtered < num_games:
            try:
                game = chess.pgn.read_game(f)
            except Exception:
                continue
            if game is None:
                break
            downloaded += 1

            # Elo 过滤
            w_elo = int(game.headers.get("WhiteElo", "0") or "0")
            b_elo = int(game.headers.get("BlackElo", "0") or "0")
            if w_elo < min_rating or b_elo < min_rating:
                continue

            # 分析对局特征
            board = game.board()
            moves_list = list(game.mainline_moves())
            captures = 0
            checks = 0
            sac_value = 0
            king_attacks = 0

            piece_val = {
                chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3,
                chess.ROOK: 5, chess.QUEEN: 9,
            }

            for move in moves_list[:50]:  # 只分析前 50 步
                if board.is_capture(move):
                    captures += 1
                    cap_pt = board.piece_at(move.to_square)
                    atk_pt = board.piece_at(move.from_square)
                if cap_pt and atk_pt:
                    atk_v = piece_val.get(atk_pt.piece_type, 0)
                    cap_v = piece_val.get(cap_pt.piece_type, 0)
                    if atk_v < cap_v:
                        sac_value += (cap_v - atk_v)

                if board.gives_check(move):
                    checks += 1

                opp_king = board.king(not board.turn)
                if opp_king and move.to_square is not None:
                    dist = abs(move.to_square.file - opp_king.file) + \
                           abs(move.to_square.rank - opp_king.rank)
                    if dist <= 2:
                        king_attacks += 1

                board.push(move)

            # 进攻打分
            attack_score = (
                sac_value * 10 +
                king_attacks * 5 +
                checks * 3 +
                captures * 1 -
                len(moves_list) * 0.02
            )

            if attack_score >= 15 and filtered < num_games:
                filtered += 1
                filtered_pgns.append(str(game))

                # 提取前 40 回合位置
                b2 = game.board()
                for mi, mv in enumerate(moves_list[:40]):
                    attack_positions.append({
                        "source": "lichess_attack_pgn",
                        "game_id": filtered,
                        "ply": mi,
                        "fen": b2.fen(),
                        "bestmove_uci": mv.uci(),
                        "bestmove_san": b2.san(mv),
                        "attack_score": round(attack_score, 1),
                        "white_elo": w_elo,
                        "black_elo": b_elo,
                        "sac_value": sac_value,
                        "king_attacks": king_attacks,
                        "checks": checks,
                        "captures": captures,
                    })
                    b2.push(mv)

                if filtered % 100 == 0:
                    print(f"    已筛选 {filtered}/{num_games}...",
                          file=sys.stderr)

    # 写入
    with open(out_pgn, "w", encoding="utf-8") as f:
        for pgn in filtered_pgns:
            f.write(pgn + "\n\n")

    with open(out_jsonl, "w", encoding="utf-8") as f:
        for pos in attack_positions:
            f.write(json.dumps(pos, ensure_ascii=False) + "\n")

    result = {
        "type": "lichess_pgn_filtered",
        "downloaded": downloaded,
        "filtered": filtered,
        "total_positions": len(attack_positions),
        "pgn_file": str(out_pgn),
        "jsonl_file": str(out_jsonl),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    print(f"\n  PGN 筛选:", file=sys.stderr)
    print(f"    扫描对局: {downloaded:,}", file=sys.stderr)
    print(f"    筛选保留: {filtered}", file=sys.stderr)
    print(f"    训练位置: {len(attack_positions):,}", file=sys.stderr)
    print(f"{'='*60}\n", file=sys.stderr)

    return result


# ── CLI ────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Lichess 进攻数据下载与筛选")
    parser.add_argument("--puzzles", action="store_true",
                       help="方案A: 下载 Puzzle 数据库（推荐）")
    parser.add_argument("--parse-pgn", type=str,
                       help="方案B: 筛选本地 PGN 文件")
    parser.add_argument("--min-rating", type=int, default=1500,
                       help="最低评分 (Puzzle) 或 Elo (PGN)")
    parser.add_argument("--max-puzzles", type=int, default=5000,
                       help="最大 Puzzle 数量")
    parser.add_argument("--pgn-games", type=int, default=500,
                       help="PGN 筛选目标数量")
    parser.add_argument("--output", "-O", type=str,
                       default=str(Path(__file__).resolve().parent.parent / "data"),
                       help="输出目录")
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.puzzles:
        download_puzzles(output_dir, min_rating=args.min_rating,
                         max_puzzles=args.max_puzzles)
    elif args.parse_pgn:
        filter_pgn_file(Path(args.parse_pgn), output_dir,
                       num_games=args.pgn_games, min_rating=args.min_rating)
    else:
        print("请选择: --puzzles (下载数据库) 或 --parse-pgn 文件路径",
              file=sys.stderr)
        parser.print_help(sys.stderr)


if __name__ == "__main__":
    main()
