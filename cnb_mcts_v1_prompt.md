# BiaoZi MCTS v1 战役（AlphaZero 式自博弈 RL）—— CNB 云 agent 提示词

你是一个国际象棋引擎开发助手。请在云环境（Linux，8 核/16GB）执行 **BiaoZi MCTS 的 v1 训练战役**：用 `rl_mcts.py` 主循环连续跑「自博弈 → 训练 → 门禁赛 → 基准赛」迭代，会话时长上限 18 小时（脚本会在 16 小时自然收尾落盘）。

## 背景

本地已完成 P0/P1（代码见仓库 `mcts/` + `rl_mcts.py`，HEAD 已含全部代码）：
- `mcts/` Rust crate：MCTS（PUCT + Dirichlet + 温度）+ 自博弈 worker + UCI 封装；推理走 Python 子进程（JSON 行协议）。
- `mcts/py/train_mcts.py`：AzNet（ResNet 4×96 双头，2.44M 参数）训练器。
- `rl_mcts.py`：迭代主循环——每轮自动「自博弈(6 workers) → 训练 → 门禁赛(候选 vs 现任 ≥55% 晋级) → 每 3 轮 vs 手写eval 基准赛」，**每轮结束自动 git commit+push**，支持断点续跑。
- 本地已通过端到端冒烟（自博弈→训练→门禁→git 落盘全链路 OK）。

**预期节奏（如实认知，不要慌）**：早期网络弱、对局长，一个迭代约 4–7 小时，本会话预计完成 **2–3 个迭代**。这是正常的。

## ⚠️ 约束
1. **只用仓库自带脚本**（`rl_mcts.py` / `mcts/py/*` / `match.py`），禁止自造脚本、禁止改任何代码与参数。
2. 只跑下面指定的命令。主循环自己管理时间（16h 自动收尾），你只负责启动、巡检、收尾汇报。
3. **主循环每轮自动 commit+push**——战役期间你不要手动 push（避免冲突）；会话结束前确认最后一次迭代已 push。
4. 若进程意外死亡：直接重跑第 5 步的同一条命令即可断点续跑（从 `run/manifest.json` 接上）。
5. 拉取方式：`git fetch origin && git reset --hard origin/main` 并确认 HEAD。

## 第 0 步：拉取代码
```bash
cd /workspace
git fetch origin && git reset --hard origin/main
git log --oneline -1    # 应显示 e582e37 或其之后（含 mcts/ 与 rl_mcts.py）
ls mcts/src/lib.rs rl_mcts.py
```

## 第 1 步：环境准备
```bash
# Rust（若工作区已清）
curl https://sh.rustup.rs -sSf | sh -s -- -y && source ~/.cargo/env
# Python 依赖
pip install --break-system-packages torch --index-url https://download.pytorch.org/whl/cpu
pip install --break-system-packages numpy python-chess
```

## 第 2 步：编译（MCTS crate + 手写eval 基准引擎）
```bash
cd /workspace
cargo build --release --manifest-path mcts/Cargo.toml
cargo build --release --manifest-path my-engine/handcrafted/Cargo.toml
ls -la mcts/target/release/mcts-selfplay mcts/target/release/mcts-uci \
       my-engine/handcrafted/target/release/my-engine
```

## 第 3 步：冒烟验证（~10 分钟，必做）
```bash
cd /workspace
python3 rl_mcts.py --iterations-max 1 --games-per-iter 4 --workers 2 \
  --playouts 12 --steps 20 --gate-games 4 --bench-games 0 --session-hours 0.3
```
**通过标准**：日志出现「===== 迭代 1 =====」且最终打印 `[session] 会话结束`，无报错。
> 通过后**清掉冒烟产物再开正式战役**（避免污染 manifest）：
> ```bash
> rm -rf run/
> ```
> 若冒烟失败：贴完整日志回来，**不要启动正式战役**。

## 第 4 步：启动正式战役（后台运行 + 巡检）
```bash
cd /workspace
mkdir -p run
nohup python3 rl_mcts.py --session-hours 16 --workers 6 \
  --games-per-iter 1500 --playouts 300 --steps 4000 \
  --gate-games 200 --bench-every 3 --bench-games 200 \
  > run/session.log 2>&1 &
echo $! > run/session.pid
sleep 60 && tail -20 run/session.log    # 确认进入「===== 迭代 1 =====」
```
**巡检规则**：之后每 30–60 分钟检查一次：
```bash
ps -p $(cat run/session.pid) >/dev/null && echo ALIVE || echo DEAD
tail -30 run/session.log
cat run/manifest.json
```
- 进程 ALIVE 且日志在推进 → 继续等，不要干预。
- 进程 DEAD 且日志末尾是 `[session] 会话结束` → 正常收尾，跳到第 6 步。
- 进程 DEAD 但没有「会话结束」→ 意外崩溃：把 `run/samples/worker*.log` 尾部贴回来，然后**重跑第 4 步同一条命令**（自动断点续跑）。

## 第 5 步：会话收尾
脚本在 16 小时自动停止（留 2h 余量给系统）。进程退出后：
```bash
cd /workspace
cat run/manifest.json
ls run/bench/
git log --oneline -5
# 确认最后一次迭代已 push（脚本每轮自动 push 过）；若有未推送残留：
git add -A run/ CLOUD_AGENT_STATUS.md && git commit -m "rl(mcts): 会话收尾" && git push origin main
```

## 第 6 步：汇报（贴回复里）
1. HEAD 确认 + 编译结果；
2. 冒烟是否通过；
3. 本会话完成的迭代数、每轮门禁得分（晋级/回滚）；
4. 基准赛曲线（vs 手写eval 的 JSON：handcrafted/mcts 胜场数、elo_diff）；
5. `run/manifest.json` 内容；
6. 最新 commit hash；
7. 异常事件（worker 崩溃日志尾部、重启次数）。

## 决策门说明（自动处理，无需你判断）
- 门禁 ≥55%：候选晋级为 best；否则回滚保留 best（早期多轮回滚是正常动态）。
- 曲线平台期或连续多次回滚 → 如实汇报即可，由本地决定加容量/加 playouts/封板。
- 铁律提醒：**对外强度结论一律以 vs 手写eval 500 局为准**（那是后续会话的事）；本战役的曲线只是趋势观测。

## 环境说明
- 8 核分配：6 个自博弈 worker + 推理各 2 torch 线程（脚本内部已设 AZ_THREADS=2）。
- 大文件策略：对局档案 `run/games/*.jsonl.gz`（几 MB/轮）与网络 `run/nets/*.pt`（~10MB）随每轮自动入库；`run/samples/` 不入库。
- 会话若中途被云平台强杀：已完成的迭代都已 push；新开会话重跑第 0→4 步即续跑。
