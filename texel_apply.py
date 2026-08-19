#!/usr/bin/env python3
"""把 texel_tune.py 的输出写回 eval.rs 的常量（25 个标量参数）。

用法：
  python3 texel_apply.py --params tuned_params.json --eval-rs my-engine/handcrafted/src/eval.rs
"""
import argparse
import json
import re


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--params", required=True, help="tuned_params.json")
    ap.add_argument("--eval-rs", default="my-engine/handcrafted/src/eval.rs")
    args = ap.parse_args()

    d = json.load(open(args.params))
    p = d["params"]  # 25 个 int，顺序与 texel_eval.FEATURE_NAMES 一致
    src = open(args.eval_rs).read()

    # 标量常量：NAME -> 参数索引
    scalar = [
        ("DOUBLED_PENALTY", 5), ("ISOLATED_PENALTY", 6), ("BISHOP_PAIR_BONUS", 7),
        ("ROOK_OPEN_BONUS", 8), ("ROOK_HALF_OPEN_BONUS", 9), ("ROOK_STACKED_BONUS", 10),
        ("SHIELD_NEAR", 17), ("SHIELD_FAR", 18),
        ("KATTACK_QUEEN", 19), ("KATTACK_ROOK", 20), ("KATTACK_KNIGHT", 21),
        ("KATTACK_BISHOP", 22), ("KATTACK_PAWN", 23), ("PAWN_STORM_BONUS", 24),
    ]
    for name, idx in scalar:
        src, n = re.subn(
            rf"const {name}: i32 = -?\d+;",
            f"const {name}: i32 = {p[idx]};",
            src,
        )
        assert n == 1, f"未找到或重复匹配常量 {name}（{n} 处）"

    # PIECE_VALUES（前 5 个，王 20000 固定）
    vals = [p[0], p[1], p[2], p[3], p[4], 20000]
    src, n = re.subn(
        r"const PIECE_VALUES: \[i32; 6\] = \[[^\]]*\];",
        f"const PIECE_VALUES: [i32; 6] = [{', '.join(map(str, vals))}];",
        src,
    )
    assert n == 1, f"PIECE_VALUES 匹配 {n} 处"

    # PASSED_BONUS（推进 1-6 行；首尾 0 固定）
    pb = [0, p[11], p[12], p[13], p[14], p[15], p[16], 0]
    src, n = re.subn(
        r"const PASSED_BONUS: \[i32; 8\] = \[[^\]]*\];",
        f"const PASSED_BONUS: [i32; 8] = [{', '.join(map(str, pb))}];",
        src,
    )
    assert n == 1, f"PASSED_BONUS 匹配 {n} 处"

    open(args.eval_rs, "w").write(src)
    print(f"已写回 25 个标量参数 -> {args.eval_rs}")


if __name__ == "__main__":
    main()
