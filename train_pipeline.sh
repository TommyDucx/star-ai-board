#!/bin/bash
# B 全流程: 训练(教师标签+8×增广) -> 导出 policy.bin -> golden 验证 -> 完成
set -e
STAR="/Users/tommydu/Documents/Default Project/star"
DATA="/Users/tommydu/Documents/Default Project/data/teacher_dataset.jsonl"
PY_SYS="/usr/bin/python3"                       # 有 torch 2.2.2 + chess + numpy
PY_VENV="/Users/tommydu/.workbuddy/binaries/python/envs/default/bin/python3"  # 有 onnxruntime

cd "$STAR/my-engine/policy"
echo "==> [1/3] 训练 policy (teacher + 8x aug) ..."
"$PY_SYS" train_policy.py --data "$DATA" --epochs 40 --batch 64
echo "==> [2/3] 导出 policy.bin ..."
"$PY_SYS" export_weights.py
echo "==> [3/3] golden 验证 (Rust 复刻 vs ONNX) ..."
"$PY_VENV" policy_golden_test.py
echo "DONE. 新 policy.bin 已就绪，请运行 match.py 做前后对比。"
