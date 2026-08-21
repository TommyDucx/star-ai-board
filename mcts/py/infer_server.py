#!/usr/bin/env python3
"""BiaoZi MCTS 推理服务：stdin/stdout JSON 行协议，批量就绪后可扩展。

请求: {"id":N,"p":"<hex 1088B 17平面>","legal":[idx,...]}
响应: {"id":N,"v":f32,"pr":[f32,...]}   （pr 与 legal 对齐，softmax 后）
启动完成输出一行 READY。
"""
import argparse
import base64
import json
import os
import sys

import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train_mcts import AzNet  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True)
    args = ap.parse_args()

    torch.set_num_threads(int(os.environ.get("AZ_THREADS", "2")))
    net = AzNet()
    sd = torch.load(args.weights, map_location="cpu")
    net.load_state_dict(sd)
    net.eval()
    print("READY", flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        raw = bytes.fromhex(r["p"])
        planes = np.frombuffer(raw, dtype=np.uint8).reshape(17, 8, 8).astype(np.float32) / 255.0
        with torch.no_grad():
            pol, val = net(torch.from_numpy(planes)[None])
        legal = r["legal"]
        logits = pol[0][torch.tensor(legal, dtype=torch.long)]
        probs = torch.softmax(logits, dim=-1).tolist()
        print(json.dumps({"id": r["id"], "v": float(val.item()), "pr": probs}), flush=True)


if __name__ == "__main__":
    main()
