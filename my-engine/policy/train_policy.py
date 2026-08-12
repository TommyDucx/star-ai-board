#!/usr/bin/env python3
"""阶段2：轻量 Policy 网络训练 —— 输入 8×8×13 棋盘张量，输出 from*64+to 走法概率。
数据：data/final_dataset.jsonl（7,383 条），80/20 切分。训练后导出 ONNX。"""
import json, random, math
import torch
import torch.nn as nn
import torch.nn.functional as F

DATA = "/Users/tommydu/Documents/Default Project/data/final_dataset.jsonl"
OUT_DIR = "/Users/tommydu/Documents/Default Project/star/my-engine/policy"
SEED = 42
random.seed(SEED)
torch.manual_seed(SEED)

PIECE_TO_CH = {"P":0,"N":1,"B":2,"R":3,"Q":4,"K":5,
               "p":6,"n":7,"b":8,"r":9,"q":10,"k":11}

def fen_to_tensor(fen: str):
    """fen -> (13,8,8) tensor。channel: 白PNBRQK 黑pnbrqk + stm(黑=1)。row0=a8。"""
    board_part = fen.split()[0]
    t = torch.zeros(13, 8, 8)
    rows = board_part.split("/")
    for r, row in enumerate(rows):
        rank = 8 - r  # row0 -> rank8
        c = 0
        for ch in row:
            if ch.isdigit():
                c += int(ch)
            else:
                chn = PIECE_TO_CH[ch]
                t[chn][r][c] = 1.0
                c += 1
    if fen.split()[1] == "b":
        t[12].fill_(1.0)
    return t

def uci_to_label(uci: str):
    """bestmove_uci(如 e2e4 / e7e8q) -> from*64+to"""
    f = uci[0:2]; t = uci[2:4]
    fi = (int(f[1])-1)*8 + (ord(f[0])-97)
    ti = (int(t[1])-1)*8 + (ord(t[0])-97)
    return fi*64 + ti

def load():
    rows = [json.loads(l) for l in open(DATA)]
    X, y = [], []
    for r in rows:
        X.append(fen_to_tensor(r["fen"]))
        y.append(uci_to_label(r["bestmove_uci"]))
    return torch.stack(X), torch.tensor(y, dtype=torch.long)

class PolicyNet(nn.Module):
    """轻量 CNN：~33万参数 ≈ 1.3MB float32"""
    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv2d(13, 16, 3, padding=1)
        self.conv2 = nn.Conv2d(16, 16, 3, padding=1)
        self.fc1 = nn.Linear(16*8*8, 64)
        self.fc2 = nn.Linear(64, 64*64)
    def forward(self, x):
        x = F.relu(self.conv1(x))
        x = F.relu(self.conv2(x))
        x = x.flatten(1)
        x = F.relu(self.fc1(x))
        return self.fc2(x)

def main():
    X, y = load()
    n = len(y)
    idx = list(range(n)); random.shuffle(idx)
    split = int(n*0.8)
    tr, va = idx[:split], idx[split:]
    print(f"total={n} train={len(tr)} val={len(va)}")

    model = PolicyNet()
    opt = torch.optim.Adam(model.parameters(), lr=2e-3)
    sched = torch.optim.lr_scheduler.StepLR(opt, step_size=15, gamma=0.3)
    batch = 64
    for epoch in range(40):
        model.train()
        random.shuffle(tr)
        tot, corr = 0, 0
        for s in range(0, len(tr), batch):
            ids = tr[s:s+batch]
            xb, yb = X[ids], y[ids]
            opt.zero_grad()
            logits = model(xb)
            loss = F.cross_entropy(logits, yb)
            loss.backward()
            opt.step()
            corr += (logits.argmax(1) == yb).sum().item()
            tot += len(ids)
        sched.step()
        # 验证 top1 / top5
        model.eval()
        with torch.no_grad():
            acc1 = acc5 = 0
            for s in range(0, len(va), batch):
                ids = va[s:s+batch]
                logits = model(X[ids])
                top1 = logits.argmax(1)
                top5 = logits.topk(5, dim=1).indices
                acc1 += (top1 == y[ids]).sum().item()
                acc5 += (top5 == y[ids].unsqueeze(1)).any(1).sum().item()
            acc1 /= len(va); acc5 /= len(va)
        print(f"epoch {epoch:2d} train_acc {corr/tot:.4f} val_top1 {acc1:.4f} val_top5 {acc5:.4f}", flush=True)

    import os
    os.makedirs(OUT_DIR, exist_ok=True)
    torch.save(model.state_dict(), f"{OUT_DIR}/policy.pt")
    # 导出 ONNX
    model.eval()
    dummy = torch.zeros(1, 13, 8, 8)
    torch.onnx.export(model, dummy, f"{OUT_DIR}/policy.onnx",
                      input_names=["board"], output_names=["policy"],
                      opset_version=13)
    nparams = sum(p.numel() for p in model.parameters())
    print(f"saved policy.pt / policy.onnx, params={nparams} size~{nparams*4/1e6:.2f}MB")

if __name__ == "__main__":
    main()
