#!/usr/bin/env python3
"""导出 policy.pt -> policy.bin（float32 顺序拼接，供 Rust 引擎手写推理读取）"""
import struct
import torch
import numpy as np
from train_policy import PolicyNet

m = PolicyNet()
m.load_state_dict(torch.load("policy.pt"))
params = [
    m.conv1.weight, m.conv1.bias,
    m.conv2.weight, m.conv2.bias,
    m.fc1.weight,   m.fc1.bias,
    m.fc2.weight,   m.fc2.bias,
]
with open("policy.bin", "wb") as f:
    for p in params:
        arr = p.detach().cpu().numpy().astype(np.float32).ravel()
        f.write(arr.tobytes())
print("written policy.bin, total bytes:", sum(p.numel() for p in params) * 4)
