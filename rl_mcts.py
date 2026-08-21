#!/usr/bin/env python3
"""BiaoZi MCTS 迭代主循环（AlphaZero-lite，断点续跑）。

每轮迭代：
  1. 自博弈（W 个 Rust worker 并行，样本本地、对局档案入库）
  2. 训练候选网（从 best 微调）
  3. 门禁赛：候选 vs 现任_best（match.py，同二进制不同权重），≥55% 晋级
  4. 每 --bench-every 轮：vs 手写eval 基准赛（强度曲线）
  5. 更新 manifest + CLOUD_AGENT_STATUS.md + git commit/push（崩溃安全）

用法（云端 18h 会话）:
  python3 rl_mcts.py --session-hours 16 --workers 6 --games-per-iter 1500 \
      --playouts 300 --steps 4000 --gate-games 200 --bench-every 3
冒烟:
  python3 rl_mcts.py --iterations-max 1 --games-per-iter 4 --workers 2 \
      --playouts 12 --steps 20 --gate-games 4 --bench-games 0
"""
import argparse
import glob
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUN = ROOT / "run"
PY = sys.executable
SELFPLAY_BIN = ROOT / "mcts" / "target" / "release" / "mcts-selfplay"
UCI_BIN = ROOT / "mcts" / "target" / "release" / "mcts-uci"
INFER_PY = ROOT / "mcts" / "py" / "infer_server.py"
MATCH_PY = ROOT / "match.py"


def sh(cmd, **kw):
    print("  $", cmd if isinstance(cmd, str) else " ".join(map(str, cmd)), flush=True)
    return subprocess.run(cmd, **kw)


def load_manifest():
    p = RUN / "manifest.json"
    if p.exists():
        return json.load(open(p))
    return {"iter": 0, "best": "nets/net_best.pt", "curve": []}


def save_manifest(man):
    RUN.mkdir(parents=True, exist_ok=True)
    json.dump(man, open(RUN / "manifest.json", "w"), indent=1, ensure_ascii=False)


def git_commit_push(msg):
    try:
        sh(["git", "add", "-A", "run/", "CLOUD_AGENT_STATUS.md"])
        sh(["git", "commit", "-m", msg])
        sh(["git", "push", "origin", "main"])
    except Exception as e:
        print(f"  [git] 失败（不中断）: {e}", flush=True)


def update_status(man, note):
    p = ROOT / "CLOUD_AGENT_STATUS.md"
    try:
        s = open(p).read()
        marker = "## 三、当前进度"
        idx = s.find(marker)
        head, tail = s[:idx], s[idx:]
        block = f"{marker}\n\n> ⚡ 最新：{note}\n"
        rest = tail[tail.find("\n", tail.find(marker)):]
        open(p, "w").write(head + block + rest)
    except Exception as e:
        print("  [status] 更新失败:", e, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-hours", type=float, default=16)
    ap.add_argument("--iterations-max", type=int, default=0)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--games-per-iter", type=int, default=1500)
    ap.add_argument("--playouts", type=int, default=300)
    ap.add_argument("--temp-moves", type=int, default=20)
    ap.add_argument("--steps", type=int, default=4000)
    ap.add_argument("--gate-games", type=int, default=200)
    ap.add_argument("--bench-every", type=int, default=3)
    ap.add_argument("--bench-games", type=int, default=200)
    ap.add_argument("--movetime", type=int, default=800)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--infer-python", default=PY)
    ap.add_argument("--handcrafted", default=str(ROOT / "my-engine/handcrafted/target/release/my-engine"))
    args = ap.parse_args()

    assert SELFPLAY_BIN.exists(), f"缺 {SELFPLAY_BIN}（先 cargo build --release）"
    assert UCI_BIN.exists(), f"缺 {UCI_BIN}"

    man = load_manifest()
    for d in ["nets", "games", "samples", "bench"]:
        (RUN / d).mkdir(parents=True, exist_ok=True)
    if man["iter"] == 0 and not (RUN / man["best"]).exists():
        print("[init] 导出随机初始化网…", flush=True)
        sh([PY, str(ROOT / "mcts/py/train_mcts.py"), "--init-out", str(RUN / man["best"])])
        save_manifest(man)

    deadline = time.time() + args.session_hours * 3600
    margin = min(45 * 60, args.session_hours * 3600 * 0.2)
    # 推理服务路径用绝对路径透传给引擎子进程（match.py 的 workdir 是临时目录）
    os.environ["AZ_SERVER"] = str(INFER_PY)
    os.environ["AZ_PYTHON"] = PY
    os.environ["AZ_THREADS"] = "2"

    while time.time() < deadline - margin:
        if args.iterations_max and man["iter"] >= args.iterations_max:
            print("[loop] 达到轮数上限", flush=True)
            break
        i = man["iter"] + 1
        best_rel = man["best"]
        best_abs = RUN / best_rel
        t_iter = time.time()
        print(f"\n===== 迭代 {i} =====", flush=True)

        # ---- 1. 自博弈 ----
        per_worker = math.ceil(args.games_per_iter / args.workers)
        procs = []
        for w in range(args.workers):
            cmd = [
                str(SELFPLAY_BIN),
                "--games", str(per_worker),
                "--playouts", str(args.playouts),
                "--seed", str(i * 1000 + w),
                "--infer-python", args.infer_python,
                "--weights", str(best_abs),
                "--net-tag", f"iter{i}w{w}",
                "--out-samples", str(RUN / f"samples/s{i}_{w}.jsonl"),
                "--out-games", str(RUN / f"games/games_i{i}_{w}.jsonl.gz"),
            ]
            env = dict(os.environ, AZ_THREADS="2")
            logf = open(RUN / f"samples/worker{i}_{w}.log", "w")
            procs.append(subprocess.Popen(cmd, stderr=logf))
        rc_ok = all(p.wait() == 0 for p in procs)
        sample_files = sorted(glob.glob(str(RUN / f"samples/s{i}_*.jsonl")))
        game_files = sorted(glob.glob(str(RUN / f"games/games_i{i}_*.jsonl.gz")))
        if not rc_ok or not sample_files:
            print("[loop] 自博弈失败，结束会话（已完成的迭代已落盘）", flush=True)
            break

        # ---- 2. 训练候选网 ----
        cand_rel = f"net_iter{i}.pt"
        cand_abs = RUN / "nets" / cand_rel
        r = sh([PY, str(ROOT / "mcts/py/train_mcts.py"),
                "--samples", *sample_files,
                "--steps", str(args.steps),
                str(cand_abs)])
        if r.returncode != 0:
            print("[loop] 训练失败，结束会话", flush=True)
            break

        # ---- 3. 门禁赛：候选(A) vs 现任(B)，同一二进制不同权重 ----
        gate_json = RUN / "bench" / f"gate_{i}.json"
        r = sh([sys.executable, str(MATCH_PY),
                "--eng", str(UCI_BIN),
                "--name-a", f"cand{i}", "--name-b", "best",
                "--nnue-a", str(cand_abs), "--nnue-b", str(best_abs),
                "--games", str(args.gate_games), "--movetime", str(args.movetime),
                "--concurrency", str(min(args.concurrency, 8)),
                "--threads-a", "1", "--threads-b", "1",
                "--out", str(gate_json)])
        promoted = False
        gate_note = "门禁未跑"
        if r.returncode == 0 and gate_json.exists():
            g = json.load(open(gate_json))
            sa = g.get("score_A", 0)
            promoted = sa >= 0.55
            gate_note = f"门禁 cand 得分 {sa:.3f} ({'晋级' if promoted else '回滚'})"
        print(f"[gate] {gate_note}", flush=True)

        if promoted:
            man["best"] = f"nets/{cand_rel}"
        man["iter"] = i

        # ---- 4. 基准赛 vs 手写eval ----
        if args.bench_games > 0 and (i == 1 or i % args.bench_every == 0):
            bench_json = RUN / "bench" / f"bench_{i}.json"
            r = sh([sys.executable, str(MATCH_PY),
                    "--eng-a", args.handcrafted,
                    "--eng-b", str(UCI_BIN),
                    "--name-a", "handcrafted", "--name-b", f"mcts_iter{i}",
                    "--nnue-b", str(best_abs),
                    "--games", str(args.bench_games), "--movetime", str(args.movetime),
                    "--concurrency", str(min(args.concurrency, 8)),
                    "--threads-a", "1", "--threads-b", "1",
                    "--out", str(bench_json)])
            if r.returncode == 0 and bench_json.exists():
                b = json.load(open(bench_json))
                man["curve"].append({
                    "iter": i,
                    "handcrafted": b.get("results", {}).get("handcrafted"),
                    "mcts": b.get("results", {}).get(f"mcts_iter{i}"),
                    "elo_diff": b.get("elo_diff_A_minus_B"),
                })
                print(f"[bench] 曲线: {man['curve'][-1]}", flush=True)

        man["minutes"] = round((time.time() - t_iter) / 60, 1)
        save_manifest(man)

        # ---- 5. 落盘 + 推送 ----
        note = f"M6/MCTS iter{i}: {'晋级' if promoted else '回滚'}；{gate_note}"
        update_status(man, note)
        git_commit_push(f"rl(mcts): iter{i} 自博弈+训练+门禁（{'晋级' if promoted else '回滚'}）")

    print("\n[session] 会话结束，进度已落盘", flush=True)


if __name__ == "__main__":
    main()
