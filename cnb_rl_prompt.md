# CNB 云 Agent 提示词（修订版，含结果回传步骤）

> 复制以下整段给 CNB 云 agent 使用。相比旧版，新增了**第 5 步「跑完必须 commit + push」**，
> 否则结果文件会随云工作区关闭而丢失（上次已丢过一次）。

---

你是一个国际象棋引擎开发助手。请在一个有足够 CPU 的云环境里，帮我跑一轮自博弈强化学习（RL）迭代。

## 项目背景
这是一个自研 Rust 国际象棋引擎（Policy 引导的 α-β 搜索，入门级棋力）。已经搭好了一套 RL 自博弈闭环脚本，核心逻辑是：
自对弈生成数据 → 追加到训练集 → 重训 Policy → 新旧 policy 对弈评估 → 新版胜率 >56% 就采纳，否则自动回滚。

## 代码位置
项目根目录（注意：路径含空格 "Star Chess"）下，关键文件：
- rl_loop.py      —— RL 主循环（编排自对弈→训练→评估→替换，自动判断胜率）
- rl_selfplay.py  —— 多进程自对弈（复用 dataset_gen.py 的 UCI 客户端）
- my-engine/      —— Rust 引擎源码（需要先编译）
- data/final_dataset.jsonl —— 现有训练集（约 7383 条）

## 环境准备（按顺序执行）
1. 编译引擎（产物 my-engine/target/release/my-engine）：
   cd my-engine && cargo build --release

2. Python 必须是 3.10 及以上（dataset_gen.py 用了 `str | None` 类型语法，3.9 会报错）。
   安装依赖：
   pip install torch python-chess onnx onnxruntime

## 执行前备份（出问题可回滚）
   cp data/final_dataset.jsonl /tmp/final_dataset_backup.jsonl
   cp my-engine/policy.bin /tmp/policy_backup.bin

## 执行任务（先冒烟，再跑正式一轮）
**第一步：小参数冒烟**（确认环境正常，约 2-3 分钟）：
   python3 rl_loop.py --rounds 1 --games 20 --workers 8 --depth 4 --movetime 150 \
     --agg 90 --epochs 2 --match-games 10 --match-concurrency 2
   确认能正常走完「自对弈 → 训练 → 评估 → 胜率判断」五个环节、无报错，再进入第二步。

**第二步：正式一轮**（在项目根目录运行）：
   python3 rl_loop.py --rounds 1 --games 1000 --workers 8 --depth 6 --movetime 500 \
     --agg 90 --epochs 40 --match-games 300 --match-concurrency 4

参数含义：
- games 1000：自对弈局数（workers 8 = 8 进程并行，正好吃满 8 核）
- depth 6 / movetime 500：自对弈的搜索深度和每步思考时间（毫秒）
- agg 90：PolicyAggressiveness 进攻性（0~100，越大越凶悍爱弃子）
- epochs 40：Policy 训练轮数
- match-games 300：新旧 policy 评估对局数（机器快可加到 1000，胜率判断更可靠）
- match-concurrency 4：评估并行槽位数（match.py 每个槽位开 2 个引擎进程，4 路 × 2 = 8 进程正好吃满 8 核，勿改成 8）

## 结果产出
脚本会自动完成全部流程，最终产出：
- data/rl_loop_history.json  —— 每轮胜率、是否采纳、耗时
- data/rl_match_report.json   —— 评估对局明细（Elo 差、胜/和/负、置信区间）
- data/final_dataset.jsonl    —— 追加了本轮自对弈样本后的训练集
- my-engine/policy/policy.bin —— 最终 policy（若胜率达标则已替换为新版）

## ⚠️ 第 5 步（必须执行）：跑完立即提交结果，否则会丢
正式一轮跑完后，**立刻**执行以下三步，把结果写进 git 并回传：

1. 把结果文件提交到 git：
   git add -A data/rl_loop_history.json data/rl_match_report.json \
     data/final_dataset.jsonl my-engine/policy/
   git commit -m "RL round 1: 自对弈+重训结果（胜率X.XX，是否采纳）"
   git push origin main

2. 读取并粘贴结果内容到回复里：
   cat data/rl_loop_history.json
   cat data/rl_match_report.json

3. 在回复中明确告诉我：
   - 新版 policy 的胜率是多少（如 0.58）
   - 有没有被采纳（>56% 采纳，否则回滚）
   - Elo 差是多少、置信区间多少
   - 自对弈样本量、训练最终 val_top1

## 注意事项
1. 路径含空格 "Star Chess"，脚本内部已用双引号处理好；你自己拼 shell 命令时也要给路径加引号。
2. 一轮完整时间约 3.5 小时（自对弈约 1 小时 + 训练约 1.5 小时 + 评估约 1 小时），请用后台运行并保留日志（如 `nohup ... > rl.log 2>&1 &`）。
3. 引擎是入门级，自对弈走法质量有限，这是 RL 闭环的起点，不要期望第一轮就大幅变强。
4. 如果新版胜率不达标，脚本会自动回滚 policy.bin，但 final_dataset.jsonl 的新增样本会保留（数据是增量累积的，这是预期行为）。
5. **不要省略第 5 步**——这是本次修订的关键，上一次就是因为没提交结果、工作区关闭后丢失了。
