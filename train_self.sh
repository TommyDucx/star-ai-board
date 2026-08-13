#!/bin/bash
# Self-distillation training: 用 my-engine 自身标签重训 policy
# 与 train_pipeline.sh (Stockfish 教师) 区分开
set -e
STAR="/Users/tommydu/Documents/Default Project/star"
DATA="/Users/tommydu/Documents/Default Project/data/self_teacher_dataset.jsonl"
PY_SYS="/usr/bin/python3"
PY_VENV="/Users/tommydu/.workbuddy/binaries/python/envs/default/bin/python3"

cd "$STAR/my-engine/policy"
echo "==> [1/3] 训练 policy (self-distill labels + 8x aug) ..."
"$PY_SYS" train_policy.py --data "$DATA" --epochs 40 --batch 64
echo "==> [2/3] 导出 policy.bin ..."
"$PY_SYS" export_weights.py
echo "==> [3/3] golden 验证 (Rust 复刻 vs ONNX) ..."
"$PY_VENV" policy_golden_test.py
echo "DONE. 新 self-distill policy.bin 已就绪，请运行 match.py 做前后对比。"
