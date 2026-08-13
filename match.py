#!/usr/bin/env python3
"""
A: 棋力评测框架 —— 让两个引擎实例(UCI)互相对弈 N 局，统计 胜/和/负 + Elo 置信区间。

设计要点（决定测量灵敏度，改之前先读）：
  1. 开局分散 (--openings)：全部从初始局面开跑是错的——引擎在固定 movetime 下
     只靠时间抖动产生差异，等于把“噪声”当成“样本多样性”，同一条变例反复出现，
     测出来的 Elo 主要是运气。这里内置一批常见均衡开局，每条开局连打两局并交换
     先后手（成对对局 game pairs），既扩大局面覆盖，又抵掉先手优势，方差显著下降。
  2. 并行 (--concurrency)：每个并行槽位持有自己独立的一对引擎实例与工作目录。
     movetime 是“每步固定思考时间”，不是挂钟制，因此并行不会让谁少想；只要
     并行数 <= 物理核数就不会互相抢占到失真。8 核机器上 4 路是安全的。
  3. 置信区间：不要用“胜率 + 二项分布”近似——那等于假设没有和棋。这里直接对
     每局得分(1/0.5/0)算样本标准差，SE = std/sqrt(n)。和棋多时 CI 会明显收紧，
     同样局数能分辨更小的 Elo 差。
  4. 每局开始发 ucinewgame：清空置换表，保证各局统计独立。

用法示例:
  python3 match.py --eng-a ./target/release/my-engine_lmp \
      --eng-b ./target/release/my-engine_rep \
      --policy-a /tmp/old_policy_for_exp.bin --policy-b /tmp/old_policy_for_exp.bin \
      --games 96 --concurrency 4 --movetime 300 --out /tmp/m.json
"""
import argparse, json, math, os, subprocess, sys, tempfile, threading, time, shutil
import chess
import chess.pgn

ENGINE_TIMEOUT = 60  # 单步搜索超时(秒)

# 内置开局库：均衡、常见、全部偶数手（先后手对称），以 UCI 走法给出。
# 启动时会用 python-chess 逐条校验合法性，非法的直接剔除并告警。
OPENINGS = [
    "e2e4 e7e5 g1f3 b8c6",
    "e2e4 e7e5 b1c3 g8f6",
    "e2e4 e7e5 g1f3 g8f6",
    "e2e4 e7e5 f1c4 g8f6",
    "e2e4 e7e5 d2d4 e5d4",
    "e2e4 c7c5 g1f3 d7d6",
    "e2e4 c7c5 b1c3 b8c6",
    "e2e4 e7e6 d2d4 d7d5",
    "e2e4 e7e6 d2d4 c7c5",
    "e2e4 c7c6 d2d4 d7d5",
    "e2e4 d7d5 e4d5 d8d5",
    "e2e4 g8f6 e4e5 f6d5",
    "e2e4 d7d6 d2d4 g8f6",
    "e2e4 g7g6 d2d4 f8g7",
    "e2e4 b8c6 d2d4 d7d5",
    "d2d4 d7d5 c2c4 e7e6",
    "d2d4 d7d5 c2c4 c7c6",
    "d2d4 d7d5 g1f3 g8f6",
    "d2d4 d7d5 c2c4 g8f6",
    "d2d4 g8f6 c2c4 e7e6",
    "d2d4 g8f6 c2c4 g7g6",
    "d2d4 g8f6 g1f3 e7e6",
    "d2d4 e7e6 c2c4 f8b4",
    "d2d4 d7d6 e2e4 g8f6",
    "d2d4 f7f5 c2c4 g8f6",
    "c2c4 e7e5 b1c3 g8f6",
    "c2c4 g8f6 b1c3 e7e6",
    "c2c4 c7c5 g1f3 g8f6",
    "g1f3 g8f6 c2c4 e7e6",
    "g1f3 d7d5 d2d4 g8f6",
]


def validated_openings():
    ok = []
    for line in OPENINGS:
        b = chess.Board()
        good = True
        for u in line.split():
            try:
                mv = chess.Move.from_uci(u)
            except Exception:
                good = False
                break
            if mv not in b.legal_moves:
                good = False
                break
            b.push(mv)
        if good:
            ok.append(line)
        else:
            print(f"[warn] 剔除非法开局: {line}", file=sys.stderr)
    return ok


class UCIEngine:
    def __init__(self, eng_path, workdir, policy_path=None, policy_on=True, threads=1):
        self.eng = eng_path
        self.workdir = workdir
        os.makedirs(workdir, exist_ok=True)
        # 把 policy.bin 放进工作目录（若无则无策略）
        self.policy_file = os.path.join(workdir, "policy.bin")
        if policy_path and os.path.isfile(policy_path):
            shutil.copy(policy_path, self.policy_file)
        self.policy_on = policy_on
        self.proc = subprocess.Popen(
            [eng_path], cwd=workdir,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        self._send("uci")
        # 等待 uciok
        self._read_until("uciok", 10)
        if not policy_on:
            self._send("setoption name Policy value false")
        self._send(f"setoption name Threads value {threads}")
        self._send("isready")
        self._read_until("readyok", 10)

    def _send(self, cmd):
        try:
            self.proc.stdin.write(cmd + "\n")
            self.proc.stdin.flush()
        except Exception:
            pass

    def _read_until(self, token, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                return None
            if line.strip() == token:
                return line.strip()
        return None

    def new_game(self):
        """清空置换表，保证各局独立。"""
        self._send("ucinewgame")
        self._send("isready")
        self._read_until("readyok", 10)

    def bestmove(self, board, movetime_ms):
        moves = " ".join(m.uci() for m in board.move_stack)
        if moves:
            self._send(f"position startpos moves {moves}")
        else:
            self._send("position startpos")
        self._send(f"go movetime {movetime_ms}")
        deadline = time.monotonic() + ENGINE_TIMEOUT
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                return None
            if line.startswith("bestmove"):
                parts = line.split()
                if len(parts) >= 2 and parts[1] != "(none)":
                    return parts[1]
                return None
        return None

    def quit(self):
        try:
            self._send("quit")
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def elo_from_score(s):
    if s <= 0 or s >= 1:
        return None
    return 400 * math.log10(s / (1 - s))


def _phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def elo_and_ci(per_game_scores, z=1.96):
    """按每局得分(1/0.5/0)的样本方差算 CI —— 和棋多时比二项近似紧得多。

    返回 (elo, lo, hi, los, score, se)。
    """
    n = len(per_game_scores)
    if n == 0:
        return (None, None, None, None, None, None)
    s = sum(per_game_scores) / n
    if n > 1:
        var = sum((x - s) ** 2 for x in per_game_scores) / (n - 1)
        se = math.sqrt(var / n)
    else:
        se = 0.0
    elo = elo_from_score(s)
    lo_s = max(1e-4, min(1 - 1e-4, s - z * se))
    hi_s = max(1e-4, min(1 - 1e-4, s + z * se))
    los = _phi((s - 0.5) / se) if se > 0 else (1.0 if s > 0.5 else 0.0)
    return (
        round(elo, 1) if elo is not None else None,
        elo_from_score(lo_s),
        elo_from_score(hi_s),
        round(los, 4),
        round(s, 4),
        se,
    )


def play_game(white_eng, black_eng, movetime, opening="", max_plies=240):
    board = chess.Board()
    for u in opening.split():
        board.push(chess.Move.from_uci(u))
    white_eng.new_game()
    black_eng.new_game()
    ply = 0
    while not board.is_game_over(claim_draw=True) and ply < max_plies:
        eng = white_eng if board.turn == chess.WHITE else black_eng
        bm = eng.bestmove(board, movetime)
        if bm is None:
            # 引擎无着 -> 判负
            return ("0-1" if board.turn == chess.WHITE else "1-0"), board
        try:
            mv = chess.Move.from_uci(bm)
        except Exception:
            return ("0-1" if board.turn == chess.WHITE else "1-0"), board
        if mv not in board.legal_moves:
            # 非法着 -> 判负
            return ("0-1" if board.turn == chess.WHITE else "1-0"), board
        board.push(mv)
        ply += 1
    return board.result(claim_draw=True), board


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--eng", default=None, help="引擎二进制路径（两方共用，除非单独指定 --eng-a/--eng-b）")
    ap.add_argument("--eng-a", default=None, help="A 方引擎二进制（缺省=--eng）")
    ap.add_argument("--eng-b", default=None, help="B 方引擎二进制（缺省=--eng）")
    ap.add_argument("--policy-a", default=None, help="A 侧 policy.bin（缺省=无策略）")
    ap.add_argument("--policy-b", default=None, help="B 侧 policy.bin（缺省=无策略）")
    ap.add_argument("--disable-a", action="store_true", help="A 侧关闭策略(setoption Policy false)")
    ap.add_argument("--disable-b", action="store_true", help="B 侧关闭策略")
    ap.add_argument("--threads-a", type=int, default=1, help="A 侧搜索线程数(setoption Threads)")
    ap.add_argument("--threads-b", type=int, default=1, help="B 侧搜索线程数(setoption Threads)")
    ap.add_argument("--games", type=int, default=40)
    ap.add_argument("--movetime", type=int, default=300, help="每步思考时间(ms)")
    ap.add_argument("--concurrency", type=int, default=1, help="并行对局数（<= 物理核数）")
    ap.add_argument("--no-openings", action="store_true",
                    help="关闭开局分散，全部从初始局面开跑（不推荐，方差会大得没法用）")
    ap.add_argument("--out", default="match_report.json")
    ap.add_argument("--name-a", default="A")
    ap.add_argument("--name-b", default="B")
    args = ap.parse_args()
    if not (args.eng or args.eng_a or args.eng_b):
        ap.error("必须提供 --eng 或 --eng-a/--eng-b 之一")
    eng_a = os.path.abspath(args.eng_a or args.eng)
    eng_b = os.path.abspath(args.eng_b or args.eng)
    args.eng_a = eng_a
    args.eng_b = eng_b
    if args.policy_a:
        args.policy_a = os.path.abspath(args.policy_a)
    if args.policy_b:
        args.policy_b = os.path.abspath(args.policy_b)

    books = [""] if args.no_openings else validated_openings()
    print(f"开局库: {len(books)} 条 | 并行: {args.concurrency} | 局数: {args.games}", file=sys.stderr)

    base = tempfile.mkdtemp(prefix="match_")
    results = {args.name_a: 0, args.name_b: 0, "draw": 0}
    color_records = {args.name_a: {"w": 0, "d": 0, "l": 0}, args.name_b: {"w": 0, "d": 0, "l": 0}}
    per_game = []      # A 视角每局得分
    pgns = []          # (round, game)
    lock = threading.Lock()
    done = [0]
    t0 = time.time()

    def record(g, res, board, a_is_white, opening):
        a_win = (res == "1-0") if a_is_white else (res == "0-1")
        a_draw = (res == "1/2-1/2")
        with lock:
            if a_win:
                results[args.name_a] += 1
                color_records[args.name_a]["w"] += 1
                color_records[args.name_b]["l"] += 1
                per_game.append(1.0)
            elif a_draw:
                results["draw"] += 1
                color_records[args.name_a]["d"] += 1
                color_records[args.name_b]["d"] += 1
                per_game.append(0.5)
            else:
                results[args.name_b] += 1
                color_records[args.name_a]["l"] += 1
                color_records[args.name_b]["w"] += 1
                per_game.append(0.0)
            game = chess.pgn.Game.from_board(board)
            game.headers["Event"] = f"{args.name_a} vs {args.name_b}"
            game.headers["Result"] = res
            game.headers["White"] = args.name_a if a_is_white else args.name_b
            game.headers["Black"] = args.name_b if a_is_white else args.name_a
            game.headers["Round"] = str(g + 1)
            game.headers["Opening"] = opening or "startpos"
            pgns.append((g, game))
            done[0] += 1
            print(f"[{done[0]}/{args.games}] game{g+1} {res}  "
                  f"(A {results[args.name_a]}W/{results['draw']}D/{results[args.name_b]}L)  "
                  f"t={time.time()-t0:.0f}s", flush=True)

    def worker(slot, indices):
        wa = os.path.join(base, f"A{slot}")
        wb = os.path.join(base, f"B{slot}")
        engA = UCIEngine(args.eng_a, wa, args.policy_a, policy_on=not args.disable_a, threads=args.threads_a)
        engB = UCIEngine(args.eng_b, wb, args.policy_b, policy_on=not args.disable_b, threads=args.threads_b)
        try:
            for g in indices:
                # 成对对局：相邻两局用同一条开局，交换先后手
                opening = books[(g // 2) % len(books)]
                a_is_white = (g % 2 == 0)
                white_eng, black_eng = (engA, engB) if a_is_white else (engB, engA)
                res, board = play_game(white_eng, black_eng, args.movetime, opening)
                record(g, res, board, a_is_white, opening)
        finally:
            engA.quit()
            engB.quit()

    conc = max(1, min(args.concurrency, args.games))
    # 按“对”分配，保证同一对开局的两局落在同一槽位（同槽位环境完全一致，
    # 先后手互换的抵消效果最干净）
    pairs = [(i, i + 1) for i in range(0, args.games, 2)]
    slots = [[] for _ in range(conc)]
    for pi, pr in enumerate(pairs):
        for g in pr:
            if g < args.games:
                slots[pi % conc].append(g)

    threads = [threading.Thread(target=worker, args=(i, slots[i]), daemon=True)
               for i in range(conc) if slots[i]]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    n = len(per_game)
    elo, lo, hi, los, a_score, se = elo_and_ci(per_game)
    report = {
        "engine": args.eng,
        "eng_a": args.eng_a,
        "eng_b": args.eng_b,
        "games": n,
        "movetime_ms": args.movetime,
        "concurrency": conc,
        "openings": len(books) if not args.no_openings else 0,
        "names": {args.name_a: {"policy": args.policy_a, "disabled": args.disable_a},
                  args.name_b: {"policy": args.policy_b, "disabled": args.disable_b}},
        "results": {
            args.name_a: results[args.name_a],
            "draw": results["draw"],
            args.name_b: results[args.name_b],
        },
        "score_A": a_score,
        "score_se": round(se, 4) if se is not None else None,
        "elo_diff_A_minus_B": elo,
        "elo_95ci": [lo, hi] if lo is not None else None,
        "LOS_A_better": los,
        "per_color": color_records,
        "duration_s": round(time.time() - t0, 1),
    }
    with open(args.out, "w") as f:
        json.dump(report, f, indent=2)
    pgn_path = os.path.splitext(args.out)[0] + ".pgn"
    with open(pgn_path, "w") as f:
        for _, g in sorted(pgns, key=lambda x: x[0]):
            f.write(str(g) + "\n\n")
    print("\n=== 评测报告 ===")
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
