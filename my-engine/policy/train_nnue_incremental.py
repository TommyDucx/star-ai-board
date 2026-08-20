#!/usr/bin/env python3
"""NNUE 增量架构训练 —— HalfK-768(fixed-color) → 累加器(128) → 小头网络 → 白方胜率。

架构（与未来 Rust 增量推理 nnue.rs 一一对应）：
  acc = Linear(768→128)                # 累加器：搜索中增量维护（每步只更新 2-3 列）
  h1  = relu(acc)                      # 128
  h2  = relu(Linear(128→32))           # 32
  h3  = relu(Linear(32→32))            # 32
  z   = Linear(32→1)                   # logit

数据: data-etl --fixed-color 产出的 .scnn（特征不按轮走方翻色，标签 = eval_white）。
标签 T = sigmoid(eval_white/400)（白方胜率）。无增广（棋盘对称性不保持 SF eval）。

输出: policy_nnue_inc.pt / nnue_inc.bin（Rust 可读，version=2 区分 M3 静态版）。

用法:
  python3 train_nnue_incremental.py --scnn data/nnue/train_fc.scnn
"""
import argparse
import math
import os
import random
import struct

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

DATA = "/Users/tommydu/Documents/Star Chess/data/nnue/train_fc.scnn"
OUT_DIR = "/Users/tommydu/Documents/Star Chess/my-engine/policy"
SEED = 42
RECORD = 768 + 8


def sigmoid_cp(cp):
    return 1.0 / (1.0 + 10.0 ** (-np.asarray(cp, dtype=np.float64) / 400.0))


def load_memmap(path, max_samples):
    data = np.memmap(path, dtype=np.uint8, mode="r")
    n_total = int(struct.unpack("<Q", data[8:16].tobytes())[0])
    n = min(n_total, max_samples) if max_samples else n_total
    recs = data[20:20 + n * RECORD].reshape(n, RECORD)
    feat = recs[:, :768].astype(np.float32) / 255.0
    tail = recs[:, 768:776]
    cp = np.frombuffer(tail[:, :4].tobytes(), dtype=np.float32)
    return feat, cp, n_total


class NnueInc(nn.Module):
    def __init__(self, acc_dim=128, head_dim=32):
        super().__init__()
        self.acc = nn.Linear(768, acc_dim)
        self.h1 = nn.Linear(acc_dim, head_dim)
        self.h2 = nn.Linear(head_dim, head_dim)
        self.h3 = nn.Linear(head_dim, 1)

    def forward(self, x):
        a = self.acc(x)
        h = F.relu(a)
        h = F.relu(self.h1(h))
        h = F.relu(self.h2(h))
        return self.h3(h).squeeze(-1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scnn", default=DATA)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--max-samples", type=int, default=0, help="0=全部")
    ap.add_argument("--val-frac", type=float, default=0.1)
    args = ap.parse_args()

    random.seed(SEED)
    torch.manual_seed(SEED)
    np.random.seed(SEED)

    feat, cp, n_total = load_memmap(args.scnn, args.max_samples)
    n = len(cp)
    labels = sigmoid_cp(cp).astype(np.float32)
    print(f"loaded {n}/{n_total} samples (fixed-color, eval_white) "
          f"cp_range=[{cp.min()},{cp.max()}]", flush=True)

    idx = list(range(n))
    random.shuffle(idx)
    n_val = int(n * args.val_frac)
    tr, va = idx[n_val:], idx[:n_val]

    model = NnueInc()
    nparams = sum(p.numel() for p in model.parameters())
    print(f"arch: acc128→relu→32→relu→32→relu→1  params={nparams}", flush=True)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    sched = torch.optim.lr_scheduler.StepLR(opt, step_size=12, gamma=0.5)
    batch = args.batch
    best_val = float("inf")
    best_state = None

    for epoch in range(args.epochs):
        model.train()
        random.shuffle(tr)
        tot, loss_sum = 0, 0.0
        for s in range(0, len(tr), batch):
            ids = tr[s:s + batch]
            xb = torch.from_numpy(feat[ids])
            yb = torch.from_numpy(labels[ids])
            opt.zero_grad()
            p = torch.sigmoid(model(xb))
            loss = F.mse_loss(p, yb)
            loss.backward()
            opt.step()
            loss_sum += loss.item() * len(ids)
            tot += len(ids)
        sched.step()

        model.eval()
        with torch.no_grad():
            errs = []
            for s in range(0, len(va), batch * 4):
                ids = va[s:s + batch * 4]
                xb = torch.from_numpy(feat[ids])
                p = torch.sigmoid(model(xb))
                errs.append((p - torch.from_numpy(labels[ids])).pow(2).sum().item())
            val_mse = sum(errs) / len(va)
        # 早停：val_mse 触底后回升（过拟合），保存最佳权重供导出
        if val_mse < best_val:
            best_val = val_mse
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            tag = " *"
        else:
            tag = ""
        print(f"epoch {epoch:2d} train_mse {loss_sum/tot:.6f} val_mse {val_mse:.6f}{tag}", flush=True)
    if best_state is not None:
        model.load_state_dict(best_state)
    print(f"best val_mse = {best_val:.6f}（已恢复到最佳权重）", flush=True)

    # 验证集统计
    model.eval()
    with torch.no_grad():
        preds, golds = [], []
        for s in range(0, len(va), batch * 4):
            ids = va[s:s + batch * 4]
            xb = torch.from_numpy(feat[ids])
            p = torch.sigmoid(model(xb))
            preds.append(p.numpy())
            golds.append(labels[ids])
        p_all = np.concatenate(preds)
        g_all = np.concatenate(golds)
        r = np.corrcoef(p_all, g_all)[0, 1]
        def cp_from_p(p):
            p = np.clip(p, 1e-7, 1 - 1e-7)
            return -400.0 * np.log10((1.0 - p) / p)
        mae_cp = np.abs(cp_from_p(p_all) - cp_from_p(g_all)).mean()
    print(f"val MAE(cp)={mae_cp:.1f} corr={r:.4f}", flush=True)

    os.makedirs(OUT_DIR, exist_ok=True)
    torch.save(model.state_dict(), f"{OUT_DIR}/policy_nnue_inc.pt")
    export_bin(model, f"{OUT_DIR}/nnue_inc.bin")
    print(f"saved policy_nnue_inc.pt / nnue_inc.bin params={nparams} size~{nparams*4/1e6:.2f}MB")


def export_bin(model, path):
    magic = b"NNUE"
    params = [p.detach().cpu().numpy().astype(np.float32).reshape(-1) for p in model.parameters()]
    flat = np.concatenate(params)
    with open(path, "wb") as f:
        f.write(magic)
        f.write(struct.pack("<II", 2, len(flat)))  # version 2 = 增量架构
        f.write(flat.tobytes())


if __name__ == "__main__":
    main()
