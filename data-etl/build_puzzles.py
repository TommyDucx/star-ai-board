import csv, io, json, hashlib, zstandard, chess

SRC = "/tmp/lichess_db_puzzle.csv.zst"
OUT = "/Users/tommydu/Documents/Star Chess/public/data/puzzles.json"

# lichess 全部主题（覆盖所有题型）
THEMES = ["advancedPawn","attraction","backRankMate","bishopEndgame","capturingDefender",
 "crushing","defensiveMove","deflection","discoveredAttack","doubleBishopMate","doubleCheck",
 "dovetailMate","enPassant","endgame","equality","fork","hangingPiece","horizontalLine",
 "interference","intermezzo","killingMove","kingsideAttack","knightEndgame","long","mate",
 "mateIn1","mateIn2","mateIn3","mateIn4","mateIn5","middlegame","oneMove","opening",
 "pawnEndgame","pin","promotion","queensideAttack","quietMove","rookEndgame","sacrifice",
 "short","skewer","smotheredMate","trappedPiece","underpromotion","veryLong","xRayAttack","zugzwang"]

# 难度分档（按 lichess 评分）
BANDS = [(0, 1100), (1100, 1500), (1500, 2000), (2000, 99999)]
CAP_PER = 300          # 每个 (主题×档) 最多 300 题
MAX_PM = 6             # 玩家最多 6 步（含长题）
LONG_EXTRA = {"long","veryLong","mateIn4","mateIn5","equality"}  # 长题可放宽步数
POP_MIN = 40           # 人气过滤（放宽以便稀有主题也能进）

counters = {(t, b): 0 for t in THEMES for b in range(4)}
picked = []            # (puzzle_row, 主主题, band)
seen = set()

with open(SRC, "rb") as fh:
    reader = csv.reader(io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(fh), "utf-8"))
    header = next(reader)
    ix = {k: header.index(k) for k in ("PuzzleId","FEN","Moves","Rating","Popularity","Themes")}
    n = 0
    for row in reader:
        n += 1
        if n % 1000000 == 0: print(f"...扫描 {n} 行 / 已选 {len(picked)}", flush=True)
        if int(row[ix["Popularity"]]) < POP_MIN: continue
        themes = set(row[ix["Themes"]].split())
        rating = int(row[ix["Rating"]])
        band = next(b for b, (lo, hi) in enumerate(BANDS) if lo <= rating < hi)
        moves = row[ix["Moves"]].split()
        player_moves = (len(moves)) // 2          # moves[0] 是对手最后一步
        maxpm = MAX_PM + (4 if themes & LONG_EXTRA else 0)
        if player_moves > maxpm: continue
        # 每个主题只允许在对应档内取；取满的桶直接略过整行（行归属多个主题）
        hit = None
        for t in themes:
            if t in THEMES and counters[(t, band)] < CAP_PER:
                hit = t; break
        if hit is None: continue
        if row[ix["PuzzleId"]] in seen: continue
        seen.add(row[ix["PuzzleId"]])
        for t in themes:
            if t in THEMES and counters[(t, band)] < CAP_PER:
                counters[(t, band)] += 1
        picked.append((row, hit, band))
        if len(picked) >= 32000: break
        # 伪随机稀疏：偶尔跳过，保证来源多样（对短题无影响）
        if int(hashlib.md5(row[ix["PuzzleId"]].encode()).hexdigest(), 16) % 97 < 30:
            continue

out = []
for row, main, band in picked:
    moves = row[ix["Moves"]].split()
    board = chess.Board(row[ix["FEN"]])
    mv0 = chess.Move.from_uci(moves[0])
    if mv0 not in board.legal_moves: continue
    board.push(mv0)
    out.append({
        "id": row[ix["PuzzleId"]], "theme": main,
        "fen": board.fen(), "moves": moves[1:],
        "rating": int(row[ix["Rating"]]), "themes": row[ix["Themes"]].split(),
    })

by_tier = {}
for p in out:
    r = p["rating"]
    t = "beginner" if r < 1100 else "elementary" if r < 1500 else "intermediate" if r < 2000 else "advanced"
    p["tier"] = t
    by_tier[t] = by_tier.get(t, 0) + 1
json.dump({"version": 1, "source": "lichess_db_puzzle", "count": len(out), "puzzles": out},
          open(OUT, "w"), ensure_ascii=False, separators=(",", ":"))
import os
print("题库生成:", OUT, len(out), "题,", round(os.path.getsize(OUT)/1e6, 1), "MB")
print("分档:", by_tier)
print("主题覆盖数:", len({t for p in out for t in p["themes"]}), "个")
