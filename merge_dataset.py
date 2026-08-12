#!/usr/bin/env python3
# merge_dataset.py — 合并 S.T.A.R. Policy CNN 训练数据集
#
# 输入 (均在 data/ 目录):
#   selfplay.jsonl        # Mac 本地自对弈 (my-engine)
#   selfplay_pi.jsonl     # 树莓派自对弈 (若存在)
#   lichess_attacks.jsonl # Lichess 进攻题目
#
# 输出:
#   final_dataset.jsonl      # 统一 schema 的训练集
#   final_dataset_summary.json
#
# 配比目标: 80% 自对弈 / 20% Lichess (可用 --ratio 调整)。
# 若自对弈不足，则下采样 Lichess 以维持比例；用 --keep-all 可保留全部不做裁剪。

import argparse
import json
import random
from pathlib import Path

import chess

DATA = Path("/Users/tommydu/Documents/Default Project/data")


def load_jsonl(p: Path):
    if not p.exists():
        return []
    out = []
    with open(p, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out


def normalize_selfplay(rec: dict) -> dict | None:
    fen = rec.get("fen")
    mv = rec.get("bestmove_uci")
    if not fen or not mv:
        return None
    return {
        "source": "selfplay",
        "fen": fen,
        "bestmove_uci": mv,
        "bestmove_san": rec.get("bestmove_san"),
        "score_cp": rec.get("score_cp"),
        "eval_available": rec.get("score_cp") is not None,
        "side_to_move": rec.get("side_to_move"),
        "is_capture": bool(rec.get("is_capture", False)),
        "is_check": bool(rec.get("is_check", False)),
        "meta": {
            "game_id": rec.get("game_id"),
            "ply": rec.get("ply"),
            "depth": rec.get("depth"),
        },
    }


def normalize_lichess(rec: dict) -> dict | None:
    fen = rec.get("fen")
    sol = rec.get("solution_uci", "")
    first = sol.split()[0] if sol else None
    if not fen or not first:
        return None
    stm = None
    try:
        b = chess.Board(fen)
        stm = "w" if b.turn == chess.WHITE else "b"
    except Exception:
        pass
    return {
        "source": "lichess",
        "fen": fen,
        "bestmove_uci": first,
        "bestmove_san": None,
        "score_cp": None,
        "eval_available": False,
        "side_to_move": stm,
        "is_capture": False,
        "is_check": False,
        "meta": {
            "puzzle_id": rec.get("puzzle_id"),
            "rating": rec.get("rating"),
            "themes": rec.get("themes"),
            "attack_score": rec.get("attack_score"),
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=str(DATA))
    ap.add_argument("--ratio", type=float, default=0.8, help="自对弈目标占比 (默认 0.8)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--cap-lichess", type=int, default=0, help="Lichess 上限 (0=不限制)")
    ap.add_argument("--keep-all", action="store_true", help="保留全部，不做比例裁剪")
    args = ap.parse_args()
    random.seed(args.seed)
    d = Path(args.data_dir)

    sp_local = load_jsonl(d / "selfplay.jsonl")
    sp_pi = load_jsonl(d / "selfplay_pi.jsonl")
    lic_raw = load_jsonl(d / "lichess_attacks.jsonl")

    sp = [r for r in (normalize_selfplay(x) for x in (sp_local + sp_pi)) if r]
    lc = [r for r in (normalize_lichess(x) for x in lic_raw) if r]

    if args.cap_lichess and len(lc) > args.cap_lichess:
        lc = random.sample(lc, args.cap_lichess)

    if args.keep_all:
        sp_keep, lc_keep = sp, lc
    else:
        sp_ratio = args.ratio
        lic_ratio = 1 - args.ratio
        if len(sp) >= (sp_ratio / lic_ratio) * len(lc):
            target_sp = int((sp_ratio / lic_ratio) * len(lc))
            sp_keep = random.sample(sp, target_sp)
            lc_keep = lc
        else:
            target_lc = int((lic_ratio / sp_ratio) * len(sp))
            sp_keep = sp
            lc_keep = random.sample(lc, target_lc)

    merged = sp_keep + lc_keep
    random.shuffle(merged)

    out = d / "final_dataset.jsonl"
    with open(out, "w", encoding="utf-8") as f:
        for r in merged:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    summary = {
        "total": len(merged),
        "selfplay": len(sp_keep),
        "lichess": len(lc_keep),
        "selfplay_ratio": round(len(sp_keep) / len(merged), 4) if merged else 0,
        "lichess_ratio": round(len(lc_keep) / len(merged), 4) if merged else 0,
        "selfplay_local_raw": len(sp_local),
        "selfplay_pi_raw": len(sp_pi),
        "lichess_raw": len(lic_raw),
        "mode": "keep_all" if args.keep_all else f"balanced_to_{args.ratio:.2f}",
        "output": str(out),
    }
    with open(d / "final_dataset_summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
