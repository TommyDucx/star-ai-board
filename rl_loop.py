#!/usr/bin/env python3
"""
RL 自博弈强化学习闭环主循环
=============================
每轮迭代：
  1. 多进程自对弈（高 PolicyAggressiveness）→ data/selfplay_rl.jsonl
  2. 追加新样本到 data/final_dataset.jsonl
  3. 备份当前 policy.bin
  4. 用扩充后的数据集重训 Policy → 导出新 policy.bin
  5. 新旧 policy 自动对弈（match.py）
  6. 新版胜率 >56% → 替换为主版本；否则回滚，结束本轮（避免越训越差）

用法:
  python rl_loop.py --rounds 5 --games 500 --workers 4 --agg 90 --match-games 200
  python rl_loop.py --rounds 1 --games 8 --workers 2 --depth 3 --movetime 150 --epochs 2 --match-games 12  # 冒烟
"""
import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENGINE = ROOT / "my-engine" / "target" / "release" / "my-engine"
POLICY_BIN = ROOT / "my-engine" / "policy.bin"          # 部署/运行所用的策略（权威）
POLICY_DIR = ROOT / "my-engine" / "policy"              # 训练脚本目录
DATA_FILE = ROOT / "data" / "final_dataset.jsonl"
SELFPLAY_RL = ROOT / "data" / "selfplay_rl.jsonl"

PY = "/Users/tommydu/miniconda3/envs/pfllib/bin/python3"  # python 3.11 + torch + chess，跑所有脚本
SYS_PY = PY                                             # 统一用 pfllib（dataset_gen 需 3.10+ 语法）

WIN_RATE_THRESHOLD = 0.56


def run(cmd, cwd=None):
    print(f"  $ {cmd}", flush=True)
    r = subprocess.run(cmd, shell=True, cwd=cwd)
    if r.returncode != 0:
        print(f"  [FAIL] 命令返回 {r.returncode}: {cmd}", flush=True)
    return r.returncode


def step_selfplay(games, workers, depth, movetime, agg):
    print(f"\n[步骤1] 自对弈 {games} 局（{workers} 进程 / depth {depth} / movetime {movetime}ms / agg {agg}）", flush=True)
    return run(f"{SYS_PY} \"{ROOT}/rl_selfplay.py\" --games {games} --workers {workers} "
               f"--depth {depth} --movetime {movetime} --agg {agg}")


def step_append():
    print("\n[步骤2] 追加自对弈样本到 final_dataset.jsonl", flush=True)
    if not SELFPLAY_RL.exists():
        print("  [FAIL] 无 selfplay_rl.jsonl", flush=True)
        return 1
    with open(SELFPLAY_RL, encoding="utf-8") as f:
        text = f.read().strip()
    if not text:
        print("  [FAIL] selfplay_rl.jsonl 为空", flush=True)
        return 1
    with open(DATA_FILE, "a", encoding="utf-8") as f:
        f.write(text + "\n")
    n = text.count("\n") + 1
    print(f"  追加 {n} 个样本", flush=True)
    return 0


def step_train(epochs):
    print(f"\n[步骤3] 重训 Policy（{epochs} epochs）", flush=True)
    if run(f"{PY} train_policy.py --epochs {epochs}", cwd=POLICY_DIR) != 0:
        return 1
    if run(f"{PY} export_weights.py", cwd=POLICY_DIR) != 0:
        return 1
    return 0


def step_eval(match_games, movetime, concurrency=4):
    print(f"\n[步骤4] 新旧 policy 对弈（{match_games} 局）", flush=True)
    old = ROOT / "data" / "policy_old.bin"
    new = POLICY_DIR / "policy.bin"
    out = ROOT / "data" / "rl_match_report.json"
    cmd = (f"{SYS_PY} \"{ROOT}/match.py\" --eng \"{ENGINE}\" "
           f"--policy-a \"{old}\" --policy-b \"{new}\" "
           f"--games {match_games} --concurrency {concurrency} --movetime {movetime} "
           f"--threads-a 1 --threads-b 1 "
           f"--name-a old --name-b new --out \"{out}\"")
    if run(cmd) != 0:
        return None
    with open(out, encoding="utf-8") as f:
        rep = json.load(f)
    score_old = rep.get("score_A")  # A=旧 policy 的得分
    win_new = 1.0 - score_old if score_old is not None else None
    return {"score_old": score_old, "win_new": win_new, "report": rep}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=5, help="迭代轮数")
    ap.add_argument("--games", type=int, default=500, help="每轮自对弈局数")
    ap.add_argument("--workers", type=int, default=4, help="自对弈并发进程数")
    ap.add_argument("--depth", type=int, default=6, help="自对弈搜索深度")
    ap.add_argument("--movetime", type=int, default=500, help="自对弈每步思考 ms")
    ap.add_argument("--agg", type=int, default=90, help="PolicyAggressiveness")
    ap.add_argument("--epochs", type=int, default=40, help="训练轮数")
    ap.add_argument("--match-games", type=int, default=200, help="评估对局数(正式1000)")
    ap.add_argument("--match-movetime", type=int, default=300, help="评估每步 ms")
    ap.add_argument("--match-concurrency", type=int, default=4, help="评估并行槽位数")
    args = ap.parse_args()

    history = []
    for r in range(1, args.rounds + 1):
        print(f"\n{'='*60}\n第 {r}/{args.rounds} 轮\n{'='*60}", flush=True)
        t0 = time.time()

        # 1. 自对弈
        if step_selfplay(args.games, args.workers, args.depth, args.movetime, args.agg) != 0:
            print("自对弈失败，终止", flush=True)
            break

        # 2. 追加数据
        if step_append() != 0:
            print("追加数据失败，终止", flush=True)
            break

        # 3. 备份当前 policy（用于回滚 + 评估的旧侧）
        old_policy = ROOT / "data" / "policy_old.bin"
        shutil.copy(POLICY_BIN, old_policy)
        print(f"[步骤3a] 备份当前 policy → {old_policy.name}", flush=True)

        # 4. 训练 + 导出新 policy（输出到 policy/policy.bin）
        if step_train(args.epochs) != 0:
            print("训练失败，恢复旧 policy，终止本轮", flush=True)
            shutil.copy(old_policy, POLICY_BIN)
            break

        # 5. 评估（旧 policy_old.bin vs 新 policy/policy.bin）
        ev = step_eval(args.match_games, args.match_movetime, args.match_concurrency)
        if ev is None:
            print("评估失败，恢复旧 policy，终止本轮", flush=True)
            shutil.copy(old_policy, POLICY_BIN)
            break

        win_new = ev["win_new"]
        print(f"\n[步骤5] 新版胜率 = {win_new:.4f}（阈值 {WIN_RATE_THRESHOLD}）", flush=True)
        if win_new is not None and win_new > WIN_RATE_THRESHOLD:
            # 采纳新 policy：把 policy/policy.bin 复制到权威位置
            shutil.copy(POLICY_DIR / "policy.bin", POLICY_BIN)
            print(f"  ✅ 采纳新 policy（胜率 {win_new:.4f} > {WIN_RATE_THRESHOLD}）", flush=True)
            adopted = True
        else:
            # 回滚
            shutil.copy(old_policy, POLICY_BIN)
            print(f"  ❌ 回滚到旧 policy（胜率 {win_new} 未达标）", flush=True)
            adopted = False

        history.append({"round": r, "win_new": win_new, "adopted": adopted,
                        "seconds": round(time.time() - t0, 1)})
        print(f"  本轮耗时 {history[-1]['seconds']}s", flush=True)

    print(f"\n{'='*60}\n闭环结束，历史记录：\n{'='*60}", flush=True)
    for h in history:
        print(f"  round {h['round']}: 新版胜率 {h['win_new']:.4f} → {'采纳' if h['adopted'] else '回滚'}（{h['seconds']}s）", flush=True)
    with open(ROOT / "data" / "rl_loop_history.json", "w", encoding="utf-8") as f:
        json.dump(history, f, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
