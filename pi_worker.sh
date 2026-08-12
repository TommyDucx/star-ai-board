#!/usr/bin/env bash
# pi_worker.sh — 在树莓派上生成 S.T.A.R. Policy CNN 自对弈数据集
# 由 sync_to_pi.sh 通过 ssh 调用；也可手动 SSH 后运行：
#   bash /home/pi/star_worker/pi_worker.sh /home/pi/star_worker 2000
set -u

WORKER_DIR="${1:-/home/pi/star_worker}"
GAMES="${2:-2000}"
DEPTH="${3:-6}"
MOVETIME="${4:-500}"
MAX_PLIES="${5:-40}"

echo "=== S.T.A.R. Pi worker ==="
echo "WORKER_DIR=$WORKER_DIR  GAMES=$GAMES  DEPTH=$DEPTH  MOVETIME=$MOVETIME  MAX_PLIES=$MAX_PLIES"
echo "提示: 断网不影响，可随时  tail -f $WORKER_DIR/run.log  查看进度"
mkdir -p "$WORKER_DIR"
cd "$WORKER_DIR" || { echo "无法进入 $WORKER_DIR"; exit 1; }

# ── 1. 定位或编译 my-engine ──────────────────────────────
ENGINE=""

# a) 之前部署过的 star 项目里的二进制
LEGACY="/home/pi/Documents/Default Project/star/my-engine/target/release/my-engine"
if [ -x "$LEGACY" ] && printf 'uci\nquit\n' | timeout 15 "$LEGACY" >/dev/null 2>&1; then
  ENGINE="$LEGACY"
  echo "使用已有部署的引擎: $ENGINE"
fi

# b) worker 目录里已编译好的二进制
if [ -z "$ENGINE" ] && [ -x "$WORKER_DIR/my-engine/target/release/my-engine" ]; then
  ENGINE="$WORKER_DIR/my-engine/target/release/my-engine"
  echo "使用已编译引擎: $ENGINE"
fi

# c) 从源码编译（Pi 是 ARM，Mac 的 x86_64 二进制跑不了，必须本地编译）
if [ -z "$ENGINE" ]; then
  if [ -f "$WORKER_DIR/my-engine/Cargo.toml" ]; then
    echo "从源码编译 my-engine（Pi 上可能需要几分钟）..."
    if ! command -v cargo >/dev/null 2>&1; then
      echo "未找到 cargo，安装 Rust 工具链..."
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
      # shellcheck disable=SC1091
      source "$HOME/.cargo/env"
    fi
    (cd "$WORKER_DIR/my-engine" && cargo build --release) || { echo "编译失败"; exit 1; }
    ENGINE="$WORKER_DIR/my-engine/target/release/my-engine"
  else
    echo "错误：既无 my-engine 二进制也无源码。请先部署 star 项目或把 my-engine/ 源码放到 $WORKER_DIR。"
    exit 1
  fi
fi
echo "引擎路径: $ENGINE"

# ── 2. 安装 python-chess（兼容 Debian/Ubuntu PEP 668）────────
echo "确保 python-chess 已安装..."
if ! python3 -c "import chess" 2>/dev/null; then
  # 策略 1: apt（Debian/Ubuntu 系统包，需要 sudo）
  if command -v apt-get >/dev/null 2>&1; then
    echo "尝试通过 apt 安装 python3-chess（可能需要 sudo）..."
    sudo apt-get update -qq && sudo apt-get install -y -qq python3-chess 2>/dev/null \
      || { echo "apt 失败，尝试 pip --break-system-packages..."; }
  fi
  # 策略 2: pip（带 --break-system-packages 绕过 PEP 668）
  if ! python3 -c "import chess" 2>/dev/null; then
    python3 -m pip install --break-system-packages chess 2>/dev/null \
      || python3 -m pip install --user chess 2>/dev/null \
      || pip3 install --break-system-packages chess 2>/dev/null \
      || { echo "错误: 无法安装 python-chess。请手动执行: sudo apt install python3-chess"; exit 1; }
  fi
fi
echo "python-chess OK: $(python3 -c 'import chess; print(chess.__version__)')"

# ── 3. 跑自对弈 ─────────────────────────────────────────
OUT_DIR="$WORKER_DIR/data_pi"
mkdir -p "$OUT_DIR"
echo "开始自对弈: $GAMES 局 ..."
python3 "$WORKER_DIR/dataset_gen.py" \
  --engine "$ENGINE" \
  --selfplay "$GAMES" \
  --depth "$DEPTH" \
  --movetime "$MOVETIME" \
  --max-plies "$MAX_PLIES" \
  --output-dir "$OUT_DIR" || { echo "自对弈运行失败"; exit 1; }

echo "完成。输出: $OUT_DIR/selfplay.jsonl"
ls -la "$OUT_DIR"
