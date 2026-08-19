#!/usr/bin/env python3
"""NNUE 训练 —— HalfK-768 输入 → 标量 eval（胜率 p），MSE 回归。

数据: data/nnue/train.scnn（Rust ETL 产出）：
  [magic][u32 v][u64 N][u32 768] + N × ([768×u8] 特征 + [f32] cp_stm + [f32] result_stm)
  标签 T = sigmoid(cp_stm/400)，result 列 NaN（本数据源无对局结果，λ 混合退化）。

无对称增广：已由 SF 实测验证 eval 在棋盘旋转/镜像下不保持不变，增广会污染标签。

输出: policy_nnue.pt / policy_nnue.onnx / nnue.bin（Rust 可读）。

用法:
  python3 train_nnue.py --scnn data/nnue/train.scnn --max-samples 1500000
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

DATA = "/Users/tommydu/Documents/Star Chess/data/nnue/train.scnn"
OUT_DIR = "/Users/tommydu/Documents/Star Chess/my-engine/policy"
SEED = 42
RECORD = 768 + 8


def sigmoid_cp(cp):
    """cp（轮走方视角）→ 胜率 p = 1/(1+10^(-cp/400))。"""
    return 1.0 / (1.0 + 10.0 ** (-np.asarray(cp, dtype=np.float64) / 400.0))


def cp_from_p(p):
    p = np.clip(np.asarray(p, dtype=np.float64), 1e-7, 1 - 1e-7)
    return -400.0 * np.log10((1.0 - p) / p)


class EvalNet(nn.Module):
    """12 通道 8×8 → 标量 logit（与 policy.rs 同骨架，换标量头）。"""

    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv2d(12, 16, 3, padding=1)
        self.conv2 = nn.Conv2d(16, 16, 3, padding=1)
        self.fc1 = nn.Linear(16 * 8 * 8, 128)
        self.fc2 = nn.Linear(128, 1)

    def forward(self, x):
        x = F.relu(self.conv1(x))
        x = F.relu(self.conv2(x))
        x = x.flatten(1)
        x = F.relu(self.fc1(x))
        return self.fc2(x).squeeze(-1)  # logit


def load_memmap(path, max_samples):
    data = np.memmap(path, dtype=np.uint8, mode="r")
    n_total = int(struct.unpack("<Q", data[8:16].tobytes())[0])
    n = min(n_total, max_samples) if max_samples else n_total
    recs = data[20:20 + n * RECORD].reshape(n, RECORD)
    feat = recs[:, :768].astype(np.float32) / 255.0
    tail = recs[:, 768:776]
    cp = np.frombuffer(tail[:, :4].tobytes(), dtype=np.float32)
    result = np.frombuffer(tail[:, 4:8].tobytes(), dtype=np.float32)
    return feat, cp, result, n_total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scnn", default=DATA)
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=3e-3)
    ap.add_argument("--max-samples", type=int, default=1500000)
    ap.add_argument("--val-frac", type=float, default=0.1)
    args = ap.parse_args()

    random.seed(SEED)
    torch.manual_seed(SEED)
    np.random.seed(SEED)

    feat, cp, result, n_total = load_memmap(args.scnn, args.max_samples)
    n = len(cp)
    labels = sigmoid_cp(cp).astype(np.float32)
    has_result = ~np.isnan(result)
    if has_result.any():
        lam = 0.6
        labels = lam * labels + (1 - lam) * result
    print(f"loaded {n}/{n_total} samples (result-aware={has_result.any()}) "
          f"cp_range=[{cp.min()},{cp.max()}] mean={cp.mean():.1f}", flush=True)

    idx = list(range(n))
    random.shuffle(idx)
    n_val = int(n * args.val_frac)
    tr, va = idx[n_val:], idx[:n_val]

    model = EvalNet()
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    sched = torch.optim.lr_scheduler.StepLR(opt, step_size=10, gamma=0.5)
    batch = args.batch

    for epoch in range(args.epochs):
        model.train()
        random.shuffle(tr)
        tot, loss_sum = 0, 0.0
        for s in range(0, len(tr), batch):
            ids = tr[s:s + batch]
            xb = torch.from_numpy(feat[ids]).view(len(ids), 12, 8, 8)
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
                xb = torch.from_numpy(feat[ids]).view(len(ids), 12, 8, 8)
                yb = torch.from_numpy(labels[ids])
                p = torch.sigmoid(model(xb))
                errs.append((p - yb).pow(2).sum().item())
            val_mse = sum(errs) / len(va)
        print(f"epoch {epoch:2d} train_mse {loss_sum/tot:.6f} val_mse {val_mse:.6f}", flush=True)

    # 验证集 MAE（cp 域）
    model.eval()
    with torch.no_grad():
        preds, golds = [], []
        for s in range(0, len(va), batch * 4):
            ids = va[s:s + batch * 4]
            xb = torch.from_numpy(feat[ids]).view(len(ids), 12, 8, 8)
            p = torch.sigmoid(model(xb))
            preds.append(p.numpy())
            golds.append(labels[ids])
        p_all = np.concatenate(preds)
        g_all = np.concatenate(golds)
        mae_cp = np.abs(cp_from_p(p_all) - cp_from_p(g_all)).mean()
        # 相关性与桶内均值
        r = np.corrcoef(p_all, g_all)[0, 1]
    print(f"val MAE(cp)={mae_cp:.1f} corr={r:.4f}", flush=True)

    os.makedirs(OUT_DIR, exist_ok=True)
    torch.save(model.state_dict(), f"{OUT_DIR}/policy_nnue.pt")
    model.eval()
    dummy = torch.zeros(1, 12, 8, 8)
    torch.onnx.export(model, dummy, f"{OUT_DIR}/policy_nnue.onnx",
                      input_names=["board"], output_names=["winprob_logit"], opset_version=13)
    export_bin(model, f"{OUT_DIR}/nnue.bin")
    nparams = sum(p.numel() for p in model.parameters())
    print(f"saved policy_nnue.pt/.onnx/nnue.bin params={nparams} size~{nparams*4/1e6:.2f}MB")


def export_bin(model, path):
    """拼接 float32 参数（顺序与未来 Rust 推理一一对应）。"""
    magic = b"NNUE"
    params = [p.detach().cpu().numpy().astype(np.float32).reshape(-1) for p in model.parameters()]
    flat = np.concatenate(params)
    with open(path, "wb") as f:
        f.write(magic)
        f.write(struct.pack("<II", 1, len(flat)))
        f.write(flat.tobytes())


if __name__ == "__main__":
    main()
