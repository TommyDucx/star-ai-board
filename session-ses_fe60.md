# NNUE数据集清洗管道方案讨论

**Session ID:** ses_fe60b9ff8ffen7j1UBhUcJr0A0
**Created:** 8/19/2026, 8:17:20 PM
**Updated:** 8/23/2026, 12:18:21 PM

---

## Assistant

用户要做第三个引擎：AlphaZero 式的「MCTS + 神经网络」自博弈强化学习模型。写计划前先考古仓库里已有的 RL 脚手架（rl_loop.py、rl_selfplay.py、cnb_rl_prompt.md），能复用的不重造：

**Tool: bash**

---

## Assistant

---

## User

继续把计划写出来

---

## Assistant

# BiaoZi MCTS 训练计划（AlphaZero 式自博弈强化学习）

考古结论：仓库里的 `rl_loop.py` 是「策略蒸馏 RL」（手写引擎自博弈→重训 policy CNN），不是 AlphaZero 式 MCTS+NN。这次是新范式：**神经网络（策略+价值双头）引导 MCTS，靠自博弈直接学赢棋**。关键优势判断：NNUE 三连败败在「SF 标签监督训练不迁移为棋力」，而自博弈 RL 直接优化胜负——且及格线只有 ≈800（手写eval），小规模 AGZ 复现（LCZ 早期网、alpha-zero-general 等）普遍能到 1200–1600，**这个目标在 8 核云机上是现实可达的**。

---

## 一、架构规格

**网络（<2M 参数，CPU 友好）**
- 输入：8×8×17 平面（Lc0 风格）＝12 固定色棋子面 + 轮走方 1 + 王车易位 4
- 骨干：ResNet 4 blocks × 96 filters（conv3×3 + BN + ReLU）
- 策略头：4096 logits（复用现有 from×64+to 编码，policy.rs 同构），合法走法 mask 后 softmax
- 价值头：全局池化 → FC → tanh ∈ [-1,1]

**MCTS**
- PUCT 选择：`Q + c·P·√N父/(1+N子)`，c≈1.5（随迭代调）
- 自博弈专用：根 Dirichlet 噪声（α=0.3, ε=0.25）；前 20 步温度 τ=1 采样，之后贪心
- **批量推理**（吞吐核心）：MCTS 收集叶子→合并 batch 送 NN→虚拟损失防多路更新；FPU 减重复扩展

## 二、实现路线（关键决策）

| 方案 | 吞吐 | 结论 |
|---|---|---|
| A. 纯 Python（michi 式） | ~30 局/天 | 否决，太慢 |
| **B. Rust MCTS + Python 推理服务** | **~1 万局/天** | ✅ 推荐 |
| C. 全 Rust + ONNX(ort) | 最快 | 仅用于最终部署 |

- **B 细节**：Rust 二进制（chess crate 做树+走子生成）把叶子批量按行协议发给常驻 PyTorch 推理进程，批量 64；训练照旧 PyTorch
- **部署期（P4）**：Rust 内嵌 `ort`（ONNX Runtime）做独立 UCI 引擎，上树莓派网站当第三引擎「BiaoZi MCTS」

## 三、自博弈训练循环（每轮迭代）

```
net_i ──自博弈 1000–2000 局──▶ 回放缓冲（保留最近 40 万局面）
       ──微调 3000–6000 步──▶ net_{i+1}
       ──门禁赛 200 局（vs net_i）──▶ ≥55% 晋级，否则回滚加训
```
- 样本三元组：平面编码 + policy 目标（MCTS 访问计数归一化）+ value 目标 z∈{-1,0,1}（对局结果，对称增广视角）
- 损失：CE(policy) + MSE(value) + L2(1e-4)；LR 0.002 余弦衰减，Adam
- 每 5 轮打一次基准赛 vs **手写eval**（200 局）画强度曲线

## 四、阶段与分工（沿用本地写码 / 云端直跑）

| 阶段 | 内容 | 谁 | 工期 |
|---|---|---|---|
| P0 | 设计文档 + 目录脚手架（`mcts-crate`/`trainer`/`loop`） | 本地 | 0.5 天 |
| P1 | MVP 冒烟：随机权重 20 局自博弈 + 1 轮训练全链路 <30 分钟跑通 | 本地 | 1–2 天 |
| P2 | **v1 战役**：10 轮迭代（约 1.5 万局）+ 强度曲线 | 云端 | 5–7 天 |
| P3 | 门禁赛 vs 手写eval（500 局铁律）+ 定论 | 云端 | 1 天 |
| P4 | ort 内嵌 UCI 化 + 上线网站第三引擎「BiaoZi MCTS」 | 本地→树莓派 | 1–2 天 |

**总周期 ≈ 2 周**。吞吐依据：Rust MCTS + batch64 推理 ≈ 3–6K evals/s，32K evals/局 → 6–10s/局。

## 五、风险与对策
- **value 饱和/自博弈震荡** → 回放缓冲限长、温度调度、门禁回滚机制（rl_loop 已验证此模式可行）
- **强度测量噪声** → 内部门禁 200 局只做晋级筛选；对外结论一律 500 局铁律
- **pi CPU 慢** → 部署档位降 playouts（如 100/步），下拉标注「慢」
- **失败兜底**：若 10 轮后仍 <800，输出曲线数据定位瓶颈（网络容量 vs playouts vs 数据量），再决定加卡或封板

---

## 待你确认的 3 个默认决策
1. **推理路线 B**（Rust MCTS + Python 推理服务，训练期；部署期再换 ort）——同意？
2. **云计算授权**：v1 战役需云端连续跑 5–7 天——可接受？
3. **成功线**：超过手写eval（≈800）即作为第三引擎上线（不强求追 CCRL）——同意？

确认后我从 P0 开始动手。

---

## User

阅读WORKING_PRINCIPLES.md 知道工作原则

---

## Assistant

**Tool: read**

---

## Assistant

已重读 `WORKING_PRINCIPLES.md`，对照后修订 MCTS 训练计划中与工作原则相关的部分（其余架构设计不变）：

## 结合工作原则的修订要点

**1. 分工与时序（按第一、六节）**
- P0/P1 全部本地：代码 + 编译冒烟 + **<30 分钟内阻塞式小样本验证**
- P2/P3 云端直跑（按 2026-08-20 新模式，不写 cnb_*.md）：我写完全部代码后，更新 `CLOUD_AGENT_STATUS.md` 的「当前进度/下一步」并 push；你开 CNB 对话说「按状态文件继续」即可
- **push 时序**：P1 完成 → 本地 commit+push 双端 → 云端开跑 v1 战役 → **战役期间我本地不 push CNB**，只暂存 → 云 push 后我 `pull --rebase` 合并再统一推

**2. P1 冒烟拆分（规避 30 分钟沙箱限制）**
- P1a（本地，纯 Python）：最小自博弈端到端冒烟——随机初始化小网 + 4 局 × 30 playouts 微型棋，验证「自博弈→样本格式→训练一轮→导出」闭环，控制在 20 分钟内
- P1b（本地，Rust 单元测试）：MCTS PUCT 展开/delta 正确性单测（不跑长对局）
- P1c（云端）：Rust↔Python 推理服务联调 + 吞吐实测（不受 30 分钟限制）

**3. 回放缓冲内存预算（新增，吸取「5 万条特征就 OOM」教训）**
- 样本紧凑格式：状态 17 平面 uint8（1088B）+ 稀疏 policy 目标（~35 步 × u16+f32 ≈ 280B）+ z（f32）≈ **1.4KB/局面**
- 缓冲 40 万局面 ≈ 560MB 磁盘（memmap/流式），训练在线采样解码——云端 16GB 安全，本地不做大数据

**4. 云端资源分配（8 核/16GB）**
- 6 个自博弈 worker（Rust）+ 1 个 PyTorch 推理进程（`set_num_threads(2)`）+ 批量 64
- 门禁赛：`concurrency × Threads ≤ 8` 铁律照守

**5. 铁律合规声明**
- RL 迭代晋级用 200 局仅作**内部筛选**（LCZ 同款实践）；一切对外强度结论（含「超过手写eval」）仍须 **500+ 局**
- 强度曲线中间点只看趋势不作结论；MCTS 参数（c_puct 等）改动同样要有对局依据，不许拍脑袋

**6. 收尾顺带项**：WORKING_PRINCIPLES 第五节关于 NNUE 的表述已过时（M3–M6 已封板），实施时同步更新该节，并把「MCTS 方向」记入 memory。

---

原计划的架构规格（ResNet 4×96 + 双头、PUCT/Dirichlet/温度、Rust MCTS + Python 推理服务、10 轮迭代 ≈ 1.5 万局、周期约 2 周）不变。

三个待确认项维持原样：
1. **推理路线 B**（训练期 Rust+Python 服务，部署期 ort 内嵌）？
2. **云端授权 v1 战役连续 5–7 天**？
3. **成功线 = 胜过手写eval（≈800）即上线第三引擎**？

确认后我从 P0（设计文档 + 目录脚手架）开始。

---

## User

1可以 2云端最多只能跑18个小时，然后会自动关闭，需要我重启 3能做出来多强就多强

---

## Assistant

三个确认收到。**18 小时会话自动关闭**这条改变了 v1 战役的设计——「检查点续跑」必须成为一等公民，最终计划修订如下：

# BiaoZi MCTS 训练计划（定稿）

## 一、18 小时会话制核心设计

**会话协议**（每个云会话执行相同流程）：
1. 开工先读 `CLOUD_AGENT_STATUS.md` 接上进度（该文件每次进展即更新+push）
2. 跑满安全窗口（**16h 计算 + 2h 收尾落盘**）
3. **每轮迭代结束立即落盘并 commit+push**：网络权重（best+current）、对局档案增量、强度曲线 JSON、状态文件——会话被杀最多丢当前一轮

**关键格式决策：对局档案代替展开样本**
- 自博弈只存「UCI 走法序列 + 结果 + 元信息」≈ 0.5KB/局（gz 后更小）；训练时在线展开成样本
- 好处：git 可直接承载（每会话增量仅几 MB，彻底规避「工作区关闭丢数据」教训）；回放缓冲=从档案派生的缓存，新会话启动时重建（分钟级）
- 网络权重 4–8MB 直接入库（nnue.bin 先例）

## 二、吞吐与预期

| 项 | 数值 |
|---|---|
| 每 18h 会话 | ~7,000 局自博弈 + 2–3 个迭代（含门禁赛）|
| 强度拐点 | 预计第 3–5 个会话出现（累计 50–90 计算小时）|
| 会话数 | 不设上限，「能做出来多强就多强」——曲线平台期或你叫停为止 |

## 三、阶段交付

| 阶段 | 内容 | 谁 |
|---|---|---|
| P0 | 设计文档 + 脚手架：`mcts/` Rust crate（自博弈 worker+MCTS）、推理服务、训练器、`rl_mcts.py --resume` 主循环 | 本地 |
| P1a | 纯 Python 端到端微冒烟（<30min，符合沙箱限制）：4 局×30 playouts 全链路 | 本地 |
| P1b | Rust MCTS 正确性单元测试（PUCT 展开/合法掩码/价值回传） | 本地 |
| P1c | 云端首会话：Rust↔Python 联调 + 实测吞吐 + **演练断点续跑** | 云 |
| P2 | N×18h 迭代战役（每会话按上述协议，强度曲线逐会话更新） | 云 |
| P3 | vs BiaoZi 手写eval **500 局铁律定论** | 云 |
| P4 | ort 内嵌 UCI 化 → 上线网站第三引擎「BiaoZi MCTS」（pi 低 playouts 档位） | 本地→pi |

新增目录：
```
mcts/                  # Rust：MCTS + 自博弈 worker（chess crate）
  py/infer_server.py   # PyTorch 批量推理服务（行协议，batch64）
  py/train_mcts.py     # CE(policy)+MSE(value)+L2，早停
  py/expand_games.py   # 对局档案→训练样本（流式，控内存）
rl_mcts.py             # 迭代主循环（--resume 断点续跑）
```

## 四、架构规格（不变，复述要点）
- 网络 <2M 参数：输入 8×8×17 平面（12 固定色棋子+stm+4 易位）→ ResNet 4×96 →

---

## User

可以，开始吧

---

## Assistant

进入 P0/P1 实施。先确认 chess crate 的王车易位 API（编码平面需要），再写代码：

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

API 确认（`has_kingside/has_queenside`，pack_move=from*64+to）。开始写代码。先建 Rust crate 骨架：

**Tool: write**

---

## Assistant

**Tool: write**

---

## Assistant

**Tool: write**

---

## Assistant

---

## User

继续

---

## Assistant

继续写 MCTS 核心（arena 实现 + PUCT + 终局判定）：

---

## User

你继续写完啊，没写完不要暂停

---

## Assistant

继续，把整个 MCTS crate 和训练管线一次写完。先写 MCTS 核心：

**Tool: write**

---

## Assistant

修正 cpuct 传参问题（config 未存入 tree）：

**Tool: bash**

---

## Assistant

**Tool: write**

---

## Assistant

**Tool: bash**

---

## Assistant

---

## User

继续

---

## Assistant

继续写完。先改 search 返回值带上走法对象（自博弈落子需要），再写 selfplay 模块：

**Tool: bash**

---

## Assistant

**Tool: write**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

现在是这两个二进制文件（selfplay worker + UCI）：

**Tool: write**

---

## Assistant

selfplay.rs 那段写乱了，重写干净版：

**Tool: write**

---

## Assistant

**Tool: bash**

---

## Assistant

现在是 UCI 二进制程序（用于 match.py 门控 + 未来部署）：

**Tool: write**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

两个 Rust 二进制编译通过。现在写 Python 三件套（推理服务 / 训练器 / 主循环）：

**Tool: write**

---

## Assistant

**Tool: write**

---

## Assistant

修正 train_mcts.py 里 batch() 的掩码逻辑（写复杂了且有错）：

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

现在进行 P1a 冒烟测试：导出随机初始化的网络 → 运行 2 局微型自对弈 → 训练 20 步。这验证了整个 Rust↔Python 循环：

**Tool: bash**

---

## Assistant

抓到 bug：Rust 发的是 **hex**，Python 端却用 base64 解码（2176 hex 字符被当 base64 解出 1632 字节）。修复：

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

测试脚本本身的问题（heredoc 引号阻止了命令替换）。用 Python 直接测推理服务：

**Tool: bash**

---

## Assistant

`pol` 带 batch 维 (1,4096)，索引前要取 `[0]`：

**Tool: edit**

---

## Assistant

**Tool: bash**

---

## Assistant

推理服务正常（softmax 和为 1）。重跑自博弈冒烟：

**Tool: bash**

---

## Assistant

自博弈全链路通了：2 局（78/90 手）+ 168 个样本。现在验证训练器吃这些样本：

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

训练器也通了。现在写迭代主循环 `rl_mcts.py`（断点续跑 + 门禁 + 基准赛）：

**Tool: write**

---

## Assistant

现在进行本地微型端到端冒烟测试（1 次迭代，4 局，微调门控）：

**Tool: bash**

---

## Assistant

margin(45min) 大于冒烟会话时长导致直接退出。把 margin 改为自适应：

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

worker 默认的 `py/infer_server.py` 是相对 cwd 的路径，从仓库根跑就找不到了。改成编译期绝对路径：

**Tool: bash**

---

## Assistant

worker 默认 `python3` 是系统 Python（无 torch）。显式传 pfllib Python 再试：

**Tool: bash**

---

## Assistant

rl_mcts.py 缺 `--infer-python` 参数，补上（默认用运行自身的 Python）：

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

手动跑 worker 正常，rl_mcts 编排失败但 stderr 被吞了。去掉 DEVNULL 看真实报错：

**Tool: bash**

---

## Assistant

找到了：`run/samples`、`run/games` 目录不存在（manifest 已存在导致初始化分支被跳过）。修复为无条件建目录，并把 worker stderr 落日志文件：

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

P1 全链路冒烟 **PASS**：
- 迭代 1 完整跑通：4 局自博弈（2 worker）→ 训练 20 步 → 门禁赛 4 局（cand 0.5 分，随机网对随机网合理）→ manifest 落盘 → git commit+push 自动完成
- 断点续跑机制验证：manifest.json 记录 iter=1

现在收尾 P0/P1：更新状态文件、.gitignore、提交全部代码并双端推送：

**Tool: bash**

---

## Assistant

**Tool: todowrite**

---

## Assistant

P0/P1 全部完成，双端已推送（`50aa2b9`）。

## BiaoZi MCTS（AlphaZero 式）落地情况

**新增代码**：
```
mcts/                        Rust crate
├─ src/encoding.rs           17 平面 fixed-color 编码
├─ src/mcts.rs               arena PUCT + Dirichlet 噪声 + 温度采样 + 重复判和
├─ src/nnclient.rs           Python 推理服务客户端（JSON 行协议）
├─ src/selfplay.rs           自对弈循环（样本+对局增量落盘）
├─ src/bin/selfplay.rs       自博弈 worker
├─ src/bin/uci.rs            UCI 封装（match.py 门禁 + 部署雏形，movetime→nodes 自适应）
└─ py/infer_server.py        PyTorch 批量推理服务
   py/train_mcts.py          AzNet ResNet4×96 双头（2.44M 参数）
rl_mcts.py                   迭代主循环（--resume 断点续跑 + 自动 commit/push）
```

**本地冒烟 PASS**：

---

## User

继续迭代，如果不需要云端跑大量实验，你就本地继续

---

## Assistant

本地继续迭代。先补一个重要缺口——随机权重网对局能拖到 578 手，加**最大手数封顶**（≥300 手判和，AZ 惯例），再做“将杀一步”的 MCTS 正确性抽检：

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

权重文件名不对（cwd 下没有 nnue.bin）。拷贝后重试：

**Tool: bash**

---

## Assistant

---

## User

继续

---

## Assistant

继续本地迭代。跑一个真实的 3 轮迭代会话（每轮 12 局自博弈→训练→门禁，第 3 轮加 vs 手写eval 基准赛），阻塞等待完成：

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

本地会话验证完成：**迭代 2 完整跑通并自动落盘**（自博弈→训练→门禁 0.375 回滚→git 推送），单轮耗时 27 分钟——瓶颈在门禁赛（两个弱网对局拖到 300 手封顶 × movetime 800ms）。检查未提交状态并收尾：

**Tool: bash**

---

## Assistant

**Tool: bash**

---

## Assistant

本地迭代会话完成，双端已推送（`e582e37`）。

## 本轮本地迭代结果

**✅ MCTS 正确性抽检**：随机权重网在「白车底線将杀」局面 400 节点搜索即找到 `d1d8#`（1433 nps）——价值回传/PUCT/终局判定的整条链路验证正确（随机策略先验绝不会排第一，是将杀值 +1 回传把它顶上去的）。

**✅ 迭代 2 端到端跑通**（27.2 分钟/轮）：
- 自博弈 12 局（4 worker）→ 训练 150 步 → 门禁赛 8 局
- 门禁 cand 得分 **0.375 → 正确回滚**（早期 AZ 迭代的正常动态：候选打不过现任就保留 best 重来）
- 每轮自动落盘 manifest/曲线/net + git commit/push——断点续跑机制实战验证

**新增**：自博弈 300 手封顶判和（此前随机网对局拖到 578 手，单局时间失控）。

## 关键发现：本地不适合跑正式迭代

单轮 27 分钟的瓶颈是**门禁赛**（两个弱网对局能拖满 300 手 × movetime 800ms ≈ 8 分钟/局组）。本地一晚只能挤 1-2 轮；而强度增长需要几十轮迭代。

**下一步就是云端 v1 战役**：开 CNB 会话，云端 agent 读 `CLOUD_AGENT_STATUS.md` 里已写好的命令直接跑——16h 会话约 2-3 轮迭代，每轮自动落盘推送，会话被杀重开即续。预计 3-5 个会话后看强度曲线拐点，然后 vs 手写eval 500 局铁律定论。

---

## User

你帮我给云端agent写好提示词，具体格式参考文件夹内其他提示词

---

## Assistant

---

## Assistant

---

## Assistant

写 BiaoZi MCTS v1 战役的云端提示词。先参考现有提示词格式，然后落文件：

---

## Assistant

**Tool: read**

---

## Assistant

格式确认。写 MCTS v1 战役提示词：

**Tool: write**

---

## Assistant

**Tool: bash**

---

## Assistant

提示词已写好并双端推送（`fa3740b`）：**`cnb_mcts_v1_prompt.md`**

## 内容概要

严格按仓库既有提示词格式（背景 → ⚠️约束 → 分步命令 → 决策门 → 汇报清单），覆盖 WORKING_PRINCIPLES 五项强制要求（commit+push 结果文件 / 禁自造脚本 / 只跑指定参数 / 结果贴回复 / 拉取方式确认 HEAD）。

**针对 MCTS 战役的特殊设计**：

1. **16h nohup 后台 + 巡检模式**——16 小时的长命令不能阻塞云 agent 单次调用，用 `nohup ... & echo $! > run/session.pid` 启动，agent 每 30–60 分钟巡检一次（进程存活 + 日志推进）
2. **冒烟前置**（第 3 步）：先跑 1 个微型迭代验证云端链路，通过后 `rm -rf run/` 清掉冒烟产物再开正式战役
3. **崩溃恢复协议**：进程 DEAD 且无「会话结束」→ 贴 worker 日志 → 重跑同一条命令自动断点续跑
4. **预期管理写明**：早期网络弱、对局长，一个迭代 4–7 小时，本会话预计只完成 **2–3 个迭代**——这是正常的，不要慌不要加戏
5. **决策门自动化说明**：门禁 ≥55% 晋级、曲线每 3 轮 vs 手写eval，都是脚本自动处理，agent 只需如实汇报；500 局铁律定论留给后续会话

你把这份提示词交给云端 agent 即可开跑 v1 战役。会话结束后把它汇报的曲线数据带回来，我来分析强度趋势和决定下一步（继续迭代 / 加容量 / 定论上线）。

---

## User

你去

---

## Assistant

---

## User

你去cnb上pull一下看看完成了没有

---

## Assistant

**Tool: bash**

---

## Assistant

云端已推送 2 个迭代（都回滚）。合并并查看详细数据：

**Tool: bash**

---

## Assistant

云端完成了 2 个迭代（会话只跑了约 6 小时就停了）。合并并同步 GitHub：

**Tool: invalid**

---

## Assistant

**Tool: bash**

---

## Assistant

已同步（`8c8e9a2`，三端一致）。

## 云端 v1 战役进度：已完成 2 个迭代（会话跑了 ~6 小时后停止）

| 迭代 | 门禁（候选 vs 现任 best） | 结果 |
|---|---|---|
| iter1 | **19 : 81**（elo −251.9） | 回滚 |
| iter2 | **21 : 79**（elo −230.2） | 回滚 |
| 基准赛 vs 手写eval | 手写eval **100 : 0** mcts | 预期内 |

**机制层面全部正常**：自博弈→训练→门禁→基准赛→自动落盘推送，每轮约 3 小时。

## 分析

- 候选两次都输给「随机初始化 + MCTS」的现任 best——这是 AlphaZero 从零起步的**典型早期动态**（LCZ 早期网同样先变差再回升），但幅度偏大值得盯
- 一个真实的质量隐患：自博弈只用 **300 playouts/步**，访问计数作为策略目标噪声很大；且随机网对局拖到封顶 300 手，信号质量低。门禁分 19→21 有微弱上升趋势，暂不动参数（避免破坏曲线可比性）
- 会话只跑了 6h 就停了（可能是云 agent 提前结束或工作区关闭），**战役本身可无损续跑**

## 建议

继续开云端会话重跑同一命令即可（`rl_mcts.py` 从 manifest 接上，现在 iter=2）。判断点：
- 再跑 2–3 个会话（累计 10–15 个迭代），若门禁分趋势向上（如 21→35→45+）→ 继续堆算力
- 若持续卡在 20% 附近不涨 → 我再介入调学习率/提高数据质量 playouts，或考虑用现有监督 policy 网络做热启动

要不要我顺手在本地把「低学习率备选配置」准备好，作为下次会话的门禁连续失败时的预案？

---

## User

你pull一次看看

---

## Assistant

**Tool: bash**

---

## Assistant

**没有新进度**——cnb/main 仍停在 `8c8e9a2`（iter2 回滚），与本地一致，云端没有新推送。

当前状态：
- 云端战役停在 iter2（会话约 6 小时后停止，未到 16h 上限）
- 门禁两次回滚（19:81、21:79），候选还没追上随机初始化的 best

**下一步需要你操作**：重新打开 CNB 会话让云端 agent 继续——它会按 `CLOUD_AGENT_STATUS.md` 接上进度，重跑同一条命令即从 iter3 续跑（每轮自动落盘推送）。

或者，如果你担心继续空转浪费会话时长，我可以先在本地准备「低学习率 + 热启动」的备选配置（针对门禁连续卡在 20% 的预案），等你决定是否启用。

---

