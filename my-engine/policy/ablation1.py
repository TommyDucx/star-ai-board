#!/usr/bin/env python3
"""消融实验1：旧网络(无残差 FC64) + 新数据(过滤+加权)。

目的：分辨第三批 −40 Elo 是「数据重构」还是「残差 CNN」导致。
- 网络用 v2 的 PolicyNet（无残差 FC64，33万参数）；
- 数据用第三批的过滤+加权逻辑；
- lr 用 v2 的 2e-3（排除 lr 调度干扰）。
结论判据：val_top1 明显低于旧版 46% → 数据是主因；≈46% → 残差是主因。
"""
import json, random, argparse
import torch
import torch.nn as nn
import torch.nn.functional as F

from train_policy import PolicyNet, fen_to_tensor, uci_to_label, augment

DATA = "/Users/tommydu/Documents/Star Chess/data/final_dataset.jsonl"
SEED = 42
random.seed(SEED)
torch.manual_seed(SEED)

TACTICAL_THEMES = {"sacrifice", "mate", "crushing", "doubleCheck", "backRankMate",
                   "attraction", "fork", "pin", "skewer", "discoveredAttack"}


def keep_sample(r):
    src = r.get("source", "")
    meta = r.get("meta", {}) or {}
    if src == "selfplay":
        return meta.get("ply", 0) <= 90
    if src in ("lichess", "lichess_puzzle"):
        atk = meta.get("attack_score", 0) or 0
        themes = set(meta.get("themes", []) or [])
        return atk >= 10 or bool(themes & TACTICAL_THEMES)
    return True


def sample_weight(r):
    src = r.get("source", "")
    meta = r.get("meta", {}) or {}
    if src in ("lichess", "lichess_puzzle"):
        atk = meta.get("attack_score", 0) or 0
        themes = set(meta.get("themes", []) or [])
        if atk >= 20 or "mate" in themes or "sacrifice" in themes:
            return 1.6
        return 1.2
    if src == "selfplay":
        score = r.get("score_cp")
        if score is not None:
            if abs(score) < 20:
                return 0.4
            if score > 150:
                return 1.6
    return 1.0


def load(data_path):
    rows = [json.loads(l) for l in open(data_path)]
    selfplay = [r for r in rows if r.get("source") == "selfplay" and keep_sample(r)]
    lichess = [r for r in rows if r.get("source") in ("lichess", "lichess_puzzle") and keep_sample(r)]
    target = int(len(selfplay) / 3.0)
    if len(lichess) > target:
        lichess = random.sample(lichess, target)
    print(f"selfplay={len(selfplay)} lichess={len(lichess)}", flush=True)
    X, y, w = [], [], []
    for r in selfplay + lichess:
        wt = sample_weight(r)
        for vf, vu in augment(r["fen"], r["bestmove_uci"]):
            X.append(fen_to_tensor(vf))
            y.append(uci_to_label(vu))
            w.append(wt)
    return torch.stack(X), torch.tensor(y, dtype=torch.long), torch.tensor(w, dtype=torch.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=40)
    args = ap.parse_args()
    X, y, w = load(DATA)
    n = len(y)
    idx = list(range(n)); random.shuffle(idx)
    split = int(n * 0.8); tr, va = idx[:split], idx[split:]
    print(f"total={n} train={len(tr)} val={len(va)}", flush=True)
    model = PolicyNet()
    opt = torch.optim.Adam(model.parameters(), lr=2e-3)  # v2 的 lr，排除 lr 干扰
    batch = 64
    for epoch in range(args.epochs):
        model.train(); random.shuffle(tr)
        for s in range(0, len(tr), batch):
            ids = tr[s:s + batch]; xb, yb, wb = X[ids], y[ids], w[ids]
            opt.zero_grad()
            loss = (F.cross_entropy(model(xb), yb, reduction="none") * wb).mean()
            loss.backward(); opt.step()
        model.eval()
        with torch.no_grad():
            acc1 = acc5 = 0
            for s in range(0, len(va), batch):
                ids = va[s:s + batch]
                lg = model(X[ids])
                acc1 += (lg.argmax(1) == y[ids]).sum().item()
                acc5 += (lg.topk(5, 1).indices == y[ids].unsqueeze(1)).any(1).sum().item()
            acc1 /= len(va); acc5 /= len(va)
        print(f"epoch {epoch:2d} val_top1 {acc1:.4f} val_top5 {acc5:.4f}", flush=True)


if __name__ == "__main__":
    main()
