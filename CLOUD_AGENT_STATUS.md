# 云端 Agent 状态速查（新对话必读）

> 用途：CNB 云端工作区会随会话关闭；本文件记录**当前进度 / 已完成 / 下一步**，让下一段新对话的 agent 30 秒内接上。
> 更新方式：每完成一步（训练/ETL/对局/实验/重要改动）**立即更新本文件并 commit+push**，与代码/结果同仓库。
> 维护规则：云端 agent 每段对话开工前先读本文件 + `WORKING_PRINCIPLES.md` + `.workbuddy/memory/MEMORY.md`（最新）。

---

## 一、工作模式（2026-08-20 用户明确，取代旧分工）

- **我就是 CNB 云端 agent**（Linux `/workspace` 环境，8 核 / 16GB）。
- **不再生成 `cnb_*.md` 云端提示词**交给别的 agent；长任务（训练、大规模对弈、打标签、ETL）**直接在本环境自己跑完**。
- 跑完仍按规范 **commit + push 结果文件**，并把关键输出（统计 JSON / corr / Elo / commit hash）**贴回复**。
- `cnb_*.md` 旧提示词文件保留作历史档案，不再新增；新任务直接在对话里执行。
- ⚠️ 本地（Mac）那边仍可能并行改代码；云端跑实验期间**避免本地 push CNB**（会 non-fast-forward 冲突），沿用 `WORKING_PRINCIPLES.md` 第六节 git 协作。

## 二、实验验证铁律（9 连败换来的，最高优先级）

- 影响「走法排序 / eval / 剪枝」的改动 **只能对局验证（500+ 局）**，不能用 loss / val_top1 / corr / 节点数做代理；corr 只是**预筛**（省钱），不是结论。
- 小样本 Elo 不可信（96 局 +47 都可能是噪声）。
- 不能用「理论分析」判定某处是 bug / 优化（TT age / IID 教训）。
- 对弈：`concurrency × Threads ≤ 物理核数`（本机 8 核）。
- 已封板方向（勿重试）见 `AGENTS.md` 第六节 + `MEMORY.md`：数据/评估侧 7 连败 + 搜索侧 2 连败；**唯一净收益 = Lazy SMP +51 Elo（v2_smp，已部署树莓派）**。

## 三、当前进度

> ⚡ 最新：M6/MCTS iter2: 回滚；门禁 cand 得分 0.375 (回滚)


> ⚡ 最新：**BiaoZi MCTS（AlphaZero 式）P0/P1 完成**——Rust 自博弈 crate + Python 推理/训练器 + rl_mcts.py 断点续跑主循环已落地并通过本地全链路冒烟（自博弈→训练→门禁→git 落盘）。**下一步 = 云端开跑 v1 战役**：
> ```
> cd /workspace && git fetch origin && git reset --hard origin/main
> pip install --break-system-packages torch --index-url https://download.pytorch.org/whl/cpu
> cargo build --release --manifest-path mcts/Cargo.toml
> python3 rl_mcts.py --session-hours 16 --workers 6 --games-per-iter 1500 \
>     --playouts 300 --steps 4000 --gate-games 200 --bench-every 3 --bench-games 200
> ```
> 每轮迭代自动落盘+push；会话被杀后重开会话重跑同一命令即断点续跑。
> 预算：每 18h 会话约 2-3 个迭代；预计第 3-5 个会话出强度拐点。门禁≥55% 晋级；vs 手写eval 500 局铁律定论。


## 四、环境速查（云端 /workspace）
- 8 核 / 16GB 内存；`cargo` 可用；Python 3.12。
- ⚠️ **torch 未装**（训练需 `pip install --break-system-packages torch --index-url https://download.pytorch.org/whl/cpu`）；numpy 已装（`--break-system-packages`）。
- 大二进制（`data_0000.parquet` 2.1GB / `*.scnn` / `*.bin`）不进 git（.gitignore）。
- 结果文件（统计 json / pgn / 评测报告）必须 `git add` + commit + push，否则会话关闭即丢失。

## 五、本文件维护
- 每次有进展**立即改「三、当前进度」对应行 + commit**（与结果文件同 commit）。
- 新对话 agent：读本文件 → 按「下一步」继续，无需重新考古。
