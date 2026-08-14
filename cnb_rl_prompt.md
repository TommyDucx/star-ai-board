# CNB 云 Agent 提示词（第二轮 RL · 环境重启后完整版）

> 复制以下整段给 CNB 云 agent 使用。云环境已重启，需从零拉取代码。
> 这是**第二轮**：训练集已有 67383 条样本（第一轮沉淀 6 万条），从更大数据集起步。

---

你是一个国际象棋引擎开发助手。请在一个有足够 CPU（8 核）的云环境里，帮我跑**第二轮**自博弈强化学习（RL）迭代。

## 项目背景
这是一个自研 Rust 国际象棋引擎（Policy 引导的 α-β 搜索，入门级棋力）。已搭好一套 RL 自博弈闭环脚本，核心逻辑：
自对弈生成数据 → 追加到训练集 → 重训 Policy → 新旧 policy 对弈评估 → 新版胜率 >56% 就采纳，否则自动回滚。

**这是第二轮**：第一轮已跑完，训练集 `data/final_dataset.jsonl` 现有 **67383 条**样本（第一轮自对弈沉淀了 6 万条）。本轮从更大的数据集起步，重训出的 Policy 有望更强。

## 第 0 步：拉取最新代码（环境已重启，必须重新拉）
```bash
git clone https://cnb.cool/duwenfeng/Star-Chess.git
cd Star-Chess
```
（如果目录已存在，则 `cd Star-Chess && git pull origin main`）

代码已经是干净、可直接运行的状态，**不需要手动改任何路径**：
- `rl_selfplay.py` / `rl_loop.py` 的 `--workers` 默认已是 **8**（8 核吃满）；
- `rl_loop.py` 的解释器路径已改为 `sys.executable`（云/本地通用，不再硬编码 Mac 路径）；
- `train_policy.py` 的数据/输出路径支持 `RL_DATA`/`RL_OUTDIR` 环境变量覆盖；
- `.gitignore` 已配置好（会忽略 `__pycache__`、`*.pyc` 和 RL 中间产物）。

## 第 1 步：环境准备（按顺序执行）
1. 编译引擎（产物 `my-engine/target/release/my-engine`）：
   ```bash
   cd my-engine && cargo build --release
   ```

2. Python 必须是 **3.10 及以上**（`dataset_gen.py` 用了 `str | None` 类型语法，3.9 会报错）。安装依赖：
   ```bash
   pip install torch python-chess onnx onnxruntime
   ```

## 第 2 步：执行前备份（出问题可回滚）
```bash
cp data/final_dataset.jsonl /tmp/final_dataset_backup.jsonl
cp my-engine/policy.bin /tmp/policy_backup.bin
```

## 第 3 步：先小参数冒烟（约 2-3 分钟，确认环境正常）
```bash
python3 rl_loop.py --rounds 1 --games 20 --workers 8 --depth 4 --movetime 150 \
  --agg 90 --epochs 2 --match-games 10 --match-concurrency 2
```
确认能正常走完「自对弈 → 追加 → 训练 → 评估 → 胜率判断」五个环节、无报错，再进入第 4 步。

## 第 4 步：正式跑第二轮（在项目根目录）
```bash
python3 rl_loop.py --rounds 1 --games 1000 --workers 8 --depth 6 --movetime 500 \
  --agg 90 --epochs 40 --match-games 300 --match-concurrency 4
```

参数含义：
- `games 1000`：自对弈局数（`workers 8` = 8 进程并行，正好吃满 8 核）
- `depth 6` / `movetime 500`：自对弈的搜索深度和每步思考时间（毫秒）
- `agg 90`：PolicyAggressiveness 进攻性（0~100，越大越凶悍爱弃子）
- `epochs 40`：Policy 训练轮数
- `match-games 300`：新旧 policy 评估对局数（机器快可加到 1000，胜率判断更可靠）
- `match-concurrency 4`：评估并行槽位数（match.py 每个槽位开 2 个引擎进程，4 路 × 2 = 8 进程正好吃满 8 核，**勿改成 8**）

一轮完整时间约 3.5 小时（自对弈约 1 小时 + 训练约 1.5 小时 + 评估约 1 小时）。建议后台运行并保留日志，例如：
```bash
nohup python3 rl_loop.py --rounds 1 --games 1000 --workers 8 --depth 6 --movetime 500 \
  --agg 90 --epochs 40 --match-games 300 --match-concurrency 4 > rl.log 2>&1 &
```

## 第 5 步（必须执行）：跑完立即提交结果，否则会丢
正式一轮跑完后，**立刻**执行以下三步，把结果写进 git 并回传：

1. 把结果文件提交到 git（云环境的 origin 就是 CNB，`git push origin main` 即推回 CNB）：
   ```bash
   git add -A data/rl_loop_history.json data/rl_match_report.json \
     data/final_dataset.jsonl my-engine/policy/
   git commit -m "RL round 2: 自对弈+重训结果（胜率X.XX，是否采纳）"
   git push origin main
   ```
   可以用一个 watcher 进程在 `rl_loop.py` 跑完瞬间自动执行上面的 commit + push（第一轮就是这么做的，避免结果随工作区关闭丢失）。

2. 读取并粘贴结果内容到回复里：
   ```bash
   cat data/rl_loop_history.json
   cat data/rl_match_report.json
   ```

3. 在回复中明确告诉我：
   - 新版 policy 的胜率是多少（如 0.58）
   - 有没有被采纳（>56% 采纳，否则回滚）
   - Elo 差是多少、置信区间多少
   - 自对弈样本量、训练最终 val_top1

## 注意事项
1. 路径含空格 "Star Chess"，脚本内部已用双引号处理好；你自己拼 shell 命令时也要给路径加引号。
2. `match-concurrency` 保持 4（每槽位 2 引擎进程 × 4 路 = 8 进程 = 8 核），改成 8 会 16 进程超订阅、反而不会更快。
3. 引擎是入门级，自对弈走法质量有限；这是 RL 迭代的第二轮，第一轮胜率 52.67% 未达阈值已回滚，本轮期望从更大数据集中练出更强的 Policy，但仍可能不达 56%，属正常。
4. 如果新版胜率不达标，脚本会自动回滚 `policy.bin`，但 `final_dataset.jsonl` 的新增样本会保留（数据是增量累积的，这是预期行为）。
5. **不要省略第 5 步**——上一轮因未提交结果丢失过一次，这是本次流程的关键。
