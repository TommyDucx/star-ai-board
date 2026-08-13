#!/usr/bin/env python3
"""Golden test: 验证 Rust policy.rs 手写推理 == 训练导出的 PyTorch/ONNX 模型。

读取 policy.bin（与 Rust 完全相同的布局），用纯 Python 复刻 predict() 前向，
对比 policy.onnx 的输出；若一致则证明 Rust 实现无误（无张量布局错位）。

依赖：本目录下的 policy.bin 与 policy.onnx；可选 onnxruntime（pip install onnxruntime）。
用法：python3 policy_golden_test.py
"""
import os
import numpy as np

try:
    import onnxruntime as ort
except ImportError:
    ort = None

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "policy.bin")
ONNX = os.path.join(HERE, "policy.onnx")

PIECE_TO_CH = {"P": 0, "N": 1, "B": 2, "R": 3, "Q": 4, "K": 5,
               "p": 6, "n": 7, "b": 8, "r": 9, "q": 10, "k": 11}


def fen_to_flat(fen: str) -> np.ndarray:
    """复刻 Rust predict()：返回 13*64 的 flat array。
    row0=rank8, col0=fileA；channel 12 = 黑方走棋时置 1。"""
    board_part = fen.split()[0]
    t = np.zeros(13 * 64, dtype=np.float32)
    rows = board_part.split("/")
    for r, row in enumerate(rows):           # r=0 -> rank8
        c = 0
        for ch in row:
            if ch.isdigit():
                c += int(ch)
            else:
                chn = PIECE_TO_CH[ch]
                t[chn * 64 + r * 8 + c] = 1.0
                c += 1
    if fen.split()[1] == "b":
        t[12 * 64:13 * 64] = 1.0
    return t


def load_bin(path: str) -> dict:
    raw = np.fromfile(path, dtype=np.float32)
    off = 0

    def take(n):
        nonlocal off
        v = raw[off:off + n]
        off += n
        return v

    # 保持扁平数组（与 Rust policy.rs 一致）：conv 用 w[(oc*in_ch+ic)*9+(dr+1)*3+(dc+1)] 扁平索引
    c1w = take(16 * 13 * 9)   # (16,13,3,3) 扁平
    c1b = take(16)
    c2w = take(16 * 16 * 9)   # (16,16,3,3) 扁平
    c2b = take(16)
    f1w = take(64 * 1024)     # (64,1024) 扁平
    f1b = take(64)
    f2w = take(4096 * 64)     # (4096,64) 扁平
    f2b = take(4096)
    assert off == raw.size, f"policy.bin 字节数不匹配: {off} vs {raw.size}"
    return dict(c1w=c1w, c1b=c1b, c2w=c2w, c2b=c2b,
                f1w=f1w, f1b=f1b, f2w=f2w, f2b=f2b)


def conv3x3(w: np.ndarray, b: np.ndarray, x: np.ndarray, in_ch: int, out_ch: int) -> np.ndarray:
    """复刻 Rust conv3x3（零填充等价）。w 形状 (out_ch,in_ch,3,3)，x flat (in_ch*64)。"""
    out = np.zeros(out_ch * 64, dtype=np.float32)
    for oc in range(out_ch):
        for r in range(8):
            for c in range(8):
                acc = b[oc]
                for ic in range(in_ch):
                    for dr in (-1, 0, 1):
                        for dc in (-1, 0, 1):
                            rr, cc = r + dr, c + dc
                            if 0 <= rr < 8 and 0 <= cc < 8:
                                wi = (oc * in_ch + ic) * 9 + (dr + 1) * 3 + (dc + 1)
                                xi = ic * 64 + rr * 8 + cc
                                acc += w[wi] * x[xi]
                out[oc * 64 + r * 8 + c] = acc
    return out


def relu(v: np.ndarray) -> np.ndarray:
    return np.maximum(v, 0.0)


def rust_forward(P: dict, t: np.ndarray) -> np.ndarray:
    h = relu(conv3x3(P["c1w"], P["c1b"], t, 13, 16))
    h = relu(conv3x3(P["c2w"], P["c2b"], h, 16, 16))
    fc1 = relu(P["f1b"] + P["f1w"].reshape(64, 1024) @ h)       # (64,)
    logits = P["f2b"] + P["f2w"].reshape(4096, 64) @ fc1        # (4096,)
    return logits


def main():
    assert os.path.isfile(BIN), f"缺少 {BIN}"
    P = load_bin(BIN)

    tests = [
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
        "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
        "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 5",
        "rnbq1rk1/pppp1ppp/5n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 w - - 0 6",
    ]

    onnx_forward = None
    if ort is not None and os.path.isfile(ONNX):
        sess = ort.InferenceSession(ONNX, providers=["CPUExecutionProvider"])
        cache = {}

        def onnx_forward(fen):
            if fen not in cache:
                t = fen_to_flat(fen).reshape(1, 13, 8, 8).astype(np.float32)
                cache[fen] = sess.run(["policy"], {"board": t})[0][0]
            return cache[fen]
    elif os.path.isfile(ONNX):
        print("⚠️  已检测到 policy.onnx，但未安装 onnxruntime（pip install onnxruntime 后重跑可做对比）")

    print(f"{'FEN':52s} {'rust_top1':9s} {'onnx_top1':10s} {'max|Δlogit|':13s}  OK")
    print("-" * 92)
    all_ok = True
    for fen in tests:
        t = fen_to_flat(fen)
        rust = rust_forward(P, t)
        rtop = int(np.argmax(rust))
        if onnx_forward is not None:
            o = onnx_forward(fen)
            otop = int(np.argmax(o))
            md = float(np.max(np.abs(rust - o)))
            ok = md < 1e-2
            all_ok = all_ok and ok
            print(f"{fen[:52]:52s} {rtop:9d} {otop:10d} {md:13.5f}  {'OK' if ok else 'DIFF!'}")
        else:
            print(f"{fen[:52]:52s} {rtop:9d} {'-':>10s} {'-':>13s}  (no onnx)")

    if onnx_forward is not None:
        print("-" * 92)
        print("RESULT:", "Rust 手写推理 与 ONNX 完全一致 → policy.rs 实现正确" if all_ok
              else "存在偏差，请检查 conv/权重读取顺序")


if __name__ == "__main__":
    main()
