#!/usr/bin/env python3
"""
RL 自对弈生成器：多进程并行 + 高 PolicyAggressiveness（强制进攻弃子）。

复用 dataset_gen.py 的 UCIClient / play_one_game / OPENING_BOOK，但：
  1. 多进程并行（--workers），大幅提升自对弈吞吐；
  2. 每进程设置高 PolicyAggressiveness（--agg，默认 90），强化进攻/弃子风格；
  3. 引擎 Threads 参数可配（--threads，默认 1）；
  4. 输出 selfplay_rl.jsonl（dataset_gen 兼容格式，交给 merge_dataset.py 合并）。

用法:
  python rl_selfplay.py --games 2000 --workers 4 --depth 6 --movetime 500 --agg 90
  python rl_selfplay.py --games 8 --workers 2 --depth 3 --movetime 150 --agg 90   # 快速冒烟
"""
import argparse
import json
import multiprocessing as mp
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dataset_gen import UCIClient, OPENING_BOOK, play_one_game  # noqa: E402

ENGINE_BIN = Path(__file__).resolve().parent / "my-engine" / "target" / "release" / "my-engine"
DATA_DIR = Path(__file__).resolve().parent / "data"


def _worker(args):
    """单个进程：自对弈指定 game_ids，返回样本列表（dataset_gen 兼容格式）。"""
    game_ids, depth, movetime, max_plies, agg, threads, seed = args
    random.seed(seed)

    client = UCIClient(str(ENGINE_BIN))
    client.start()
    client.uci_init()
    # 高进攻性 + 引擎多线程（内部）
    client.send(f"setoption name PolicyAggressiveness value {agg}")
    client.send(f"setoption name Threads value {threads}")
    client.send("isready")
    while True:
        line = client._readline_stdout(timeout_s=15)
        if line == "readyok":
            break
    client._drain_stderr()

    samples = []
    for gid in game_ids:
        opening = random.choice(OPENING_BOOK) if random.random() < 0.8 else None
        try:
            game = play_one_game(
                client, game_id=gid, depth=depth, movetime_ms=movetime,
                max_plies=max_plies, opening_uci=opening,
            )
        except Exception as e:
            print(f"[WARN] game {gid}: {e}", file=sys.stderr, flush=True)
            continue
        if game is None or game["is_drawish"]:
            continue
        # 转成 final_dataset 兼容格式，供 rl_loop 直接追加到训练集
        for pos in game["positions"]:
            samples.append({
                "source": "selfplay",
                "fen": pos["fen"],
                "bestmove_uci": pos["bestmove_uci"],
                "bestmove_san": pos["bestmove_san"],
                "score_cp": pos["score_cp"],
                "eval_available": pos["score_cp"] is not None,
                "side_to_move": pos["side_to_move"],
                "is_capture": pos["is_capture"],
                "is_check": pos["is_check"],
                "meta": {"game_id": pos["game_id"], "ply": pos["ply"], "depth": pos["depth"]},
            })

    client.quit()
    return samples


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", "-n", type=int, default=500, help="自对弈总局数")
    ap.add_argument("--workers", "-w", type=int, default=4, help="并行进程数")
    ap.add_argument("--depth", "-d", type=int, default=6, help="搜索深度")
    ap.add_argument("--movetime", "-t", type=int, default=500, help="每步思考时间 ms")
    ap.add_argument("--max-plies", type=int, default=60, help="每局最大回合数")
    ap.add_argument("--agg", type=int, default=90, help="PolicyAggressiveness 0~100")
    ap.add_argument("--threads", type=int, default=1, help="引擎内部线程数")
    ap.add_argument("--output", "-o", default=str(DATA_DIR / "selfplay_rl.jsonl"))
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    workers = max(1, min(args.workers, args.games))
    # 把 game_id 尽量均匀分给各 worker
    per = args.games // workers
    buckets = []
    cursor = 0
    for w in range(workers):
        n = per + (1 if w < args.games % workers else 0)
        buckets.append(list(range(cursor, cursor + n)))
        cursor += n

    tasks = [(b, args.depth, args.movetime, args.max_plies,
              args.agg, args.threads, args.seed + w) for w, b in enumerate(buckets)]

    print(f"RL 自对弈: {args.games} 局 / {workers} 进程 / depth {args.depth} "
          f"/ movetime {args.movetime}ms / agg {args.agg}", file=sys.stderr, flush=True)

    all_samples = []
    # macOS spawn 需要 __main__ 保护（见文件末尾）
    with mp.Pool(processes=workers) as pool:
        for i, samples in enumerate(pool.imap_unordered(_worker, tasks)):
            all_samples.extend(samples)
            print(f"  worker {i+1}/{workers} 完成，累计样本 {len(all_samples)}",
                  file=sys.stderr, flush=True)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        for s in all_samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    print(f"完成: {len(all_samples)} 个样本 → {out}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
