# WORKING_PRINCIPLES —— 本地 agent ↔ 云 agent 协作规范

> 用途：明确「我（本地 agent）」与「CNB 云 agent」的分工边界、什么时候只写提示词、什么时候本地跑，避免重复踩坑。
> 来源：2026-08-14 ~ 08-19 项目实战总结（含 9 连败换来的铁律）。

---

## 一、核心分工（用户 2026-08-14 明确）

| 角色 | 职责 |
|---|---|
| **本地 agent（我）** | **只改代码、调参数、写/改脚本**；短时验证（编译、冒烟、小样本）|
| **CNB 云 agent** | **跑所有长时间实验**：训练（Policy / NNUE / Texel 调参）、大规模自对弈、96/400+ 局对弈验证、大规模数据打标签 |

**根本原因**：本地沙箱会在 agent 回合结束后**终止所有后台子进程**（连 `nohup` 启动的都被清理）。因此任何"跑几分钟以上"的任务都无法在本地完成，必须交云 agent；或者用「当前回合内阻塞等待」跑完小规模任务（约 <30 分钟）。

## 二、本地能做什么 / 不能做什么

### ✅ 本地做（回合内可完成 + 不超沙箱限制）
- 改代码、调参数、写/改脚本（`eval.rs` / `search.rs` / `*.py`）
- 编译（`cargo build --release`）、冒烟测试（UCI 走子 / `bestmove` 正常）
- 小样本脚本验证（秒级~分钟级，如 5000 条数据跑通逻辑）
- 数据下载（网络通时）、git commit（仅本地）、文件处理、golden test

### ❌ 本地不做（交云 agent）
- **训练**：Policy 重训、NNUE 训练、Texel 调参（全量）
- **大规模数据**：自对弈、打标签、对弈验证（96/400 局）
- **超内存任务**：本地约 5 万条 FEN 特征提取就 OOM（exit 137）→ 大数据处理必须云 agent
- **依赖特定软件**：如 Stockfish 18 在本地沙箱跑不了（shared memory 被限制，搜索返回空走法 `bestmove a2a3`），需云 agent 的 Linux 环境

## 三、云 agent 提示词模板要求（项目根 `cnb_*.md`）

**每个提示词必须包含以下 5 点**（缺一不可）：

1. **「跑完 commit+push 结果文件」**——否则结果随云工作区关闭丢失（第一轮 RL 丢过一次的教训：工作区关闭后只残留文件清单元数据，实际内容没了）。
2. **「禁止自造脚本」**——只准用仓库自带脚本（云 agent 曾自造 `rl_supervisor.py`/`rl_watcher.sh` 偏离标准流程，还提交了 `__pycache__` 垃圾）。
3. **「只跑指定轮次/参数」**——不要额外实验、不要改参数（云 agent 曾偷偷多跑轮次）。
4. **「结果贴回复里」**——把关键输出（JSON、统计、commit hash）贴回，方便本地分析。
5. **拉取方式**——`git fetch origin && git reset --hard origin/main`，并确认 HEAD 是预期的 commit。

## 四、实验验证铁律（9 连败换来的，不可违反）

- 任何影响「**走法排序 / eval / 剪枝**」的改动，**只能用对局验证（500+ 局）**，不能用 loss / val_top1 / 节点数做代理。
- **小样本 Elo 不可信**：96 局的 +47 Elo（LOS 93.7%）在 400 局下未复现，实测 −6；小样本正负都可能纯属噪声。
- **不能用「理论分析」判定某处是 bug/优化**：TT age 教训——把「迭代加深每次换代」的**特性**（清旧促新）当 bug 改掉，实测 −38.4 Elo。
- 云 agent 对弈验证：`concurrency × Threads ≤ 物理核数`，否则线程争抢污染测量。

## 五、已封板方向（勿重试，详见 AGENTS.md 第六节）

- **数据侧/评估侧 7 连败**：残差 CNN+加权 −40 / LMP+futility −69.7 / SF 教师标签 −34.9 / αβ 蒸馏 −34.9 / deep 自洽 −6.1 / Texel(self-play) −61.4 / Texel(CCRL+冻结) −110.4。
- **搜索侧精细化 2 连败**：IID −20 / TT age −38.4。
- **唯一净收益 = Lazy SMP 多线程 +51 Elo**（v2_smp，已部署树莓派）。
- **NNUE 是长期方向**：数据管线 M0–M2 已跑通（HF Lichess SF 评估 → data-etl → HalfK-768 .scnn → train_nnue.py），下一步 M3 引擎集成。此前的"静态 eval 拟合对局结果"范式全部失败，NNUE 必须用「搜索后 eval 标签」范式。

## 六、git 协作原则

- **本地 commit 不影响云 agent**（可随时做）。
- **云 agent 跑实验期间，本地避免 push CNB**——push 会让 CNB main 前进，云 agent 跑完 `git push` 会 non-fast-forward 冲突。改为：本地先 commit 暂存，云 agent push 后本地 `git pull --rebase cnb main` 合并，再统一 push。
- GitHub push 用代理：`export http_proxy=http://127.0.0.1:1087; export https_proxy=http://127.0.0.1:1087`（直连失败/超时）。
- ⚠️ 凭据一律走环境变量/本机凭据存储，**禁止写回 AGENTS.md / 提示词 / 任何仓库文件**（明文 PAT 会被 GitHub secret scanning 发现并自动吊销）。

## 七、环境速查

| 项 | 说明 |
|---|---|
| 本地沙箱后台任务 | 回合结束即被杀（连 nohup 也逃不掉）→ 长任务必须交云 agent |
| 本地内存 | 有限（~5 万条 FEN 特征 OOM）→ 大数据处理交云 agent |
| Stockfish 18 | 本地跑不了（shared memory 限制）；云 agent Linux 正常 |
| 本地代理 | `http://127.0.0.1:1087`（GitHub 等外网专用）|
| 云 agent 模板 | 项目根 `cnb_*.md`（cnb_rl / cnb_search / cnb_texel / cnb_eval_labels ...）|
| 项目长期记忆 | `.workbuddy/memory/`（日志 + MEMORY.md）|
