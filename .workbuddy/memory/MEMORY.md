# Star Chess 项目长期记忆

## 引擎 my-engine 核心事实
- 自研 Rust 引擎，入门级（vs Stockfish Elo 800 约 50–77 步落败）。4 文件 1835 行：search.rs(1027)/eval.rs(349)/main.rs(289)/policy.rs(170)。
- 架构：α-β + PVS + LMR + TT(单槽、代间隔分级) + 杀手/历史启发 + qsearch(SEE≥−120) + Policy CNN 全局注入 history 表（每 go 仅前向 1 次 ~0.12ms）。
- 5 个 UCI 参数：Policy / PolicyAggressiveness / Hash / Contempt / Threads。
- 当前最优 = v2 起：Lazy SMP 多线程 **+51 Elo**（96局 LOS 95.4%，已部署树莓派）+ 进攻排序 + 双车叠线 + TT 4M + native 编译。

## 关键教训：优化系统性失败（9 连败，勿重试）
- **数据侧/评估侧 7 连败**：残差 CNN+加权 −40 / LMP −69.7 / SF 标签 −34.9 / αβ蒸馏 −34.9 / deep自洽 −6.1 / Texel(self-play) −61.4 / Texel(CCRL+冻结) −110.4。
- **搜索侧精细化 2 连败**：IID −20 / TT age −38.4。
- **根本原因**：eval 是「叶节点估值 + 剪枝阈值」双重载体，与剪枝耦合。按 loss/val_top1 拟合 eval/policy 会破坏走子排序与剪枝判断。
- **Texel 双重失败模式**：①攻王过拟合（katt_ 暴涨，self-play 数据）；②scale 漂移（子力值砍半、通路兵/王盾归零，CCRL 数据）。冻结攻王治错了病——根因是「静态 eval 拟合对局结果」范式与 eval-搜索耦合架构不兼容。
- **TT age 教训**：迭代加深时每次换代是「特性」（清理浅层垃圾条目）不是 bug；改成每 go 换代反而降命中率 −38 Elo。
- **IID 教训**：浅搜索引擎（300ms 仅 10-11 层）IID 浅搜成本收益比不划算。
- **铁律**：任何影响「走法排序 / eval / 剪枝」的改动，只能用对局验证（500+ 局），不能用 loss/val_top1/节点数代理，也不能用「理论分析」判定某处是 bug/优化。小样本 Elo 不可信（+47 都可能是噪声）。
- **定论**：入门级引擎在「手工启发式 eval + α-β」框架下已到实际天花板。**唯一净收益 = Lazy SMP 多线程 +51 Elo（已部署树莓派）**。当前最优 = v2_smp。
- NNUE 是「先补课」的长期目标（需搜索后 self-play 标签 + 增量更新），当前数据管线能力不足（9 次数据实验全败证明）。

## 工作分工（用户规则，2026-08-14 明确）
- 我（agent）只改代码、调参数；长实验（训练/自对弈/对弈）只写提示词交 CNB 云 agent 跑，本地沙箱会杀后台任务。
- 云 agent 提示词模板在项目根 `cnb_*.md`；必须含「跑完 commit+push 结果文件」+「禁止自造脚本」+「只跑指定轮次」。

## 部署与仓库
- 树莓派：pi@192.168.0.107（pi-wildlife2/aarch64），服务 star-ai-board，网站 http://192.168.0.107:8765。
- 远程：origin=GitHub TommyDucx/star-ai-board；cnb=cnb.cool/duwenfeng/Star-Chess。
- GitHub 外网 push 用代理 `export http_proxy=http://127.0.0.1:1087; export https_proxy=http://127.0.0.1:1087`。
- ⚠️ AGENTS.md 含明文凭据（PAT + 树莓派 SSH 密码），触发 GitHub secret scanning；建议剥离到仓库外。

## 代码注释里已留档的「已否定方向」（同 6 连败，勿重试）
渴望窗口 aspiration / SEE 亏子降级排序 / INT8 量化（Policy 占比 <0.1% 无收益）。
