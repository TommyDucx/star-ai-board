#!/usr/bin/env python3
"""
my-engine 自对弈数据生成器
===========================
通过 UCI 协议驱动 my-engine 进行自我对弈，每步记录：
  - FEN（局面）
  - bestmove（引擎选出的最佳走法）
  - score cp（评估分，白方厘兵视角）
  - depth / nodes / time（搜索元数据）
  - game_id / ply（游戏编号与步数）

输出格式：JSONL（每行一个 JSON 对象），可直接用于 Policy CNN 训练。

用法:
  python selfplay.py --games 100 --depth 6 --movetime 500 --output ../data/selfplay.jsonl
  python selfplay.py --games 10   --depth 4 --movetime 200 --output test.jsonl       # 快速测试
"""

import argparse
import json
import os
import random
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

# ── 常量 ──────────────────────────────────────────────
ENGINE_BIN = Path(__file__).resolve().parent / "handcrafted" / "target" / "release" / "my-engine"

# 常用开局走法库（UCI 格式），用于随机化开局增加数据多样性
OPENING_BOOK = [
    # 王兵开局系
    ["e2e4", "e7e5"],                          # 开放式
    ["e2e4", "c7c5"],                          # 西西里防御
    ["e2e4", "e7e6"],                          # 法兰西防御
    ["e2e4", "c7c6"],                          # 卡罗-康防御
    ["d2d4", "d7d5", "c2c4"],                 # 后翼弃兵
    ["d2d4", "f7f5"],                          # 荷兰防御
    ["d2d4", "g8f6", "c2c4"],                 # 尼姆佐印度/新印度
    ["e2e4", "g8f6"],                          # 阿廖欣防御
    ["c2c4", "e7e5", "g1f3"],                  # 英式开局
    ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5"], # 西班牙开局（多几步）
    ["d2d4", "d7d5", "c2c4", "e7e6"],         # 后翼弃兵接受/拒吃
    ["e2e4", "c7c5", "b1c3", "g8f6"],         # 西西里封闭变例
    ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"], # 意大利开局
    ["d2d4", "n8f6", "c2c4", "g7g6"],         # 王翼印度
]


class UCIClient:
    """轻量级 UCI 引擎客户端，通过子进程 stdin/stdout 通信。"""

    def __init__(self, engine_path: str, verbose: bool = False):
        self.engine_path = engine_path
        self.verbose = verbose
        self.proc = None
        self._lock = threading.Lock()

    def start(self):
        """启动引擎进程。"""
        if not os.path.isfile(self.engine_path):
            raise FileNotFoundError(f"引擎二进制不存在: {self.engine_path}")
        self.proc = subprocess.Popen(
            [self.engine_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # 行缓冲
        )
        # 启动 stderr 消费线程（避免管道阻塞）
        def _drain_err():
            for _ in self.proc.stderr:
                pass
        threading.Thread(target=_drain_err, daemon=True).start()
        return self

    def send(self, cmd: str):
        """发送 UCI 命令。"""
        if self.verbose:
            print(f"  > {cmd}", file=sys.stderr)
        self.proc.stdin.write(cmd + "\n")
        self.proc.stdin.flush()

    def read_until(self, pattern: str, timeout: float = 120.0) -> list[str]:
        """读取 stdout 直到匹配 pattern 的行出现，返回所有已读行。"""
        lines = []
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                break
            line = line.rstrip("\n\r")
            lines.append(line)
            if self.verbose and not line.startswith("info"):
                print(f"  < {line}", file=sys.stderr)
            if re.search(pattern, line):
                break
        return lines

    def uci_init(self):
        """完成 UCI 初始化握手。"""
        self.send("uci")
        self.read_until("uciok")
        self.send("isready")
        self.read_until("readyok")

    def newgame(self):
        """开始新对局。"""
        self.send("ucinewgame")
        self.send("isready")
        self.read_until("readyok")

    def position(self, moves: list[str], startpos: bool = True):
        """设置局面。"""
        if startpos and not moves:
            self.send("position startpos")
        elif startpos:
            self.send(f"position startpos moves {' '.join(moves)}")
        else:
            raise NotImplementedError("FEN position 暂未实现")

    def go(self, depth: int = 6, movetime_ms: int = 500) -> dict:
        """
        执行搜索，返回解析结果。
        返回: {bestmove, score_cp, depth, nodes, time_ms, pv}
        """
        cmd_parts = [f"go depth {depth}"]
        if movetime_ms > 0:
            cmd_parts[0] = f"go depth {depth} movetime {movetime_ms}"
        self.send(cmd_parts[0])

        lines = self.read_until(r"^bestmove\s", timeout=300)

        bestmove = None
        score_cp = None
        info_depth = 0
        info_nodes = 0
        info_time = 0
        pv = ""

        for line in lines:
            bm_match = re.match(r"^bestmove\s+(\S+)", line)
            if bm_match:
                bestmove = bm_match.group(1)
                continue
            if line.startswith("info") and "score" in line:
                sc_match = re.search(r"score\s+cp\s+(-?\d+)", line)
                if sc_match:
                    score_cp = int(sc_match.group(1))
                d_match = re.search(r"depth\s+(\d+)", line)
                if d_match:
                    info_depth = int(d_match.group(1))
                n_match = re.search(r"nodes\s+(\d+)", line)
                if n_match:
                    info_nodes = int(n_match.group(1))
                t_match = re.search(r"time\s+(\d+)", line)
                if t_match:
                    info_time = int(t_match.group(1))
                pv_match = re.search(r"pv\s+(.+)$", line)
                if pv_match:
                    pv = pv_match.group(1).strip()

        return {
            "bestmove": bestmove or "(none)",
            "score_cp": score_cp,
            "depth": info_depth,
            "nodes": info_nodes,
            "time_ms": info_time,
            "pv": pv,
        }

    def stop(self):
        self.send("stop")

    def quit(self):
        try:
            self.send("quit")
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
            self.proc.wait()


def play_one_game(client: UCIClient, game_id: int, depth: int, movetime_ms: int,
                  opening_moves: list[str] | None = None) -> list[dict]:
    """
    执行一局自对弈，返回每步的记录列表。
    engine 执黑白双方。
    """
    client.newgame()
    records = []
    moves = []

    # 如果指定了开局走法，直接应用（不记录这些预置步的数据）
    if opening_moves:
        moves.extend(opening_moves)

    max_ply = 400  # 防止无限循环（正常棋局很少超过 200 步）
    ply = 0

    while ply < max_ply:
        client.position(moves)
        result = client.go(depth=depth, movetime_ms=movetime_ms)

        mv = result["bestmove"]
        if mv == "(none)" or mv == "0000":
            break

        # 构造当前 FEN（近似：用 chess 库或从引擎获取更精确的 FEN）
        # 这里我们记录 moves 序列，后续可精确重建 FEN
        record = {
            "game_id": game_id,
            "ply": ply,
            "moves_so_far": " ".join(moves),
            "bestmove": mv,
            "score_cp": result["score_cp"],
            "depth": result["depth"],
            "nodes": result["nodes"],
            "time_ms": result["time_ms"],
            "pv": result["pv"],
        }
        records.append(record)
        moves.append(mv)
        ply += 1

        # 检测简单终止条件（将杀/长和靠后续分析；这里仅做基本长度截断）
        if ply >= max_ply:
            break

    return records


def generate_dataset(
    engine_path: str,
    output_path: str,
    num_games: int = 100,
    depth: int = 6,
    movetime_ms: int = 500,
    random_openings: bool = True,
    verbose: bool = False,
) -> dict:
    """
    主函数：运行 num_games 局自对弈，写入 output_path（JSONL）。
    返回统计摘要。
    """
    client = UCIClient(engine_path, verbose=verbose)
    client.start()
    client.uci_init()

    total_records = 0
    total_positions = 0
    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)

    with open(output_file, "w", encoding="utf-8") as f:
        for game_i in range(num_games):
            # 随机选择开局（增加多样性）
            opening = None
            if random_openings and random.random() < 0.8:
                opening = random.choice(OPENING_BOOK)

            try:
                records = play_one_game(
                    client,
                    game_id=game_i,
                    depth=depth,
                    movetime_ms=movetime_ms,
                    opening_moves=opening,
                )
            except Exception as e:
                print(f"  [WARN] Game {game_i} 异常: {e}", file=sys.stderr)
                # 重启引擎
                client.quit()
                client.start()
                client.uci_init()
                continue

            for rec in records:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")

            total_records += len(records)
            total_positions += len(records)

            avg_score = (
                sum(r["score_cp"] for r in records if r["score_cp"] is not None)
                / max(len(records), 1)
            )

            elapsed_per_game = sum(r.get("time_ms", 0) for r in records)
            print(
                f"  Game {game_i + 1:4d}/{num_games} | "
                f"plies={len(records):3d} | "
                f"avg_eval={avg_score:+7.1f}cp | "
                f"time={elapsed_per_game/1000:.1f}s | "
                f"total_records={total_records}",
                file=sys.stderr,
            )

    client.quit()

    summary = {
        "output_file": str(output_file),
        "num_games": num_games,
        "total_records": total_records,
        "engine": engine_path,
        "depth": depth,
        "movetime_ms": movetime_ms,
    }
    print(f"\n{'='*60}", file=sys.stderr)
    print(f"数据集生成完毕: {output_path}", file=sys.stderr)
    print(f"  游戏数:     {num_games}", file=sys.stderr)
    print(f"  总记录数:   {total_records}", file=sys.stderr)
    print(f"  文件大小:   {output_file.stat().st_size / 1024 / 1024:.1f} MB", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)

    # 写入摘要文件
    summary_path = output_file.with_suffix(".jsonl.summary.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)

    return summary


# ── CLI ───────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="my-engine 自对弈数据生成器 —— 为 Policy CNN 准备训练数据",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 快速测试（10 局，浅搜索）
  python selfplay.py --games 10 --depth 4 --movetime 200

  # 正式生产（500 局，深度 6）
  python selfplay.py --games 500 --depth 6 --movetime 500 --output ../data/train.jsonl

  # 大规模（后台运行）
  python selfplay.py --games 2000 --depth 8 --movetime 1000 --output ../data/large.jsonl &
""",
    )
    parser.add_argument(
        "--engine",
        default=str(ENGINE_BIN),
        help=f"引擎二进制路径 (默认: {ENGINE_BIN})",
    )
    parser.add_argument(
        "--output", "-o",
        default="../data/selfplay.jsonl",
        help="输出 JSONL 文件路径 (默认: ../data/selfplay.jsonl)",
    )
    parser.add_argument(
        "--games", "-n",
        type=int,
        default=100,
        help="自对弈游戏数量 (默认: 100)",
    )
    parser.add_argument(
        "--depth", "-d",
        type=int,
        default=6,
        help="搜索深度 (默认: 6)",
    )
    parser.add_argument(
        "--movetime", "-t",
        type=int,
        default=500,
        help="每步最大思考时间 ms (默认: 500)",
    )
    parser.add_argument(
        "--no-random-openings",
        action="store_true",
        help="禁用随机开局（全部从初始位置开始）",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="打印 UCI 交互细节",
    )
    args = parser.parse_args()

    generate_dataset(
        engine_path=args.engine,
        output_path=args.output,
        num_games=args.games,
        depth=args.depth,
        movetime_ms=args.movetime,
        random_openings=not args.no_random_openings,
        verbose=args.verbose,
    )


if __name__ == "__main__":
    main()
