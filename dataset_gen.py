#!/usr/bin/env python3
"""
S.T.A.R. 数据集生成器 —— Policy CNN 训练数据
================================================
按方案配比生成两类数据：

  80%  Rust 引擎 (my-engine) 自我对弈 PGN（主体）
       · 起步最低 2000 局，后期加到 8000~15000
       · 每局只提取前 40 回合局面，舍弃拖沓残局

  20%  筛选后的 Lichess 进攻对局（风格强化包）
       · 只挑选大量弃子、王城进攻的对局
       · 拉高进攻倾向

输出:
  ├── selfplay.pgn          自对弈 PGN（可直接用 chess.py 解析）
  ├── selfplay.jsonl        训练数据 JSONL（每行 = 一个局面样本）
  ├── lichess_attacks.pgn   Lichess 筛选对局 PGN
  └── dataset_summary.json  总体统计摘要

用法:
  # 快速测试（5 局验证格式）
  python dataset_gen.py --selfplay 5 --depth 4 --movetime 200

  # 正式生产：2000 局自对弈 + Lichess 进攻包
  python dataset_gen.py --selfplay 2000 --depth 6 --movetime 500 --lichess

  # 仅下载+筛选 Lichess 数据
  python dataset_gen.py --lichess-only --lichess-games 500
"""

import argparse
import gzip
import io
import json
import os
import random
import re
import subprocess
import sys
import threading
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import chess
import chess.pgn
import chess.svg

# ── 路径常量 ──────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
ENGINE_BIN = SCRIPT_DIR / "my-engine" / "target" / "release" / "my-engine"
DATA_DIR = SCRIPT_DIR.parent / "data"

# ── 开局库（UCI 格式）── 随机化开局增加多样性 ────────
OPENING_BOOK = [
    ["e2e4", "e7e5"],                                    # 开局式
    ["e2e4", "c7c5"],                                    # 西西里防御
    ["e2e4", "e7e6"],                                    # 法兰西防御
    ["e2e4", "c7c6"],                                    # 卡罗-康
    ["d2d4", "d7d5", "c2c4"],                           # 后翼弃兵
    ["d2d4", "f7f5"],                                    # 荷兰防御
    ["d2d4", "g8f6", "c2c4"],                           # 尼姆佐/新印度
    ["e2e4", "g8f6"],                                    # 阿廖欣防御
    ["c2c4", "e7e5", "g1f3"],                            # 英式开局
    ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"],           # 西班牙开局
    ["d2d4", "d7d5", "c2c4", "e7e6"],                    # 后翼弃兵拒吃
    ["e2e4", "c7c5", "b1c3", "g8f6"],                   # 西西里封闭
    ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"],           # 意大利开局
    ["d2d4", "n8f6", "c2c4", "g7g6"],                    # 王翼印度
    ["e2e4", "e7e5", "g1f3", "b8c6", "b5c4"],           #苏格兰开局
    ["e2e4", "c7c6", "d2d4", "d7d5"],                    # 卡罗-康主变
    ["e2e4", "e7e5", "g1f3", "b8c6", "b5a6"],           # 西班牙开放
    ["d2d4", "d7d5", "c2c4", "c7c6", "b1c3"],            # 斯拉夫接受
]

# ── UCI 客户端（修复：从 stderr 读 info）────────────────
class UCIClient:
    """
    UCI 引擎客户端。
    my-engine 用 eprintln! 输出 info → stderr
    用 println! 输出 bestmove/uciok → stdout

    策略: 每次go()后，先阻塞读stdout拿到bestmove，
          再非阻塞排空stderr收集所有info行。
    """

    def __init__(self, engine_path: str, verbose: bool = False):
        self.engine_path = engine_path
        self.verbose = verbose
        self.proc: subprocess.Popen | None = None

    def start(self) -> "UCIClient":
        if not os.path.isfile(self.engine_path):
            raise FileNotFoundError(f"引擎不存在: {self.engine_path}")
        self.proc = subprocess.Popen(
            [self.engine_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        return self

    def send(self, cmd: str):
        """发送命令到 stdin。"""
        if self.verbose:
            print(f"  > {cmd}", file=sys.stderr)
        assert self.proc is not None
        self.proc.stdin.write(cmd + "\n")
        self.proc.stdin.flush()

    def _readline_stdout(self, timeout_s: float = 120.0) -> str | None:
        """从 stdout 阻塞读取一行（带超时）。"""
        assert self.proc is not None
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if line:
                return line.rstrip("\r\n")
        return None

    def _drain_stderr(self) -> list[str]:
        """非阻塞排空 stderr 所有已缓冲行。"""
        assert self.proc is not None
        lines: list[str] = []
        while True:
            # 尝试非阻塞读
            import select as _select
            ready, _, _ = _select.select([self.proc.stderr], [], [], 0.05)
            if not ready:
                break
            line = self.proc.stderr.readline()
            if not line:
                break
            s = line.rstrip("\r\n")
            if s:
                lines.append(s)
        return lines

    def go(self, depth: int = 6, movetime_ms: int = 500) -> dict:
        """
        执行搜索。返回 {bestmove, score_cp, depth, nodes, time_ms, pv}
        """
        self.send(f"go depth {depth} movetime {movetime_ms}")

        # 1) 阻塞等待 stdout 的 bestmove
        bm_line = self._readline_stdout(timeout_s=300)
        bestmove_str = "(none)"
        ponder_str = ""
        if bm_line:
            m = re.match(r"^bestmove\s+(\S+)(?:\s+(\S+))?", bm_line)
            if m:
                bestmove_str = m.group(1)
                ponder_str = m.group(2) or ""

        # 2) 排空 stderr（info 行全在这里）
        err_lines = self._drain_stderr()

        # 3) 从最后一行 info 提取最终评估（最深迭代）
        score_cp = None
        info_depth = 0
        info_nodes = 0
        info_time = 0
        pv = ""
        for line in reversed(err_lines):
            if "score" in line:
                sc_m = re.search(r"score\s+cp\s+(-?\d+)", line)
                if sc_m:
                    score_cp = int(sc_m.group(1))
                d_m = re.search(r"depth\s+(\d+)", line)
                if d_m:
                    info_depth = int(d_m.group(1))
                n_m = re.search(r"nodes\s+(\d+)", line)
                if n_m:
                    info_nodes = int(n_m.group(1))
                t_m = re.search(r"time\s+(\d+)", line)
                if t_m:
                    info_time = int(t_m.group(1))
                pv_m = re.search(r"pv\s+(.+)$", line)
                if pv_m:
                    pv = pv_m.group(1).strip()
                break  # 只取最后（最深）一行

        if self.verbose and err_lines:
            print(f"  < info (last): {err_lines[-1] if err_lines else '(empty)'}", file=sys.stderr)

        return {
            "bestmove": bestmove_str,
            "ponder": ponder_str,
            "score_cp": score_cp,
            "depth": info_depth,
            "nodes": info_nodes,
            "time_ms": info_time,
            "pv": pv,
        }

    def uci_init(self):
        """UCI 握手。"""
        self.send("uci")
        while True:
            line = self._readline_stdout()
            if line == "uciok":
                break
        self._drain_stderr()  # 清掉可能的 stderr 噪音
        self.send("isready")
        while True:
            line = self._readline_stdout()
            if line == "readyok":
                break
        self._drain_stderr()

    def newgame(self):
        """新对局。"""
        self.send("ucinewgame")
        self.send("isready")
        while True:
            line = self._readline_stdout()
            if line == "readyok":
                break
        self._drain_stderr()

    def position(self, moves: list[chess.Move]):
        """设置当前局面。"""
        uci_moves = " ".join(m.uci() for m in moves)
        if uci_moves:
            self.send(f"position startpos moves {uci_moves}")
        else:
            self.send("position startpos")

    def quit(self):
        try:
            self.send("quit")
            assert self.proc is not None
            self.proc.wait(timeout=5)
        except Exception:
            if self.proc:
                self.proc.kill()
                self.proc.wait()


# ── 单局自对弈 ─────────────────────────────────────────
def play_one_game(
    client: UCIClient,
    game_id: int,
    depth: int,
    movetime_ms: int,
    max_plies: int = 40,
    opening_uci: list[str] | None = None,
) -> dict | None:
    """
    执行一局自对弈。

    返回 game_dict 或 None（如果游戏被判定为拖沓/无效而丢弃）。
    game_dict 包含:
      - pgn_text: str         PGN 格式对局记录
      - result: str           结果 ("1-0"/"0-1"/"1/2-1/2"/"*")
      - num_plies: int        实际回合数
      - num_captures: int     吃子数
      - eval_range: float     评估波动范围
      - is_drawish: bool      是否拖沓（被过滤的标志）
      - positions: list[dict] 每个训练位置
    """
    client.newgame()
    board = chess.Board()

    # 应用预置开局走法
    opening_moves: list[chess.Move] = []
    if opening_uci:
        for uci_str in opening_uci:
            try:
                mv = board.push_uci(uci_str)
                opening_moves.append(mv)
            except ValueError:
                break

    positions: list[dict] = []
    all_moves: list[chess.Move] = list(opening_moves)
    scores: list[int] = []
    capture_count = 0
    ply = 0

    while ply < max_plies:
        client.position(all_moves)
        result = client.go(depth=depth, movetime_ms=movetime_ms)

        bm_str = result["bestmove"]
        if bm_str in ("(none)", "0000"):
            break

        try:
            move = chess.Move.from_uci(bm_str)
        except ValueError:
            break

        if move not in board.legal_moves:
            # 引擎返回非法走法 → 终止本局
            break

        # 记录当前位置作为训练样本
        fen = board.fen()
        is_capture = board.is_capture(move)
        if is_capture:
            capture_count += 1

        pos_record = {
            "game_id": game_id,
            "ply": ply,
            "fen": fen,
            "bestmove_uci": bm_str,
            "bestmove_san": board.san(move),
            "score_cp": result["score_cp"],
            "depth": result["depth"],
            "nodes": result["nodes"],
            "time_ms": result["time_ms"],
            "pv": result["pv"],
            "side_to_move": "w" if board.turn == chess.WHITE else "b",
            "is_capture": is_capture,
            "is_check": board.gives_check(move),
        }
        positions.append(pos_record)

        if result["score_cp"] is not None:
            scores.append(result["score_cp"])

        # 执行走法
        board.push(move)
        all_moves.append(move)
        ply += 1

        # 终局检测
        if board.is_checkmate() or board.is_stalemate() or \
           board.is_insufficient_material() or \
           board.can_claim_draw():
            break

    if not positions:
        return None

    # 判定结果
    if board.is_checkmate():
        result_str = "0-1" if board.turn == chess.WHITE else "1-0"
    elif board.is_stalemate() or board.can_claim_draw():
        result_str = "1/2-1/2"
    else:
        # 未终局：按最终评估粗判
        if scores and abs(scores[-1]) > 200:
            result_str = "1-0" if scores[-1] > 0 else "0-1"
        else:
            result_str = "*"

    # 判断是否为拖沓局（过滤条件）
    eval_range = (max(scores) - min(scores)) if len(scores) >= 2 else 0
    capture_rate = capture_count / max(len(positions), 1)
    is_drawish = (
        (ply >= max_plies and capture_count <= 2)  # 打满但几乎没吃子
        or (len(scores) >= 10 and eval_range < 50)  # 评估几乎不动
        or (result_str == "1/2-1/2" and ply < 20)   # 早和棋
    )

    # 构造 PGN
    pgn_headers = {
        "Event": "STAR Self-Play",
        "Site": "Local",
        "Date": datetime.now(timezone.utc).strftime("%Y.%m.%d"),
        "Round": str(game_id + 1),
        "White": "MyEngine",
        "Black": "MyEngine",
        "Result": result_str,
    }
    game_pgn = chess.pgn.Game.from_board(board)
    # 重建 board 来正确生成 PGN（需要完整走法序列）
    replay = chess.Board()
    pgn_game = chess.pgn.Game()
    pgn_game.headers.update(pgn_headers)
    node = pgn_game
    for mv in all_moves:
        node = node.add_variation(mv)
    pgn_game.result = result_str

    return {
        "pgn_text": str(pgn_game),
        "result": result_str,
        "num_plies": ply,
        "num_captures": capture_count,
        "eval_range": eval_range,
        "is_drawish": is_drawish,
        "positions": positions,
    }


# ── 批量自对弈 ─────────────────────────────────────────
def run_selfplay(
    engine_path: str,
    num_games: int = 2000,
    depth: int = 6,
    movetime_ms: int = 500,
    max_plies: int = 40,
    output_dir: Path = DATA_DIR,
    verbose: bool = False,
) -> dict:
    """运行批量自对弈，写入 PGN + JSONL，返回统计摘要。"""
    output_dir.mkdir(parents=True, exist_ok=True)
    pgn_path = output_dir / "selfplay.pgn"
    jsonl_path = output_dir / "selfplay.jsonl"

    client = UCIClient(engine_path, verbose=verbose)
    client.start()
    client.uci_init()

    total_positions = 0
    kept_games = 0
    discarded_drawish = 0
    discarded_short = 0
    all_scores: list[int] = []

    with open(pgn_path, "w", encoding="utf-8") as pf, \
         open(jsonl_path, "w", encoding="utf-8") as jf:

        for gi in range(num_games):
            # 随机开局（80% 概率使用开局库）
            opening = None
            if random.random() < 0.8:
                opening = random.choice(OPENING_BOOK)

            try:
                game = play_one_game(
                    client,
                    game_id=gi,
                    depth=depth,
                    movetime_ms=movetime_ms,
                    max_plies=max_plies,
                    opening_uci=opening,
                )
            except Exception as e:
                print(f"  [WARN] Game {gi} 异常: {e}", file=sys.stderr)
                # 尝试重启引擎
                try:
                    client.quit()
                except Exception:
                    pass
                client.start()
                client.uci_init()
                continue

            if game is None:
                discarded_short += 1
                continue

            # 过滤拖沓局
            if game["is_drawish"]:
                discarded_drawish += 1
                continue

            # 写入 PGN
            pf.write(game["pgn_text"] + "\n\n")

            # 写入每条训练样本到 JSONL
            for pos in game["positions"]:
                jf.write(json.dumps(pos, ensure_ascii=False) + "\n")
                if pos["score_cp"] is not None:
                    all_scores.append(pos["score_cp"])

            total_positions += len(game["positions"])
            kept_games += 1

            # 进度报告
            avg_eval = sum(all_scores[-len(game["positions"]):]) / max(len(game["positions"]), 1)
            print(
                f"  Game {gi+1:5d}/{num_games} | "
                f"kept={kept_games:5d} | "
                f"plies={game['num_plies']:2d} | "
                f"caps={game['num_captures']:2d} | "
                f"eval_r={game['eval_range']:+5.0f}cp | "
                f"result={game['result']:>7s} | "
                f"total_pos={total_positions:>7d}",
                file=sys.stderr,
            )

    client.quit()

    summary = {
        "type": "selfplay",
        "engine": engine_path,
        "engine_name": "MyEngine 0.2.0",
        "requested_games": num_games,
        "kept_games": kept_games,
        "discarded_drawish": discarded_drawish,
        "discarded_short": discarded_short,
        "total_positions": total_positions,
        "depth": depth,
        "movetime_ms": movetime_ms,
        "max_plies": max_plies,
        "pgn_file": str(pgn_path),
        "jsonl_file": str(jsonl_path),
        "pgn_size_mb": round(pgn_path.stat().st_size / 1024 / 1024, 2) if pgn_path.exists() else 0,
        "jsonl_size_mb": round(jsonl_path.stat().st_size / 1024 / 1024, 2) if jsonl_path.exists() else 0,
        "avg_score_cp": round(sum(all_scores) / max(len(all_scores), 1), 1) if all_scores else None,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    print(f"\n{'='*64}", file=sys.stderr)
    print(f"  自对弈数据集生成完毕", file=sys.stderr)
    print(f"  ──" * 16, file=sys.stderr)
    print(f"  请求对局:     {num_games}", file=sys.stderr)
    print(f"  保留对局:     {kept_games}  (丢弃拖沓: {discarded_drawish}, 无效: {discarded_short})", file=sys.stderr)
    print(f"  总训练位置:   {total_positions:,}", file=sys.stderr)
    print(f"  PGN 文件:     {summary['pgn_size_mb']} MB  →  {pgn_path.name}", file=sys.stderr)
    print(f"  JSONL 文件:   {summary['jsonl_size_mb']} MB  →  {jsonl_path.name}", file=sys.stderr)
    print(f"  平均评估:     {summary['avg_score_cp']} cp", file=sys.stderr)
    print(f"{'='*64}\n", file=sys.stderr)

    return summary


# ── Lichess 进攻对局筛选 ───────────────────────────────
def download_and_filter_lichess(
    num_games: int = 500,
    output_dir: Path = DATA_DIR,
    min_rating: int = 2000,
    verbose: bool = False,
) -> dict:
    """
    从 Lichess 数据库下载对局并筛选进攻型对局。

    策略：
      1. 使用 Lichess 开放数据库 API (https://database.lichess.org/)
      2. 按 rating 过滤（默认 2000+ 保证质量）
      3. 筛选条件：
         - 大量弃子（牺牲后/车价值换取战术机会）
         - 王城进攻（王在 e/g 线暴露时被攻击）
         - 高评估波动（激烈对攻）
         - 短对局（进攻型通常速胜）

    输出: lichess_attacks.pgn + lichess_attacks.jsonl
    """
    import gzip
    import urllib.request
    import tempfile

    output_dir.mkdir(parents=True, exist_ok=True)
    out_pgn = output_dir / "lichess_attacks.pgn"
    out_jsonl = output_dir / "lichess_attacks.jsonl"

    # Lichess 月度数据库 URL（选择最近月份的高水平对局）
    # 格式: https://database.lichess.org/months/{YYYY-MM}_lichess_db.pgn.zst
    # 我们用更简单的方式：直接从 lichess API 导出或用已知的公开数据源

    print("\n" + "="*64, file=sys.stderr)
    print("  Lichess 进攻对局筛选", file=sys.stderr)
    print("="*64, file=sys.stderr)

    # 方案：用 python-chess 直接解析 PGN 并评分
    # 这里先尝试从 Lichess DB 下载；如果网络不可用则提示用户手动提供
    lichess_url = "https://database.lichess.org/standard/lichess_db_pgn.zip"

    downloaded = 0
    filtered = 0
    attack_positions: list[dict] = []
    attack_pgns: list[str] = []

    # 尝试下载
    tmp_dir = Path(tempfile.mkdtemp(prefix="lichess_"))
    zip_path = tmp_dir / "lichess.zip"

    print(f"  正在从 Lichess 下载数据库...", file=sys.stderr)
    try:
        urllib.request.urlretrieve(lichess_url, zip_path)
        print(f"  下载完成: {zip_path.stat().st_size / 1024 / 1024:.0f} MB", file=sys.stderr)
    except Exception as e:
        print(f"  [WARN] 无法自动下载 Lichess 数据库: {e}", file=sys.stderr)
        print(f"  请手动下载后放到 {output_dir}/lichess_raw.pgn 后重新运行 --parse-lichess", file=sys.stderr)
        # 清理
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return {
            "type": "lichess",
            "status": "download_failed",
            "error": str(e),
            "downloaded": 0,
            "filtered": 0,
        }

    # 解压并逐局解析筛选
    import zipfile
    print(f"  解压并筛选中...", file=sys.stderr)

    with zipfile.ZipFile(zip_path, "r") as zf:
        pgn_files = [n for n in zf.namelist() if n.endswith(".pgn")]
        if not pgn_files:
            # 可能是 .zst 格式或其他
            pgn_files = [n for n in zf.namelist()]

        for pgn_file in pgn_files[:1]:  # 通常只有一个大文件
            with zf.open(pgn_file) as pf:
                pgn_text = pf.read().decode("utf-8", errors="ignore")

            pgn_io = io.StringIO(pgn_text)
            while downloaded < num_games * 3:  # 多下载一些以便筛选
                try:
                    game = chess.pgn.read_game(pgn_io)
                except Exception:
                    continue
                if game is None:
                    break
                downloaded += 1

                # 快速筛选：只保留高等级对局
                white_elo = int(game.headers.get("WhiteElo", "0") or "0")
                black_elo = int(game.headers.get("BlackElo", "0") or "0")
                if white_elo < min_rating or black_elo < min_rating:
                    continue

                # 解析对局特征
                board = game.board()
                moves_list = list(game.mainline_moves())
                captures = 0
                checks = 0
                sac_value = 0  # 弃子总价值
                eval_changes = 0
                prev_eval = 0
                king_exposed_attacks = 0

                for i, move in enumerate(moves_list):
                    if board.is_capture(move):
                        captures += 1
                        # 检测是否为弃子（牺牲高价值子力）
                        captured_piece = board.piece_at(move.to_square)
                        attacker_piece = board.piece_at(move.from_square)
                        if captured_piece and attacker_piece:
                            piece_values = {chess.PAWN: 1, chess.KNIGHT: 3,
                                           chess.BISHOP: 3, chess.ROOK: 5,
                                           chess.QUEEN: 9}
                            cap_val = piece_values.get(captured_piece.piece_type, 0)
                            atk_val = piece_values.get(attacker_piece.piece_type, 0)
                            if atk_val > 0 and atk_val < cap_val:
                                sac_value += (cap_val - atk_val)

                    if board.gives_check(move):
                        checks += 1

                    # 检测王城进攻（对方王在中路或已被易位到王翼后被攻击）
                    if move.to_square is not None:
                        opp_king_sq = board.king(not board.turn)
                        if opp_king_sq:
                            # 攻击发生在王附近
                            dist = abs(move.to_square.file - opp_king_sq.file) + \
                                   abs(move.to_square.rank - opp_king_sq.rank)
                            if dist <= 2:
                                king_exposed_attacks += 1

                    board.push(move)

                # 进攻型打分
                attack_score = (
                    sac_value * 10 +
                    king_exposed_attacks * 5 +
                    checks * 3 +
                    captures * 1 -
                    len(moves_list) * 0.05  # 偏好短对局
                )

                # 只保留高分进攻对局（前 20%）
                if attack_score >= 15 and filtered < num_games:
                    filtered += 1

                    # 提取前 40 回合的位置
                    board2 = game.board()
                    pos_count = 0
                    for mi, mv in enumerate(moves_list[:40]):
                        if pos_count >= 40:
                            break
                        fen = board2.fen()
                        attack_positions.append({
                            "source": "lichess_attack",
                            "game_id": filtered,
                            "ply": mi,
                            "fen": fen,
                            "bestmove_uci": mv.uci(),
                            "bestmove_san": board2.san(mv),
                            "attack_score": round(attack_score, 1),
                            "white_elo": white_elo,
                            "black_elo": black_elo,
                            "sac_value": sac_value,
                            "king_attacks": king_exposed_attacks,
                            "checks": checks,
                            "captures": captures,
                        })
                        board2.push(mv)
                        pos_count += 1

                    attack_pgns.append(str(game))

                    if filtered % 50 == 0:
                        print(f"    已筛选 {filtered}/{num_games} 局进攻对局...", file=sys.stderr)

    # 清理临时文件
    import shutil
    shutil.rmtree(tmp_dir, ignore_errors=True)

    # 写入文件
    with open(out_pgn, "w", encoding="utf-8") as f:
        for pgn in attack_pgns:
            f.write(pgn + "\n\n")

    with open(out_jsonl, "w", encoding="utf-8") as f:
        for pos in attack_positions:
            f.write(json.dumps(pos, ensure_ascii=False) + "\n")

    summary = {
        "type": "lichess_attacks",
        "downloaded": downloaded,
        "filtered": filtered,
        "total_positions": len(attack_positions),
        "min_rating": min_rating,
        "pgn_file": str(out_pgn),
        "jsonl_file": str(out_jsonl),
        "pgn_size_mb": round(out_pgn.stat().st_size / 1024 / 1024, 2) if out_pgn.exists() else 0,
        "jsonl_size_mb": round(out_jsonl.stat().st_size / 1024 / 1024, 2) if out_jsonl.exists() else 0,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }

    print(f"\n  Lichess 筛选完毕:", file=sys.stderr)
    print(f"    下载对局:   {downloaded:,}", file=sys.stderr)
    print(f"    筛选进攻:   {filtered}", file=sys.stderr)
    print(f"    训练位置:   {len(attack_positions):,}", file=sys.stderr)
    print(f"    PGN:        {summary['pgn_size_mb']} MB", file=sys.stderr)
    print(f"\n{'='*64}\n", file=sys.stderr)

    return summary


# ── 合并与摘要 ─────────────────────────────────────────
def write_combined_summary(summaries: list[dict], output_dir: Path):
    """写入总体数据集摘要。"""
    combined = {
        "version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "components": summaries,
        "totals": {
            "total_positions": sum(s.get("total_positions", 0) for s in summaries),
            "total_kept_games": sum(s.get("kept_games", 0) for s in summaries),
            "selfplay_pct": 80,
            "lichess_pct": 20,
        },
    }

    summary_path = output_dir / "dataset_summary.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(combined, f, indent=2, ensure_ascii=False)

    print(f"  总体摘要: {summary_path}", file=sys.stderr)
    print(f"  总训练位置: {combined['totals']['total_positions']:,}", file=sys.stderr)


# ── CLI 入口 ───────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="S.T.A.R. Policy CNN 数据集生成器",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 快速测试（5 局，浅搜索）
  python dataset_gen.py --selfplay 5 --depth 4 --movetime 200

  # 第一批：2000 局自对弈（起步最低要求）
  python dataset_gen.py --selfplay 2000 --depth 6 --movetime 500

  # 完整生产：2000 自对弈 + Lichess 进攻包
  python dataset_gen.py --selfplay 2000 --depth 6 --movetime 500 --lichess

  # 仅处理 Lichess 数据
  python dataset_gen.py --lichess-only --lichess-games 500
""",
    )
    parser.add_argument("--engine", default=str(ENGINE_BIN), help="引擎路径")
    parser.add_argument("--output-dir", "-O", default=str(DATA_DIR), help="输出目录")
    parser.add_argument("--selfplay", "-n", type=int, default=0, help="自对弈局数（0=跳过）")
    parser.add_argument("--depth", "-d", type=int, default=6, help="搜索深度")
    parser.add_argument("--movetime", "-t", type=int, default=500, help="每步思考时间 ms")
    parser.add_argument("--max-plies", type=int, default=40, help="每局最大回合数")
    parser.add_argument("--lichess", action="store_true", help="同时下载筛选 Lichess 进攻对局")
    parser.add_argument("--lichess-only", action="store_true", help="仅做 Lichess 部分")
    parser.add_argument("--lichess-games", type=int, default=500, help="Lichess 筛选目标数量")
    parser.add_argument("--min-rating", type=int, default=2000, help="Lichess 最低 Elo")
    parser.add_argument("-v", "--verbose", action="store_true", help="详细输出")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    summaries: list[dict] = []

    # 80%: 自对弈
    if args.selfplay > 0 or not args.lichess_only:
        n = args.selfplay if args.selfplay > 0 else 2000
        print(f"\n{'#'*64}", file=sys.stderr)
        print(f"#  自对弈数据生成 ({n} 局, depth={args.depth}, movetime={args.movetime}ms)")
        print(f"{'#'*64}\n", file=sys.stderr)
        sp_summary = run_selfplay(
            engine_path=args.engine,
            num_games=n,
            depth=args.depth,
            movetime_ms=args.movetime,
            max_plies=args.max_plies,
            output_dir=output_dir,
            verbose=args.verbose,
        )
        summaries.append(sp_summary)

    # 20%: Lichess 进攻对局
    if args.lichess or args.lichess_only:
        lc_summary = download_and_filter_lichess(
            num_games=args.lichess_games,
            output_dir=output_dir,
            min_rating=args.min_rating,
            verbose=args.verbose,
        )
        summaries.append(lc_summary)

    # 写合并摘要
    if summaries:
        write_combined_summary(summaries, output_dir)


if __name__ == "__main__":
    main()
