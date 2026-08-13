#!/usr/bin/env python3
from __future__ import annotations
"""
make_self_teacher.py — Robust self-distillation label generator for my-engine Policy.

For every position in the base dataset, ask my-engine itself (policy DISABLED,
pure alpha-beta) for its best move under a fixed time budget. The resulting
labels are the engine's OWN strong moves, which align the policy with the
engine's own evaluation — unlike foreign Stockfish labels, this actually helps
root move-ordering guidance.

ROBUSTNESS (this version fixes the prior silent-hang bug):
  * A background thread continuously drains stderr so the OS pipe can never
    backpressure the engine (the classic readline deadlock).
  * bestmove is read by a dedicated reader thread; waiting uses a real wall-clock
    timeout via threading.Event — never a blocking readline with a useless deadline.
  * If a position exceeds the hard timeout, the engine process is KILLED and
    relaunched (fresh, clean state) and the position is skipped. Forward progress
    is guaranteed; the run can never hang forever.
  * Output is flushed periodically.

Output: data/self_teacher_dataset.jsonl  (fields: fen, bestmove_uci, score_cp, source)
"""
import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time

ROOT = "/Users/tommydu/Documents/Default Project"
DATA = os.path.join(ROOT, "data")
ENGINE = os.path.join(ROOT, "star", "my-engine", "target", "release", "my-engine")
DEFAULT_IN = os.path.join(DATA, "final_dataset.jsonl")
DEFAULT_OUT = os.path.join(DATA, "self_teacher_dataset.jsonl")


class UCIClient:
    """Drives my-engine over UCI with non-blocking IO and a hard hang watchdog."""

    def __init__(self, engine_path: str, hard_timeout: float = 15.0):
        self.engine_path = engine_path
        self.hard_timeout = hard_timeout
        self.proc = None
        self.uciok_event = threading.Event()
        self.readyok_event = threading.Event()
        self.bestmove_event = threading.Event()
        self.last_bestmove = None
        self._lock = threading.Lock()
        self._reader = None
        self._errpump = None
        self._alive = threading.Event()

    # ---- process lifecycle -------------------------------------------------
    def start(self):
        if not os.path.isfile(self.engine_path):
            raise FileNotFoundError(self.engine_path)
        self.proc = subprocess.Popen(
            [self.engine_path],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self._alive.set()
        self._reader = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader.start()
        self._errpump = threading.Thread(target=self._stderr_pump, daemon=True)
        self._errpump.start()
        return self

    def _reader_loop(self):
        try:
            for line in self.proc.stdout:
                line = line.rstrip("\r\n")
                if not line:
                    continue
                if line == "uciok":
                    self.uciok_event.set()
                elif line == "readyok":
                    self.readyok_event.set()
                elif line.startswith("bestmove"):
                    m = re.match(r"^bestmove\s+(\S+)", line)
                    self.last_bestmove = m.group(1) if m else None
                    self.bestmove_event.set()
        except Exception:
            pass
        finally:
            self._alive.clear()

    def _stderr_pump(self):
        # Drain stderr continuously so the pipe never fills and blocks the engine.
        try:
            for _ in self.proc.stderr:
                pass
        except Exception:
            pass

    def send(self, cmd: str):
        try:
            self.proc.stdin.write(cmd + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, ValueError, OSError):
            raise

    def kill(self):
        self._alive.clear()
        try:
            if self.proc:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            if self.proc:
                self.proc.kill()
                self.proc.wait(timeout=5)
        except Exception:
            pass

    # ---- UCI handshake -----------------------------------------------------
    def init(self, policy_on: bool = False):
        self.uciok_event.clear()
        self.send("uci")
        if not self.uciok_event.wait(timeout=10):
            raise RuntimeError("engine did not respond to 'uci'")
        self.send(f"setoption name Policy value {'true' if policy_on else 'false'}")
        self.readyok_event.clear()
        self.send("isready")
        if not self.readyok_event.wait(timeout=10):
            raise RuntimeError("engine did not respond to 'isready'")

    # ---- per-position query ------------------------------------------------
    def bestmove(self, fen: str, movetime_ms: int):
        # Reset to a clean game (clears TT) and wait for the engine to be ready.
        self.readyok_event.clear()
        try:
            self.send("ucinewgame")
            self.send("isready")
        except Exception:
            return None
        if not self.readyok_event.wait(timeout=10):
            return None  # engine not responding -> caller will restart
        self.send(f"position fen {fen}")
        self.bestmove_event.clear()
        self.last_bestmove = None
        self.send(f"go movetime {movetime_ms}")
        if self.bestmove_event.wait(timeout=self.hard_timeout):
            return self.last_bestmove
        return None  # hard timeout -> caller will kill+restart


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default=DEFAULT_IN)
    ap.add_argument("--out", dest="out", default=DEFAULT_OUT)
    ap.add_argument("--engine", default=ENGINE,
                    help="teacher engine binary (use the STRONGEST build, e.g. my-engine_see)")
    ap.add_argument("--movetime", type=int, default=300, help="ms budget per position")
    ap.add_argument("--limit", type=int, default=0, help="max positions (0=all)")
    ap.add_argument("--hard-timeout", type=float, default=15.0,
                    help="wall-clock seconds before a position is declared hung")
    ap.add_argument("--policy", action="store_true", help="keep Policy ON (default OFF)")
    args = ap.parse_args()

    with open(args.inp) as f:
        rows = [json.loads(l) for l in f if l.strip()]
    if args.limit:
        rows = rows[:args.limit]
    print(f"Loaded {len(rows)} positions from {args.inp}", file=sys.stderr)

    print(f"Teacher engine: {args.engine}", file=sys.stderr)
    cli = UCIClient(args.engine, hard_timeout=args.hard_timeout).start()
    try:
        cli.init(policy_on=args.policy)
    except RuntimeError as e:
        print(f"FATAL: {e}", file=sys.stderr)
        cli.kill()
        sys.exit(1)

    out_f = open(args.out, "w")
    done = 0
    skipped = 0
    restarts = 0
    t0 = time.time()
    flush_every = 50

    for i, r in enumerate(rows):
        fen = r.get("fen")
        if not fen:
            skipped += 1
            continue
        bm = cli.bestmove(fen, args.movetime)
        if not bm or bm == "(none)":
            # Engine stalled or returned nothing -> restart to recover clean state.
            skipped += 1
            if not cli._alive.is_set():
                restarts += 1
                print(f"  [restart #{restarts}] engine died at {i+1}; relaunching",
                      file=sys.stderr)
                cli = UCIClient(args.engine, hard_timeout=args.hard_timeout).start()
                cli.init(policy_on=args.policy)
            else:
                # Timed out but still alive: force restart to drop any partial state.
                restarts += 1
                print(f"  [restart #{restarts}] hard timeout at {i+1}; relaunching",
                      file=sys.stderr)
                cli.kill()
                cli = UCIClient(args.engine, hard_timeout=args.hard_timeout).start()
                cli.init(policy_on=args.policy)
            continue
        rec = {
            "fen": fen,
            "bestmove_uci": bm,
            "score_cp": r.get("score_cp"),
            "source": "self_distill",
        }
        out_f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        done += 1
        if done % flush_every == 0:
            out_f.flush()
        if (i + 1) % 100 == 0:
            rate = done / (time.time() - t0) if (time.time() - t0) > 0 else 0
            eta = (len(rows) - (i + 1)) / rate / 60 if rate else 0
            print(f"  {i+1}/{len(rows)}  labeled={done}  skipped={skipped}  "
                  f"restarts={restarts}  rate={rate:.1f}/s  ETA={eta:.1f}min",
                  file=sys.stderr)

    out_f.flush()
    out_f.close()
    cli.kill()
    print(f"DONE. labeled={done} skipped={skipped} restarts={restarts} -> {args.out}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
