#!/usr/bin/env bash
# sync_to_pi.sh — 在你的 Mac 终端运行，把自对弈任务派发到树莓派并取回结果
#
# 用法:
#   bash "/Users/tommydu/Documents/Default Project/star/sync_to_pi.sh" [GAMES]
#   GAMES 默认 2000 局（自对弈数量）
#
# 运行时会按提示输入树莓派密码（n8imativ）。
# 若想免密，可在 Mac 上执行: ssh-copy-id pi@192.168.0.107
set -euo pipefail

PI="pi@192.168.0.107"
STAR="/Users/tommydu/Documents/Default Project/star"
REMOTE_DIR="/home/pi/star_worker"
DATA="/Users/tommydu/Documents/Default Project/data"
GAMES="${1:-2000}"

echo "==> [1/3] 同步脚本与引擎源码到 $PI ..."
rsync -az --progress \
  --exclude 'target' --exclude 'node_modules' --exclude '.git' --exclude 'data' \
  "$STAR/dataset_gen.py" \
  "$STAR/lichess_attacks.py" \
  "$STAR/pi_worker.sh" \
  "$STAR/my-engine" \
  "$PI:$REMOTE_DIR/"

echo "==> [2/3] 在树莓派上运行自对弈 ($GAMES 局，nohup 后台运行，断网不影响) ..."
ssh "$PI" "nohup bash $REMOTE_DIR/pi_worker.sh $REMOTE_DIR $GAMES > $REMOTE_DIR/run.log 2>&1 &"
echo "    已在 Pi 后台启动。在 Pi 上可用: tail -f $REMOTE_DIR/run.log 查看进度"

echo "==> [3/3] 取回结果到本地 ..."
mkdir -p "$DATA"
rsync -az --progress "$PI:$REMOTE_DIR/data_pi/selfplay.jsonl" "$DATA/selfplay_pi.jsonl"

echo "完成。Pi 生成的原始数据: $DATA/selfplay_pi.jsonl"
echo "下一步: 运行  python3 \"$STAR/merge_dataset.py\"  合并全部数据集"
