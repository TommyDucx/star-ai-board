#!/usr/bin/env python3
"""BiaoZi MCTS 训练器 —— AzNet（ResNet 4×96 双头：策略 4096 + 价值 tanh）。

输入: 自博弈样本 JSONL(.gz) 每行 {"p":hex17平面,"pi":[[idx,cnt]..],"z":-1|0|1}
损失: CE(policy 软目标) + MSE(value tanh) + AdamW wd=1e-4
输出: state_dict .pt（infer_server / 门禁赛直接 torch.load）

用法:
  python3 train_mcts.py --samples s1.jsonl.gz s2.jsonl.gz --steps 4000 --out.pt run/nets/net.pt
  python3 train_mcts.py --init-out run/nets/net_init.pt   # 导出随机初始化网（冒烟用）
"""
import argparse
import gzip
import json
import os
import random
import sys

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

MAX_LEGAL = 64


class ResBlock(nn.Module):
    def __init__(self, ch):
        super().__init__()
        self.c1 = nn.Conv2d(ch, ch, 3, padding=1)
        self.b1 = nn.BatchNorm2d(ch)
        self.c2 = nn.Conv2d(ch, ch, 3, padding=1)
        self.b2 = nn.BatchNorm2d(ch)

    def forward(self, x):
        y = F.relu(self.b1(self.c1(x)))
        y = self.b2(self.c2(y))
        return F.relu(x + y)


class AzNet(nn.Module):
    """输入 (B,17,8,8) float；输出 (policy_logits (B,4096), value (B,))"""

    def __init__(self, ch=96, blocks=4):
        super().__init__()
        self.stem = nn.Sequential(
            nn.Conv2d(17, ch, 3, padding=1), nn.BatchNorm2d(ch), nn.ReLU())
        self.blocks = nn.Sequential(*[ResBlock(ch) for _ in range(blocks)])
        self.pconv = nn.Conv2d(ch, 32, 3, padding=1)
        self.pb = nn.BatchNorm2d(32)
        self.pfc = nn.Linear(32 * 64, 256)
        self.pout = nn.Linear(256, 4096)
        self.vconv = nn.Conv2d(ch, 32, 3, padding=1)
        self.vb = nn.BatchNorm2d(32)
        self.vfc = nn.Linear(32 * 64, 64)
        self.vout = nn.Linear(64, 1)

    def forward(self, x):
        x = self.stem(x)
        x = self.blocks(x)
        p = F.relu(self.pb(self.pconv(x))).flatten(1)
        pol = self.pout(F.relu(self.pfc(p)))
        v = F.relu(self.vb(self.vconv(x))).flatten(1)
        v = torch.tanh(self.vout(F.relu(self.vfc(v))))
        return pol.squeeze(-1), v.squeeze(-1)


def load_samples(paths, max_samples):
    planes, pi_idx, pi_cnt, zs = [], [], [], []
    n = 0
    for path in paths:
        op = gzip.open if path.endswith(".gz") else open
        with op(path, "rt", encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                raw = bytes.fromhex(r["p"])
                planes.append(np.frombuffer(raw, dtype=np.uint8))
                idx = np.zeros(MAX_LEGAL, dtype=np.int64)
                cnt = np.zeros(MAX_LEGAL, dtype=np.float32)
                tot = sum(c for _, c in r["pi"]) or 1
                for j, (mi, c) in enumerate(r["pi"][:MAX_LEGAL]):
                    idx[j] = mi
                    cnt[j] = c / tot
                pi_idx.append(idx)
                pi_cnt.append(cnt)
                zs.append(float(r["z"]))
                n += 1
                if max_samples and n >= max_samples:
                    break
    planes = np.stack(planes)  # (N,1088) uint8
    print(f"loaded {n} samples", flush=True)
    return (torch.from_numpy(np.stack(pi_idx)), torch.from_numpy(np.stack(pi_cnt)),
            torch.from_numpy(np.array(zs, dtype=np.float32)),
            torch.from_numpy(planes), n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", nargs="*", default=[])
    ap.add_argument("--steps", type=int, default=4000)
    ap.add_argument("--batch", type=int, default=256)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.02)
    ap.add_argument("--max-samples", type=int, default=600000)
    ap.add_argument("--init-out", default="", help="导出随机初始化网后退出")
    ap.add_argument("out", nargs="?", default="run/nets/net.pt")
    args = ap.parse_args()

    torch.manual_seed(42)
    np.random.seed(42)
    net = AzNet()
    nparams = sum(p.numel() for p in net.parameters())
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)

    if args.init_out:
        torch.save(net.state_dict(), args.init_out)
        print(f"saved init net -> {args.init_out} params={nparams}")
        return

    pi_idx, pi_cnt, z, planes_u8, n = load_samples(args.samples, args.max_samples)
    # 归一化检查（load 时已按 tot 归一）
    ii = list(range(n))
    rng = random.Random(42)
    rng.shuffle(ii)
    n_val = max(64, int(n * args.val_frac))
    va, tr = ii[:n_val], ii[n_val:]
    print(f"arch params={nparams} train={len(tr)} val={len(va)}", flush=True)

    opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.steps)

    def batch(ids):
        B = len(ids)
        ti = torch.tensor(ids)
        x = planes_u8[ti].view(B, 17, 8, 8).float() / 255.0
        idx = pi_idx[ti]                       # (B,M)
        cnt = pi_cnt[ti]                       # (B,M)，padding 处为 0
        tgt = torch.zeros(B, 4096)
        bidx = torch.arange(B).repeat_interleave(idx.shape[1])
        flat_i = idx.reshape(-1)
        flat_c = cnt.reshape(-1)
        ok = flat_c > 0
        tgt.index_put_((bidx[ok], flat_i[ok]), flat_c[ok])
        zz = z[ti]
        return x, tgt, zz

    net.train()
    best_val = float("inf")
    best_state = None
    log_every = max(1, args.steps // 20)
    for step in range(args.steps):
        ids = [tr[rng.randrange(len(tr))] for _ in range(args.batch)]
        x, tgt, zz = batch(ids)
        opt.zero_grad()
        pol, val = net(x)
        logp = F.log_softmax(pol, dim=-1)
        pol_loss = -(tgt * logp).sum(1).mean()
        val_loss = F.mse_loss(val, zz)
        loss = pol_loss + val_loss
        loss.backward()
        opt.step()
        sched.step()
        if (step + 1) % log_every == 0:
            print(f"step {step+1}/{args.steps} pol {pol_loss.item():.4f} "
                  f"val {val_loss.item():.4f}", flush=True)
        # 周期性验证
        if (step + 1) % max(1, args.steps // 4) == 0 or step + 1 == args.steps:
            net.eval()
            with torch.no_grad():
                vl, vp, vz = [], [], []
                for s in range(0, len(va), 512):
                    ids = va[s:s + 512]
                    x, tgt, zz = batch(ids)
                    pol, val = net(x)
                    logp = F.log_softmax(pol, dim=-1)
                    vl.append(-(tgt * logp).sum(1).mean().item())
                    vp.append(val.detach().numpy())
                    vz.append(zz.numpy())
                import numpy as np2
                pv = np2.concatenate(vp); gz = np2.concatenate(vz)
                corr = float(np2.corrcoef(pv, gz)[0, 1]) if len(pv) > 2 else 0.0
                vm = sum(vl) / len(vl)
                print(f"  eval@{step+1}: val_pol_ce {vm:.4f} value_corr {corr:.3f}", flush=True)
                if vm < best_val:
                    best_val = vm
                    best_state = {k: t.clone() for k, t in net.state_dict().items()}
            net.train()
    if best_state is not None:
        net.load_state_dict(best_state)
    torch.save(net.state_dict(), args.out)
    print(f"saved {args.out} (best val_pol_ce {best_val:.4f})", flush=True)


if __name__ == "__main__":
    main()
