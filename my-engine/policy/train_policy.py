#!/usr/bin/env python3
"""阶段2(增强): 轻量 Policy 网络训练 —— 输入 8×8×13 棋盘张量，输出 from*64+to 走法概率。
数据: 默认 data/final_dataset.jsonl；可用 --data 指定 Stockfish 教师标签集。
增强: 8× D4 对称增广(旋转/镜像) + 合法着法过滤，标签同步变换。
训练后导出 ONNX + policy.bin(Rust 手写推理读取)。"""
import json, random, math, argparse, os
import torch
import torch.nn as nn
import torch.nn.functional as F
import chess

DATA = os.environ.get("RL_DATA", "/Users/tommydu/Documents/Star Chess/data/final_dataset.jsonl")
OUT_DIR = os.environ.get("RL_OUTDIR", "/Users/tommydu/Documents/Star Chess/my-engine/policy")
SEED = 42
random.seed(SEED)
torch.manual_seed(SEED)

PIECE_TO_CH = {"P":0,"N":1,"B":2,"R":3,"Q":4,"K":5,
               "p":6,"n":7,"b":8,"r":9,"q":10,"k":11}

# ── 8× D4 对称变换（在 (rank_idx, file_idx) 上，rank_idx 0=rank1, file_idx 0=fileA）──
def _make_transforms():
    return [
        lambda ri, fi: (ri, fi),                 # identity
        lambda ri, fi: (7 - fi, ri),             # rot90 CW
        lambda ri, fi: (7 - ri, 7 - fi),         # rot180
        lambda ri, fi: (fi, 7 - ri),             # rot270 CW
        lambda ri, fi: (ri, 7 - fi),             # flip H
        lambda ri, fi: (7 - ri, fi),             # flip V
        lambda ri, fi: (fi, ri),                 # flip main diag
        lambda ri, fi: (7 - fi, 7 - ri),         # flip anti diag
    ]
TRANSFORMS = _make_transforms()

def _tsq(sq, fn):
    """将 chess.Square 经变换 fn 映射到新 Square。"""
    ri, fi = sq // 8, sq % 8
    ri2, fi2 = fn(ri, fi)
    return chess.square(fi2, ri2)  # chess.square(file, rank)

def fen_to_tensor(fen: str):
    """fen -> (13,8,8) tensor。channel: 白PNBRQK 黑pnbrqk + stm(黑=1)。row0=a8。"""
    board_part = fen.split()[0]
    t = torch.zeros(13, 8, 8)
    rows = board_part.split("/")
    for r, row in enumerate(rows):
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
    fi = (int(f[1]) - 1) * 8 + (ord(f[0]) - 97)
    ti = (int(t[1]) - 1) * 8 + (ord(t[0]) - 97)
    return fi * 64 + ti

def augment(fen: str, uci: str):
    """返回一个列表: [(fen', uci'), ...]，含原始与所有合法的对称变换。"""
    out = []
    board = chess.Board(fen)
    if board.is_game_over():
        return out
    try:
        move = chess.Move.from_uci(uci)
    except Exception:
        return out
    for k, fn in enumerate(TRANSFORMS):
        nb = chess.Board(None)
        # 拷贝棋子（按变换映射）
        for sq, pc in board.piece_map().items():
            nb.set_piece_at(_tsq(sq, fn), pc)
        nb.turn = board.turn
        # 对称性要求: 仅恒等变换保留王车易位/吃过路兵; 其余清零(避免非法标签)
        if k == 0:
            nb.castling_rights = board.castling_rights
            nb.ep_square = board.ep_square
        # 变换着法
        nf = _tsq(move.from_square, fn)
        nt = _tsq(move.to_square, fn)
        nm = chess.Move(nf, nt, move.promotion)
        if nm in nb.legal_moves:
            out.append((nb.fen(), nm.uci()))
    return out

def load(data_path):
    rows = [json.loads(l) for l in open(data_path)]
    X, y = [], []
    for r in rows:
        fen = r["fen"]
        uci = r["bestmove_uci"]
        variants = augment(fen, uci)
        for vf, vu in variants:
            X.append(fen_to_tensor(vf))
            y.append(uci_to_label(vu))
    if not X:
        raise RuntimeError("空数据集")
    return torch.stack(X), torch.tensor(y, dtype=torch.long)

class PolicyNet(nn.Module):
    """轻量 CNN：~33万参数 ≈ 1.3MB float32（与 Rust policy.rs 完全对应）"""
    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv2d(13, 16, 3, padding=1)
        self.conv2 = nn.Conv2d(16, 16, 3, padding=1)
        self.fc1 = nn.Linear(16 * 8 * 8, 64)
        self.fc2 = nn.Linear(64, 64 * 64)
    def forward(self, x):
        x = F.relu(self.conv1(x))
        x = F.relu(self.conv2(x))
        x = x.flatten(1)
        x = F.relu(self.fc1(x))
        return self.fc2(x)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=2e-3)
    args = ap.parse_args()

    X, y = load(args.data)
    n = len(y)
    idx = list(range(n)); random.shuffle(idx)
    split = int(n * 0.8)
    tr, va = idx[:split], idx[split:]
    print(f"data={args.data}\ntotal={n} train={len(tr)} val={len(va)} (含8×增广)", flush=True)

    model = PolicyNet()
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    sched = torch.optim.lr_scheduler.StepLR(opt, step_size=15, gamma=0.3)
    batch = args.batch
    for epoch in range(args.epochs):
        model.train()
        random.shuffle(tr)
        tot, corr = 0, 0
        for s in range(0, len(tr), batch):
            ids = tr[s:s + batch]
            xb, yb = X[ids], y[ids]
            opt.zero_grad()
            logits = model(xb)
            loss = F.cross_entropy(logits, yb)
            loss.backward()
            opt.step()
            corr += (logits.argmax(1) == yb).sum().item()
            tot += len(ids)
        sched.step()
        model.eval()
        with torch.no_grad():
            acc1 = acc5 = 0
            for s in range(0, len(va), batch):
                ids = va[s:s + batch]
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
    model.eval()
    dummy = torch.zeros(1, 13, 8, 8)
    torch.onnx.export(model, dummy, f"{OUT_DIR}/policy.onnx",
                     input_names=["board"], output_names=["policy"], opset_version=13)
    nparams = sum(p.numel() for p in model.parameters())
    print(f"saved policy.pt / policy.onnx, params={nparams} size~{nparams*4/1e6:.2f}MB")

if __name__ == "__main__":
    main()
