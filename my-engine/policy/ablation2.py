#!/usr/bin/env python3
"""消融实验2：残差网络(残差块+FC96) + 旧数据(不过滤不加权)。

目的：验证残差 CNN 在「旧数据」上的独立贡献。
- 网络用第三批的残差 PolicyNet（残差块 + FC96）；
- 数据用 v2 的原始 load（不过滤不加权）；
- lr 用 v2 的 2e-3（排除 lr 干扰）。
结论判据：val_top1 若 > 46%（v2 无残差+旧数据）→ 残差有益，最终方案 = 残差+旧数据。
"""
import json, random, argparse
import torch
import torch.nn as nn
import torch.nn.functional as F

from train_policy import fen_to_tensor, uci_to_label, augment

DATA = "/Users/tommydu/Documents/Star Chess/data/final_dataset.jsonl"
SEED = 42
random.seed(SEED)
torch.manual_seed(SEED)


class ResBlock(nn.Module):
    def __init__(self, ch):
        super().__init__()
        self.conv = nn.Conv2d(ch, ch, 3, padding=1)

    def forward(self, x):
        return F.relu(self.conv(x) + x)


class PolicyNetResidual(nn.Module):
    """残差轻量 CNN（第三批设计）：残差块 + FC1 96。"""
    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv2d(13, 16, 3, padding=1)
        self.res = ResBlock(16)
        self.conv2 = nn.Conv2d(16, 16, 3, padding=1)
        self.fc1 = nn.Linear(16 * 8 * 8, 96)
        self.fc2 = nn.Linear(96, 64 * 64)

    def forward(self, x):
        x = F.relu(self.conv1(x))
        x = self.res(x)
        x = F.relu(self.conv2(x))
        x = x.flatten(1)
        x = F.relu(self.fc1(x))
        return self.fc2(x)


def load(data_path):
    """v2 原始 load：不过滤、不加权，仅 8× 增广。"""
    rows = [json.loads(l) for l in open(data_path)]
    X, y = [], []
    for r in rows:
        fen = r["fen"]
        uci = r["bestmove_uci"]
        for vf, vu in augment(fen, uci):
            X.append(fen_to_tensor(vf))
            y.append(uci_to_label(vu))
    if not X:
        raise RuntimeError("空数据集")
    return torch.stack(X), torch.tensor(y, dtype=torch.long)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=40)
    args = ap.parse_args()
    X, y = load(DATA)
    n = len(y)
    idx = list(range(n)); random.shuffle(idx)
    split = int(n * 0.8); tr, va = idx[:split], idx[split:]
    print(f"total={n} train={len(tr)} val={len(va)}", flush=True)
    model = PolicyNetResidual()
    opt = torch.optim.Adam(model.parameters(), lr=2e-3)  # v2 的 lr，排除 lr 干扰
    batch = 64
    for epoch in range(args.epochs):
        model.train(); random.shuffle(tr)
        for s in range(0, len(tr), batch):
            ids = tr[s:s + batch]; xb, yb = X[ids], y[ids]
            opt.zero_grad()
            loss = F.cross_entropy(model(xb), yb)
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
