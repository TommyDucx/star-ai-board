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

> ⚡ 最新：M6/MCTS iter1: 回滚；门禁 cand 得分 0.500 (回滚)


### 3.1 技术路线
- **handcrafted/**（生产路线）：手写 eval + α-β + Lazy SMP，= v2_smp，已部署树莓派（http://192.168.0.107:8765）。**已封板，不再投入。**
- **nnue/**（实验路线）：NNUE 增量推理。当前推进到 **M6（HalfKP 王桶耦合特征）**。

### 3.2 NNUE 里程碑一览（详见 `cnb_nnue_incremental_design.md`）
| 里程碑 | 状态 | 结论 |
|---|---|---|
| M0–M2 数据管线 | ✅ | HF Lichess → parquet_dump.py → data-etl(HalfK-768 .scnn) → train_nnue.py；5.66M 唯一局面 |
| M3 静态 CNN 接入 | ✅ | nnue.rs 静态推理 + UCI `Eval` 开关 + golden PASS |
| M4 静态对局 | ✅ 完成，❌ 结论 | pilot **0-40**（静态 eval ~100x 慢 → 深度塌陷），**静态 CNN 封板** |
| M5 增量推理 | ✅ 完成，❌ 结论 | nnue.rs v2 增量累加器 + golden 0 diff；corr 0.75（HF 200 万）→ pilot **4-36**（仍输 381 Elo）。引擎本体正确，**eval 质量是瓶颈**，判定 **fixed-color HalfK-768（无王格耦合）= 架构硬瓶颈** |
| M6 HalfKP 王桶 | 🔄 **进行中（数据侧已出，结论待汇报）** | 见下 |

### 3.3 M6 HalfKP 现状（关键，下一步从这里接）
- **已实现**：`data-etl/src/halfkp.rs`（王桶 B=32，每桶 704 槽 = us 白非王 320 + them 黑含王 384，特征空间 22528）+ `train_nnue_halfkp.py`（稀疏 → acc128 → 32→32→1，标签 eval_white）。
- **HEAD** = `67ebb8f` `fix(M6): HalfKP 标签视角 bug —— halfkp 强制 eval_white`。
- **已跑（未汇报）**：用修复后 HEAD 重训完 HalfKP（5M 样本源，`data/nnue/train_hkp.scnn`），产出 `my-engine/policy/nnue_hkp.bin`（version=3，2,888,929 参数，~11.6MB）+ `policy_nnue_hkp.pt`。
- **⚠️ 缺口**：修复后**新 corr 未知**（第一次 buggy 标签跑出 corr 0.21 已作废）。`nnue_hkp.bin` 存在但**质量未评估、未 commit**。
- **下一步（按序）**：
  1. 评估 `nnue_hkp.bin` 的 val **corr**（复现 train_nnue_halfkp.py 的 val 划分：seed=42 / 前 5M / 5% val；sigmoid 空间相关性）。
  2. 决策门：**corr > 0.80** → 投入引擎集成（nnue.rs v3 读 version=3 + search.rs 王桶边界 / 白王换桶全量重算）；**corr ≤ 0.75** → 王格耦合没救回，停，待指示。
  3. corr 达标才做引擎集成 + golden test（PyTorch vs Rust 逐位）+ pilot 40 局（看深度是否恢复）。
- 参考对比：M5 HalfK 200 万 corr=0.75；M6 目标 >0.80。

## 四、环境速查（云端 /workspace）
- 8 核 / 16GB 内存；`cargo` 可用；Python 3.12。
- ⚠️ **torch 未装**（训练需 `pip install --break-system-packages torch --index-url https://download.pytorch.org/whl/cpu`）；numpy 已装（`--break-system-packages`）。
- 大二进制（`data_0000.parquet` 2.1GB / `*.scnn` / `*.bin`）不进 git（.gitignore）。
- 结果文件（统计 json / pgn / 评测报告）必须 `git add` + commit + push，否则会话关闭即丢失。

## 五、本文件维护
- 每次有进展**立即改「三、当前进度」对应行 + commit**（与结果文件同 commit）。
- 新对话 agent：读本文件 → 按「下一步」继续，无需重新考古。
