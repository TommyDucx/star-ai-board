#!/usr/bin/env python3
"""深搜索自洽标签生成器：用引擎自身（policy 开启）+ 更长时间搜索，为给定 FEN 打标签。

与 make_self_teacher.py 的区别：
  - policy 开启（保持与线上实际对弈一致，自洽）；
  - 多进程并行（--workers），大幅加速；
  - 复用 make_self_teacher.UCIClient 的健壮 IO/超时/重启逻辑。

输出: --out 指定的 jsonl（字段: fen, bestmove_uci, source="deep_self_distill"）
"""
import argparse
import json
import multiprocessing as mp
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_self_teacher import UCIClient  # noqa: E402

ENGINE = str(Path(__file__).resolve().parent / "handcrafted" / "target" / "release" / "my-engine")


def worker(args):
    fens, movetime, seed = args
    cli = UCIClient(ENGINE).start()
    try:
        cli.init(policy_on=True)  # policy 开启，保持自洽
    except RuntimeError:
        cli.kill()
        return []
    out = []
    for fen in fens:
        bm = cli.bestmove(fen, movetime)
        if bm and bm != "(none)":
            out.append({"fen": fen, "bestmove_uci": bm, "source": "deep_self_distill"})
    cli.kill()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="输入 jsonl（含 fen 字段）")
    ap.add_argument("--out", required=True, help="输出 jsonl")
    ap.add_argument("--movetime", type=int, default=1000, help="每局面思考 ms")
    ap.add_argument("--workers", type=int, default=8, help="并行进程数")
    ap.add_argument("--limit", type=int, default=0, help="最多打标签数（0=全部）")
    args = ap.parse_args()

    rows = [json.loads(l) for l in open(args.inp) if l.strip()]
    fens = [r["fen"] for r in rows]
    if args.limit:
        fens = fens[:args.limit]
    # 去重（保持顺序）
    seen = set()
    fens = [f for f in fens if not (f in seen or seen.add(f))]

    workers = max(1, min(args.workers, len(fens)))
    buckets = [fens[i::workers] for i in range(workers)]  # 轮转分配，负载均衡
    tasks = [(b, args.movetime, 42 + i) for i, b in enumerate(buckets) if b]

    print(f"深搜索打标签: {len(fens)} 个 fen / {workers} 进程 / movetime {args.movetime}ms",
          file=sys.stderr, flush=True)
    all_out = []
    with mp.Pool(processes=workers) as pool:
        for i, res in enumerate(pool.imap_unordered(worker, tasks)):
            all_out.extend(res)
            print(f"  worker {i + 1}/{len(tasks)} 完成，累计 {len(all_out)}",
                  file=sys.stderr, flush=True)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for r in all_out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"完成: {len(all_out)} 条 -> {args.out}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
