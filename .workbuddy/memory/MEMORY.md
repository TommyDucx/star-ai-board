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

## 工作分工（2026-08-20 更新，取代 08-14 旧规则）
- **当前对话的我 = CNB 云端 agent**（Linux /workspace，8核/16GB），**不再生成 cnb_*.md 提示词**，长任务（训练/对弈/打标签/ETL）直接本环境自己跑完。
- 跑完仍 commit+push 结果文件 + 关键输出贴回复。`cnb_*.md` 仅作历史档案。
- **新对话开工必读**：`CLOUD_AGENT_STATUS.md`（进度/下一步速查，实时维护）→ `WORKING_PRINCIPLES.md` → 本文件。
- 旧规则（08-14，仅历史参考）：本地改代码、长实验交云 agent。

## 部署与仓库
- 树莓派：pi@192.168.0.107（pi-wildlife2/aarch64），服务 star-ai-board，网站 http://192.168.0.107:8765。
- 远程：origin=GitHub TommyDucx/star-ai-board；cnb=cnb.cool/duwenfeng/Star-Chess。
- GitHub 外网 push 用代理 `export http_proxy=http://127.0.0.1:1087; export https_proxy=http://127.0.0.1:1087`。
- ⚠️ AGENTS.md 含明文凭据（PAT + 树莓派 SSH 密码），触发 GitHub secret scanning；建议剥离到仓库外。

## 代码注释里已留档的「已否定方向」（同 6 连败，勿重试）
渴望窗口 aspiration / SEE 亏子降级排序 / INT8 量化（Policy 占比 <0.1% 无收益）。

## 网站 QA 多智能体闭环（2026-09-12 建立，可复用）
- **入口 = `qa/QA_BRIEF.md`**（三 agent 共享简报：页面/API 清单、巡检重点、技术约定、
  测试环境、部署命令、报告格式、严重度定义、铁律）。`qa/` 已 gitignore（简报含凭据，不入库）。
- ⚠️ **改 `admin/*.json` 前必看**：`accounts.json` 是**数组**（其余 4 个是以 id/token 为键的对象）。
  删条目必须 `filter`——对数组用 `delete` 会留空洞 → `JSON.stringify` 写成 `null` →
  启动时 `normalizeUser(null)` 抛 TypeError → 全站 502（2026-09-12 真实事故，约 2 分钟）。
  铁律：整目录备份 → 改 → 自检无 null → 本地起服务验证 → 才动线上；动线上先 stop 服务。
- **顶栏返回按钮**：唯一返回控件是 `motion.js` 注入的 `.site-back`（"← 返回"）；
  各页顶栏的 `.logo` 必须是品牌字标 `S.T.A.R.`，**不要再写成 "←" 箭头**（会造成两个返回按钮）。
  窄屏规则统一在 `css/motion.css`（≤560 / ≤400 / ≤360 三级压缩），不要再往单页内联里写。

- **分工**：1 号漏洞猎人（只找 bug，实测复现）→ 2 号方案设计师（只出方案，**独立核实根因可推翻 1 号**）
  → 3 号实施工程师（改码 + 部署树莓派 + 实测回归）。**禁止同一 agent 自证自改**。
- **报告**：`qa/roundN-findings.md`（含「已通过清单」证明覆盖面）/ `roundN-plan.md` / `roundN-report.md`。
- **历史 QA**：仓库根 `qa_issues.md` 有 ISSUE-001~033（均已修）——新巡检必须先排除，勿重复上报。
- **本机 grep 是 ripgrep**：多选一用 `grep -E`，**不支持 BRE 的 `\|`**（否则静默假阴性）。
- **未决安全项**：棋力测评 `finish` 反刷分只「部分有效」，慢速脚本（等 5s/局）仍可 +480 分/小时。
  抬高时长下限**无收益**（频率上限 20 局/10min 才是绑定约束）——唯一真解是 WS 引擎桥层
  按 gameId 记录真实 movelist。详见 `qa/round2-findings-partial.md`。**待决策是否实施。**

