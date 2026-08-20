#!/usr/bin/env python3
"""NNUE HalfKP 训练（王桶耦合）—— 稀疏特征 → 累加器(128) → 小头 → 白方胜率。

架构（与未来 Rust nnue.rs v3 一一对应）：
  acc = bias + Σ 列(W[:, f])，f = 该局面的稀疏 HalfKP 特征下标（每局面 ~31 个）
  h1  = relu(acc) → Linear(128→32) → relu → 32 → relu → Linear(32→1) → logit

特征：王桶 B=32（bucket = file*4 + rank//2），每桶 704 槽（us 白非王 320 + them 黑含王 384），
      特征空间 22528。fixed-color（us=白恒等），标签 = eval_white。

数据: data-etl --halfkp 产出（定长记录，v2）：
  header 24B [magic][u32 v=2][u64 N][u32 feature_space=22528][u32 max_features=32]
  N × [u32 count][32×u32 indices(补0)][f32 eval_white][f32 result=NaN] = 140B/条

输出: policy_nnue_hkp.pt / nnue_hkp.bin（version=3，acc_w 已转置 (22528,128) 列连续）。

用法:
  python3 train_nnue_halfkp.py --scnn data/nnue/train_hkp.scnn --max-samples 2000000
"""
import argparse
import os
import random
import struct

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

DATA = "/Users/tommydu/Documents/Star Chess/data/nnue/train_hkp.scnn"
OUT_DIR = "/Users/tommydu/Documents/Star Chess/my-engine/policy"
SEED = 42
FEATURE_SPACE = 22528
MAX_F = 32
RECORD = 4 + MAX_F * 4 + 8  # 140


def sigmoid_cp(cp):
    return 1.0 / (1.0 + 10.0 ** (-np.asarray(cp, dtype=np.float64) / 400.0))


def load_memmap(path, max_samples):
    data = np.memmap(path, dtype=np.uint8, mode="r")
    n_total = int(struct.unpack("<Q", data[8:16].tobytes())[0])
    fs = struct.unpack("<I", data[16:20].tobytes())[0]
    assert fs == FEATURE_SPACE, f"feature_space {fs} != {FEATURE_SPACE}"
    n = min(n_total, max_samples) if max_samples else n_total
    recs = data[24:24 + n * RECORD].reshape(n, RECORD)
    cnt = recs[:, :4].view(np.uint32).reshape(-1)
    idx = recs[:, 4:4 + MAX_F * 4].view(np.uint32)
    tail = recs[:, 4 + MAX_F * 4:]
    ev = np.frombuffer(tail[:, :4].tobytes(), dtype=np.float32)
    return cnt.astype(np.int64), idx.astype(np.int64), ev, n_total


class HalfKpNet(nn.Module):
    def __init__(self, acc_dim=128, head_dim=32, feature_space=FEATURE_SPACE):
        super().__init__()
        self.acc_dim = acc_dim
        self.acc_bias = nn.Parameter(torch.zeros(acc_dim))
        self.acc_w = nn.Parameter(torch.zeros(feature_space, acc_dim))
        nn.init.normal_(self.acc_w, 0, 0.05)
        self.h1 = nn.Linear(acc_dim, head_dim)
        self.h2 = nn.Linear(head_dim, head_dim)
        self.h3 = nn.Linear(head_dim, 1)

    def forward(self, idx, cnt):
        # idx: (B, 32) 特征下标（补0，靠 cnt mask）；acc = bias + Σ 列
        cols = self.acc_w[idx]           # (B, 32, 128)
        mask = torch.arange(MAX_F, device=idx.device)[None, :] < cnt[:, None]  # (B,32)
        acc = self.acc_bias[None, :] + (cols * mask.unsqueeze(-1)).sum(1)       # (B,128)
        h = F.relu(acc)
        h = F.relu(self.h1(h))
        h = F.relu(self.h2(h))
        return self.h3(h).squeeze(-1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scnn", default=DATA)
    ap.add_argument("--epochs", type=int, default=25)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--max-samples", type=int, default=0, help="0=全部")
    ap.add_argument("--val-frac", type=float, default=0.05)
    args = ap.parse_args()

    random.seed(SEED)
    torch.manual_seed(SEED)
    np.random.seed(SEED)

    cnt, idx, ev, n_total = load_memmap(args.scnn, args.max_samples)
    n = len(ev)
    labels = sigmoid_cp(ev).astype(np.float32)
    print(f"loaded {n}/{n_total} samples (HalfKP, feature_space={FEATURE_SPACE}) "
          f"cp_range=[{ev.min()},{ev.max()}]", flush=True)

    ii = list(range(n))
    random.shuffle(ii)
    n_val = max(1, int(n * args.val_frac))
    tr, va = ii[n_val:], ii[:n_val]

    model = HalfKpNet()
    nparams = sum(p.numel() for p in model.parameters())
    print(f"arch: HalfKP({FEATURE_SPACE})→acc128→32→32→1  params={nparams}", flush=True)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    sched = torch.optim.lr_scheduler.StepLR(opt, step_size=8, gamma=0.5)
    batch = args.batch
    best_val = float("inf")
    best_state = None

    for epoch in range(args.epochs):
        model.train()
        random.shuffle(tr)
        tot, loss_sum = 0, 0.0
        for s in range(0, len(tr), batch):
            ids = tr[s:s + batch]
            xb = torch.from_numpy(idx[ids])
            cb = torch.from_numpy(cnt[ids])
            yb = torch.from_numpy(labels[ids])
            opt.zero_grad()
            p = torch.sigmoid(model(xb, cb))
            loss = F.mse_loss(p, yb)
            loss.backward()
            opt.step()
            loss_sum += loss.item() * len(ids)
            tot += len(ids)
        sched.step()

        model.eval()
        with torch.no_grad():
            errs, preds, golds = [], [], []
            for s in range(0, len(va), batch * 4):
                ids = va[s:s + batch * 4]
                xb = torch.from_numpy(idx[ids])
                cb = torch.from_numpy(cnt[ids])
                p = torch.sigmoid(model(xb, cb))
                g = torch.from_numpy(labels[ids])
                errs.append((p - g).pow(2).sum().item())
                preds.append(p.numpy())
                golds.append(g.numpy())
            val_mse = sum(errs) / len(va)
            pa = np.concatenate(preds)
            ga = np.concatenate(golds)
            corr = float(np.corrcoef(pa, ga)[0, 1]) if len(pa) > 1 else 0.0
        if val_mse < best_val:
            best_val = val_mse
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            tag = " *"
        else:
            tag = ""
        print(f"epoch {epoch:2d} train_mse {loss_sum/tot:.6f} val_mse {val_mse:.6f} "
              f"corr {corr:.4f}{tag}", flush=True)
    if best_state is not None:
        model.load_state_dict(best_state)
    print(f"best val_mse = {best_val:.6f}（已恢复最佳权重）", flush=True)

    os.makedirs(OUT_DIR, exist_ok=True)
    torch.save(model.state_dict(), f"{OUT_DIR}/policy_nnue_hkp.pt")
    export_bin(model, f"{OUT_DIR}/nnue_hkp.bin")
    print(f"saved policy_nnue_hkp.pt / nnue_hkp.bin params={nparams} size~{nparams*4/1e6:.1f}MB")


def export_bin(model, path):
    magic = b"NNUE"
    # acc_w (22528,128) 行主序：row=特征 f 的 128 维列（连续），与 Rust 增量取列一一对应
    acc_w = model.acc_w.detach().cpu().numpy().astype(np.float32)
    acc_b = model.acc_bias.detach().cpu().numpy().astype(np.float32)
    head = [p.detach().cpu().numpy().astype(np.float32).reshape(-1)
            for name, p in model.named_parameters() if name.startswith("h")]
    flat = np.concatenate([acc_w.reshape(-1), acc_b, *head])
    with open(path, "wb") as f:
        f.write(magic)
        f.write(struct.pack("<II", 3, len(flat)))  # version 3 = HalfKP
        f.write(flat.tobytes())


if __name__ == "__main__":
    main()
