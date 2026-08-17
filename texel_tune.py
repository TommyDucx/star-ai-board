#!/usr/bin/env python3
"""Texel tuning：用「FEN + 对局结果」做 logistic 回归，优化 eval.rs 的 25 个标量参数。

原理：eval(board) = Σ_i w_i · x_i(board) 是参数的线性函数，故对
    P(白胜) = sigmoid(eval/400) = 1/(1 + 10^(-eval/400))
    最小化 MSE：E = 1/N Σ (result − P)²
等价于 logistic 回归，用 Adam 梯度下降优化 w。

数据格式（每行）：FEN + TAB + result，result 为白方视角 1 / 0.5 / 0。

用法：
  python3 texel_tune.py --data data/texel_data.txt --epochs 200 --lr 0.1 --out tuned_params.json
"""
import argparse
import json
import sys
import numpy as np
import chess

sys.path.insert(0, ".")
from texel_eval import extract_features, FEATURE_NAMES  # noqa: E402

# 初始参数（= eval.rs 当前值），顺序与 FEATURE_NAMES 一一对应
INIT_PARAMS = np.array([
    100, 320, 330, 500, 900,     # 兵 马 象 车 后
    -15, -20, 30,                # 叠兵 孤兵 双象
    20, 10, 30,                  # 车开放线 半开放线 叠车
    5, 10, 20, 35, 60, 140,      # 通路兵 推进 1-6 行
    12, 8,                       # 王盾 第1格 第2格
    6, 4, 3, 2, 1,               # 王翼进攻 后 车 马 象 兵
    3,                           # 兵冲锋
], dtype=np.float64)

# 每个参数的合法区间（梯度下降后 clamp，防止跑到不合理值）
BOUNDS = np.array([
    [50, 10000], [50, 10000], [50, 10000], [50, 10000], [50, 10000],  # 子力值 > 0
    [-1000, 0], [-1000, 0], [0, 1000],                                 # 惩罚负 / 双象正
    [0, 1000], [0, 1000], [0, 1000],                                   # 车线正
    [0, 1000], [0, 1000], [0, 1000], [0, 1000], [0, 1000], [0, 1000],  # 通路兵正
    [0, 500], [0, 500],                                               # 王盾正
    [0, 100], [0, 100], [0, 100], [0, 100], [0, 100],                  # 王翼进攻正
    [0, 100],                                                          # 兵冲锋正
], dtype=np.float64)

LOG10_OVER_400 = np.log(10.0) / 400.0


def sigmoid(eval_cp):
    return 1.0 / (1.0 + np.power(10.0, -eval_cp / 400.0))


def load_data(path):
    fens, results = [], []
    with open(path) as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            if "\t" in line:
                fen, res = line.rsplit("\t", 1)
            else:
                parts = line.split()
                fen = " ".join(parts[:6])
                res = parts[6]
            fens.append(fen)
            results.append(float(res))
    return fens, np.array(results, dtype=np.float64)


def build_matrix(fens, quiet=True):
    rows = []
    skip = 0
    for i, fen in enumerate(fens):
        try:
            b = chess.Board(fen)
            if b.is_game_over():
                skip += 1
                continue
            rows.append(extract_features(b))
        except Exception:
            skip += 1
    if not rows:
        raise RuntimeError("无有效局面")
    if quiet:
        print(f"  提取特征 {len(rows)} 个局面（跳过 {skip} 个终局/非法）", file=sys.stderr, flush=True)
    return np.array(rows, dtype=np.float64)


def adam_tune(X, y, epochs, lr, w_init, bounds, freeze_mask, seed=42):
    np.random.seed(seed)
    w = w_init.copy()
    m = np.zeros_like(w)
    v = np.zeros_like(w)
    beta1, beta2, eps = 0.9, 0.999, 1e-8
    n = X.shape[0]
    # 按批训练（数据量大时避免整矩阵反复乘）
    batch = 8192
    for epoch in range(epochs):
        idx = np.random.permutation(n)
        for s in range(0, n, batch):
            ids = idx[s:s + batch]
            Xb, yb = X[ids], y[ids]
            eval_cp = Xb @ w
            p = sigmoid(eval_cp)
            d = -2.0 * (yb - p) * p * (1.0 - p) * LOG10_OVER_400  # dloss/deval
            grad = Xb.T @ d / len(ids)
            grad = np.where(freeze_mask, 0.0, grad)  # 冻结参数：梯度置 0
            m = beta1 * m + (1 - beta1) * grad
            v = beta2 * v + (1 - beta2) * (grad * grad)
            mhat = m / (1 - beta1 ** (epoch + 1))
            vhat = v / (1 - beta2 ** (epoch + 1))
            w -= lr * mhat / (np.sqrt(vhat) + eps)
            w = np.clip(w, bounds[:, 0], bounds[:, 1])
        if epoch % 10 == 0 or epoch == epochs - 1:
            p = sigmoid(X @ w)
            loss = np.mean((y - p) ** 2)
            print(f"  epoch {epoch:3d}  loss {loss:.6f}", file=sys.stderr, flush=True)
    return w


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--epochs", type=int, default=200)
    ap.add_argument("--lr", type=float, default=0.1)
    ap.add_argument("--out", default="tuned_params.json")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--freeze", default="katt_queen,katt_rook,katt_knight,katt_bishop,katt_pawn,pawn_storm",
                    help="逗号分隔的冻结参数名（不更新梯度）。默认冻结全部攻王/兵冲锋，"
                         "规避上次「攻王过拟合」(-61 Elo) 的失败模式")
    args = ap.parse_args()

    freeze_names = {x.strip() for x in args.freeze.split(",") if x.strip()}
    freeze_mask = np.array([name in freeze_names for name in FEATURE_NAMES], dtype=bool)
    n_frozen = int(freeze_mask.sum())
    print(f"冻结 {n_frozen} 个参数: {[n for n, m in zip(FEATURE_NAMES, freeze_mask) if m]}",
          file=sys.stderr, flush=True)

    fens, y = load_data(args.data)
    print(f"数据 {len(fens)} 条（result 均值 {y.mean():.4f}）", file=sys.stderr, flush=True)
    X = build_matrix(fens)
    assert X.shape[1] == len(INIT_PARAMS), f"特征维 {X.shape[1]} != {len(INIT_PARAMS)}"

    print(f"初始 loss {np.mean((y - sigmoid(X @ INIT_PARAMS)) ** 2):.6f}", file=sys.stderr, flush=True)
    w = adam_tune(X, y, args.epochs, args.lr, INIT_PARAMS, BOUNDS, freeze_mask, args.seed)

    # 输出结果（对比初始值，标注冻结）
    print("\n=== 调参结果（初始 → 调后）===")
    out = {"params": w.round().astype(int).tolist(), "names": FEATURE_NAMES}
    for name, a, b, frozen in zip(FEATURE_NAMES, INIT_PARAMS, w, freeze_mask):
        tag = "  [冻结]" if frozen else ""
        print(f"  {name:12s} {int(a):6d} -> {int(round(b)):6d}{tag}")
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\n已写入 {args.out}")


if __name__ == "__main__":
    main()
