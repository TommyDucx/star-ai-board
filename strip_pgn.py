#!/usr/bin/env python3
"""PGN 注释剥离：去掉花括号注释 {…}、分号注释 ;…、NAG $N，
大幅加速后续 chess.pgn.read_game 解析（CCRL commented PGN 每步带引擎评分，是清洗瓶颈）。

用法：
  python3 strip_pgn.py input.pgn output.pgn
"""
import re
import sys


def strip(text: str) -> str:
    t = re.sub(r"\{[^}]*\}", "", text, flags=re.DOTALL)  # 花括号注释（可跨行）
    t = re.sub(r";[^\n]*", "", t)                          # 分号注释（到行尾）
    t = re.sub(r"\$[0-9]+", "", t)                         # NAG（$1 $2 …）
    return t


def main():
    if len(sys.argv) != 3:
        print("用法: python3 strip_pgn.py input.pgn output.pgn")
        sys.exit(1)
    with open(sys.argv[1], "r", encoding="utf-8", errors="ignore") as f:
        text = f.read()
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        f.write(strip(text))
    print(f"已剥离注释: {sys.argv[1]} -> {sys.argv[2]}")


if __name__ == "__main__":
    main()
