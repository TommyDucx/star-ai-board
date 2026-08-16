#!/usr/bin/env python3
"""Texel tuning —— 评估侧：参数化 eval（精确复刻 eval.rs）+ 线性特征提取。

关键事实：eval.rs 的 evaluate 是「参数 × 特征计数」的线性函数（给定局面，phase 是
固定的数据特征，不依赖参数）。因此 Texel tuning 本质是 logistic 回归：
    eval(board) = Σ_i w_i · x_i(board)
    loss = (result − sigmoid(K·eval/400))²
只需提取每个局面的线性特征向量 x，再用数据拟合 w。

本文件只做两件事：
  1. evaluate(board) —— 复刻 eval.rs（白方视角，正=白优），供 golden test 校验一致性；
  2. extract_features(board) —— 提取 25 维「标量参数」的线性特征（PST 表不在第一批调参范围）。

用法：
  python3 texel_eval.py --golden fen1 fen2 ...   # 打印每个 FEN 的 eval_stm（供与 Rust 对比）
"""
import argparse
import chess
import numpy as np

# ── 当前参数（= eval.rs 常量），golden test 用 ──────────────────────────────
PIECE_VALUES = [100, 320, 330, 500, 900, 20000]  # 兵 马 象 车 后 王
PHASE_MAX = 24
PASSED_BONUS = [0, 5, 10, 20, 35, 60, 140, 0]
DOUBLED = -15
ISOLATED = -20
BISHOP_PAIR = 30
ROOK_OPEN = 20
ROOK_HALF = 10
ROOK_STACK = 30
SHIELD = [12, 8]                 # 王前第 1 格 / 第 2 格
KATTACK = {5: 6, 4: 4, 2: 3, 3: 2, 1: 1, 6: 0}  # piece_type -> 贴近王城权重
PAWN_STORM = 3

# 位置表：行 0 = rank8（黑方底线），行 7 = rank1（白方底线），白方视角。
# 与 eval.rs 的 PST 完全一致（视觉顺序书写）。
PST = [
    # 兵
    [0, 0, 0, 0, 0, 0, 0, 0,
     50, 50, 50, 50, 50, 50, 50, 50,
     10, 10, 20, 30, 30, 20, 10, 10,
     5, 5, 10, 25, 25, 10, 5, 5,
     0, 0, 0, 20, 20, 0, 0, 0,
     5, -5, -10, 0, 0, -10, -5, 5,
     5, 10, 10, -20, -20, 10, 10, 5,
     0, 0, 0, 0, 0, 0, 0, 0],
    # 马
    [-50, -40, -30, -30, -30, -30, -40, -50,
     -40, -20, 0, 0, 0, 0, -20, -40,
     -30, 0, 10, 15, 15, 10, 0, -30,
     -30, 5, 15, 20, 20, 15, 5, -30,
     -30, 0, 15, 20, 20, 15, 0, -30,
     -30, 5, 10, 15, 15, 10, 5, -30,
     -40, -20, 0, 5, 5, 0, -20, -40,
     -50, -40, -30, -30, -30, -30, -40, -50],
    # 象
    [-20, -10, -10, -10, -10, -10, -10, -20,
     -10, 0, 0, 0, 0, 0, 0, -10,
     -10, 0, 5, 10, 10, 5, 0, -10,
     -10, 5, 5, 10, 10, 5, 5, -10,
     -10, 0, 10, 10, 10, 10, 0, -10,
     -10, 10, 10, 10, 10, 10, 10, -10,
     -10, 5, 0, 0, 0, 0, 5, -10,
     -20, -10, -10, -10, -10, -10, -10, -20],
    # 车
    [0, 0, 0, 0, 0, 0, 0, 0,
     5, 10, 10, 10, 10, 10, 10, 5,
     -5, 0, 0, 0, 0, 0, 0, -5,
     -5, 0, 0, 0, 0, 0, 0, -5,
     -5, 0, 0, 0, 0, 0, 0, -5,
     -5, 0, 0, 0, 0, 0, 0, -5,
     -5, 0, 0, 0, 0, 0, 0, -5,
     0, 0, 0, 5, 5, 0, 0, 0],
    # 后
    [-20, -10, -10, -5, -5, -10, -10, -20,
     -10, 0, 0, 0, 0, 0, 0, -10,
     -10, 0, 5, 5, 5, 5, 0, -10,
     -5, 0, 5, 5, 5, 5, 0, -5,
     0, 0, 5, 5, 5, 5, 0, -5,
     -10, 5, 5, 5, 5, 5, 0, -10,
     -10, 0, 5, 0, 0, 0, 0, -10,
     -20, -10, -10, -5, -5, -10, -10, -20],
    # 王
    [-30, -40, -40, -50, -50, -40, -40, -30,
     -30, -40, -40, -50, -50, -40, -40, -30,
     -30, -40, -40, -50, -50, -40, -40, -30,
     -30, -40, -40, -50, -50, -40, -40, -30,
     -20, -30, -30, -40, -40, -30, -30, -20,
     -10, -20, -20, -20, -20, -20, -20, -10,
     20, 20, 0, 0, 0, 0, 20, 20,
     20, 30, 10, 0, 0, 10, 30, 20],
]

PST_KING_EG = [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50,
]


def _piece_idx(pt: int) -> int:
    return pt - 1  # chess: 1=pawn..6=king


def _pst_val(pt: int, sq: int, color: bool) -> int:
    idx = sq
    widx = 63 - idx if color == chess.WHITE else idx
    return PST[_piece_idx(pt)][widx]


def _phase(board: chess.Board) -> int:
    phase = 0
    for sq in chess.SQUARES:
        p = board.piece_at(sq)
        if p is None:
            continue
        if p.piece_type in (chess.KNIGHT, chess.BISHOP):
            phase += 1
        elif p.piece_type == chess.ROOK:
            phase += 2
        elif p.piece_type == chess.QUEEN:
            phase += 4
    return min(phase, PHASE_MAX)


def _king_shield_count(board: chess.Board, color: bool) -> tuple:
    """返回 (王前第1格有兵数, 王前第2格有兵数)，白方向上=rank增。"""
    king = board.king(color)
    kf = chess.square_file(king)
    kr = chess.square_rank(king)
    c1 = c2 = 0
    for df in (-1, 0, 1):
        for step in (1, 2):
            rf = kr + step if color == chess.WHITE else kr - step
            nf = kf + df
            if not (0 <= rf <= 7 and 0 <= nf <= 7):
                continue
            p = board.piece_at(chess.square(nf, rf))
            if p is not None and p.piece_type == chess.PAWN and p.color == color:
                if step == 1:
                    c1 += 1
                else:
                    c2 += 1
    return c1, c2


def evaluate(board: chess.Board) -> int:
    """复刻 eval.rs evaluate：白方视角，正=白优。"""
    score = 0
    phase = 0
    pawn_mask = [[0] * 8, [0] * 8]
    bishops = [0, 0]
    rook_files = [[0] * 8, [0] * 8]
    king_sq = [None, None]
    kattack = [0, 0]
    wk = board.king(chess.WHITE)
    bk = board.king(chess.BLACK)

    for sq in chess.SQUARES:
        p = board.piece_at(sq)
        if p is None:
            continue
        color = p.color
        ci = 0 if color == chess.WHITE else 1
        f = chess.square_file(sq)
        r = chess.square_rank(sq)
        pt = p.piece_type

        if pt in (chess.KNIGHT, chess.BISHOP):
            phase += 1
        elif pt == chess.ROOK:
            phase += 2
        elif pt == chess.QUEEN:
            phase += 4

        if pt == chess.PAWN:
            pawn_mask[ci][f] |= 1 << r
        elif pt == chess.BISHOP:
            bishops[ci] += 1
        elif pt == chess.ROOK:
            rook_files[ci][f] += 1
        elif pt == chess.KING:
            king_sq[ci] = sq

        if pt != chess.KING:
            ok = bk if color == chess.WHITE else wk
            kf = chess.square_file(ok)
            kr = chess.square_rank(ok)
            if abs(f - kf) <= 2 and abs(r - kr) <= 2:
                kattack[ci] += KATTACK.get(pt, 0)
            if pt == chess.PAWN:
                adv = r if color == chess.WHITE else 7 - r
                if abs(f - kf) <= 1 and adv >= 4:
                    kattack[ci] += PAWN_STORM

        v = PIECE_VALUES[_piece_idx(pt)]
        if pt != chess.KING:
            v += _pst_val(pt, sq, color)
        if color == chess.BLACK:
            v = -v
        score += v

    phase = min(phase, PHASE_MAX)

    for ci in range(2):
        color = chess.WHITE if ci == 0 else chess.BLACK
        idx = king_sq[ci]
        widx = 63 - idx if color == chess.WHITE else idx
        mg = PST[5][widx]
        eg = PST_KING_EG[widx]
        v = int((mg * phase + eg * (PHASE_MAX - phase)) / PHASE_MAX)
        c1, c2 = _king_shield_count(board, color)
        v += (c1 * SHIELD[0] + c2 * SHIELD[1]) * phase // PHASE_MAX
        v += kattack[ci] * phase // PHASE_MAX
        if color == chess.BLACK:
            v = -v
        score += v

    for ci in range(2):
        color = chess.WHITE if ci == 0 else chess.BLACK
        opp = 1 - ci
        s = 0
        for f in range(8):
            m = pawn_mask[ci][f]
            if m == 0:
                continue
            n = bin(m).count("1")
            if n > 1:
                s += DOUBLED * (n - 1)
            left = pawn_mask[ci][f - 1] if f > 0 else 0
            right = pawn_mask[ci][f + 1] if f < 7 else 0
            if left == 0 and right == 0:
                s += ISOLATED
            for r in range(8):
                if not (m & (1 << r)):
                    continue
                if color == chess.WHITE:
                    ahead = 0 if r >= 7 else (0xFF << (r + 1)) & 0xFF
                else:
                    ahead = 0 if r == 0 else (1 << r) - 1
                enemy = pawn_mask[opp][f] \
                    | (pawn_mask[opp][f - 1] if f > 0 else 0) \
                    | (pawn_mask[opp][f + 1] if f < 7 else 0)
                if enemy & ahead == 0:
                    adv = r if color == chess.WHITE else 7 - r
                    s += PASSED_BONUS[adv]
        if bishops[ci] >= 2:
            s += BISHOP_PAIR
        for f in range(8):
            rc = rook_files[ci][f]
            if rc == 0:
                continue
            own = pawn_mask[ci][f]
            their = pawn_mask[opp][f]
            if own == 0 and their == 0:
                bonus = ROOK_OPEN
            elif own == 0:
                bonus = ROOK_HALF
            else:
                bonus = 0
            stacked = ROOK_STACK if (rc >= 2 and own == 0) else 0
            s += bonus * rc + stacked
        if color == chess.BLACK:
            s = -s
        score += s

    return score


def eval_stm(board: chess.Board) -> int:
    s = evaluate(board)
    return s if board.turn == chess.WHITE else -s


# ── 25 维线性特征（标量参数）───────────────────────────────────────────────
FEATURE_NAMES = [
    "pawn", "knight", "bishop", "rook", "queen",       # 0-4 子力值
    "doubled", "isolated", "bishop_pair",               # 5-7
    "rook_open", "rook_half", "rook_stack",             # 8-10
    "passed_1", "passed_2", "passed_3", "passed_4", "passed_5", "passed_6",  # 11-16
    "shield_1", "shield_2",                             # 17-18
    "katt_queen", "katt_rook", "katt_knight", "katt_bishop", "katt_pawn",  # 19-23
    "pawn_storm",                                       # 24
]


def extract_features(board: chess.Board) -> np.ndarray:
    """提取 25 维标量参数特征（白方视角，白-黑差）。PST 贡献不在此列（第一批不调）。"""
    phase = _phase(board)
    pawn_mask = [[0] * 8, [0] * 8]
    bishops = [0, 0]
    rook_files = [[0] * 8, [0] * 8]
    kattack = [[0] * 6, [0] * 6]  # [color][piece_type] 贴近对方王城的计数
    storm = [0, 0]
    wk = board.king(chess.WHITE)
    bk = board.king(chess.BLACK)

    for sq in chess.SQUARES:
        p = board.piece_at(sq)
        if p is None:
            continue
        color = p.color
        ci = 0 if color == chess.WHITE else 1
        f = chess.square_file(sq)
        r = chess.square_rank(sq)
        pt = p.piece_type
        if pt == chess.PAWN:
            pawn_mask[ci][f] |= 1 << r
        elif pt == chess.BISHOP:
            bishops[ci] += 1
        elif pt == chess.ROOK:
            rook_files[ci][f] += 1
        if pt != chess.KING:
            ok = bk if color == chess.WHITE else wk
            kf = chess.square_file(ok)
            kr = chess.square_rank(ok)
            if abs(f - kf) <= 2 and abs(r - kr) <= 2:
                kattack[ci][pt] += 1
            if pt == chess.PAWN:
                adv = r if color == chess.WHITE else 7 - r
                if abs(f - kf) <= 1 and adv >= 4:
                    storm[ci] += 1

    def diff(a, b):
        return a - b

    f = np.zeros(len(FEATURE_NAMES), dtype=np.float32)

    # 子力值
    for pt in range(1, 6):
        w = sum(1 for sq in chess.SQUARES
                if (p := board.piece_at(sq)) is not None and p.piece_type == pt and p.color == chess.WHITE)
        b = sum(1 for sq in chess.SQUARES
                if (p := board.piece_at(sq)) is not None and p.piece_type == pt and p.color == chess.BLACK)
        f[pt - 1] = w - b

    # 兵形（叠兵/孤兵）+ 通路兵
    doubled = [0, 0]
    isolated = [0, 0]
    passed = [[0] * 8, [0] * 8]
    for ci in range(2):
        opp = 1 - ci
        for ff in range(8):
            m = pawn_mask[ci][ff]
            if m == 0:
                continue
            n = bin(m).count("1")
            if n > 1:
                doubled[ci] += n - 1
            left = pawn_mask[ci][ff - 1] if ff > 0 else 0
            right = pawn_mask[ci][ff + 1] if ff < 7 else 0
            if left == 0 and right == 0:
                isolated[ci] += 1
            for r in range(8):
                if not (m & (1 << r)):
                    continue
                if ci == 0:  # 白
                    ahead = 0 if r >= 7 else (0xFF << (r + 1)) & 0xFF
                else:
                    ahead = 0 if r == 0 else (1 << r) - 1
                enemy = pawn_mask[opp][ff] \
                    | (pawn_mask[opp][ff - 1] if ff > 0 else 0) \
                    | (pawn_mask[opp][ff + 1] if ff < 7 else 0)
                if enemy & ahead == 0:
                    adv = r if ci == 0 else 7 - r
                    passed[ci][adv] += 1

    f[5] = doubled[0] - doubled[1]
    f[6] = isolated[0] - isolated[1]
    f[7] = (1 if bishops[0] >= 2 else 0) - (1 if bishops[1] >= 2 else 0)

    # 车线
    ro = [0, 0]; rh = [0, 0]; rs = [0, 0]
    for ci in range(2):
        opp = 1 - ci
        for ff in range(8):
            rc = rook_files[ci][ff]
            if rc == 0:
                continue
            own = pawn_mask[ci][ff]
            their = pawn_mask[opp][ff]
            if own == 0 and their == 0:
                ro[ci] += rc
            elif own == 0:
                rh[ci] += rc
            if rc >= 2 and own == 0:
                rs[ci] += 1
    f[8] = ro[0] - ro[1]
    f[9] = rh[0] - rh[1]
    f[10] = rs[0] - rs[1]

    # 通路兵（推进 1-6 行，PASSED_BONUS[1..7]）
    for adv in range(1, 7):
        f[10 + adv] = passed[0][adv] - passed[1][adv]

    # 王盾
    sh = [[0, 0], [0, 0]]
    for ci in range(2):
        c1, c2 = _king_shield_count(board, chess.WHITE if ci == 0 else chess.BLACK)
        sh[ci] = [c1, c2]
    f[17] = (sh[0][0] - sh[1][0]) * phase / PHASE_MAX
    f[18] = (sh[0][1] - sh[1][1]) * phase / PHASE_MAX

    # 王翼进攻（贴近 + 兵冲锋），乘 phase 缩放
    for pt in (5, 4, 2, 3, 1):  # 后 车 马 象 兵
        idx = 19 + {5: 0, 4: 1, 2: 2, 3: 3, 1: 4}[pt]
        f[idx] = (kattack[0][pt] - kattack[1][pt]) * phase / PHASE_MAX
    f[24] = (storm[0] - storm[1]) * phase / PHASE_MAX

    return f


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--golden", nargs="*", help="FEN 列表，输出 eval_stm（供与 Rust 对比）")
    args = ap.parse_args()
    if args.golden:
        for fen in args.golden:
            b = chess.Board(fen)
            print(f"{fen}\t{eval_stm(b)}")
    else:
        b = chess.Board()
        print("startpos eval_stm =", eval_stm(b))
        print("feature dim =", len(extract_features(b)))
        print("features =", extract_features(b).tolist())
