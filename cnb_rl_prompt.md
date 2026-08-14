# CNB 云 Agent 提示词（第二轮 RL · 严格标准流程版）

> 云环境已重启。请**严格按本提示词执行**，不要自行编写额外脚本、不要偏离流程。
> 这是**第二轮**：训练集已有 67383 条样本（第一轮成果），从该数据集起步重训。

---

你是一个国际象棋引擎开发助手。请在一个有 8 核 CPU 的云环境里，帮我跑**第二轮**自博弈强化学习（RL）迭代。

## 项目背景
自研 Rust 国际象棋引擎（Policy 引导的 α-β 搜索）。仓库已内置 RL 闭环脚本 `rl_loop.py`，核心逻辑：
自对弈生成数据 → 追加训练集 → 重训 Policy → 新旧 policy 对弈评估 → 新版胜率 >56% 采纳，否则自动回滚。

**这是第二轮**：训练集 `data/final_dataset.jsonl` 现有 **67383 条**样本，本轮从该数据集起步重训 Policy。

## ⚠️ 重要约束（务必逐条遵守，这是本提示词的关键）
1. **只用仓库自带的 `rl_loop.py` 跑迭代**，不要自己编写 supervisor / watcher / 备份等任何额外脚本。
2. **不要改动任何脚本的路径或逻辑**——`rl_loop.py` 的解释器路径已用 `sys.executable` 自适应，`train_policy.py` 已支持环境变量覆盖，`rl_selfplay.py` 的 `--workers` 默认已是 8。**直接跑即可，无需任何代码修改。**
3. 跑**一轮**即可（`--rounds 1`），不要自动跑多轮。
4. 只提交本提示词第 5 步指定的结果文件，不要提交其他东西（`.gitignore` 已配好，正常 `git add` 不会误带缓存/中间产物）。

## 第 0 步：获取干净代码（环境已重启）
云工作区可能存在旧目录或分叉，请**新建一个干净目录重新 clone**（最稳妥）：

```bash
git clone https://cnb.cool/duwenfeng/Star-Chess.git
cd Star-Chess
```

> 如果 `Star-Chess` 目录已存在且报分叉错误，先强制对齐再拉取：
> ```bash
> cd Star-Chess && git reset --hard origin/main && git pull origin main
> ```

确认代码是最新且干净的：`git log --oneline -1` 应看到提交 `75cb528`（"docs: 更新云 agent 提示词为第二轮完整版"）。

## 第 1 步：环境准备（按顺序）
1. 编译引擎（产物 `my-engine/target/release/my-engine`）：
   ```bash
   cd my-engine && cargo build --release && cd ..
   ```
2. Python 必须 **3.10 及以上**，安装依赖：
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
- `depth 6` / `movetime 500`：自对弈搜索深度与每步思考时间（毫秒）
- `agg 90`：PolicyAggressiveness 进攻性（0~100，越大越爱弃子进攻）
- `epochs 40`：Policy 训练轮数
- `match-games 300`：新旧 policy 评估对局数
- `match-concurrency 4`：评估并行槽位（每槽位 2 个引擎进程，4 路 × 2 = 8 进程正好吃满 8 核，**勿改成 8**）

一轮约 3.5 小时（自对弈约 1h + 训练约 1.5h + 评估约 1h）。后台运行并保留日志：
```bash
nohup python3 rl_loop.py --rounds 1 --games 1000 --workers 8 --depth 6 --movetime 500 \
  --agg 90 --epochs 40 --match-games 300 --match-concurrency 4 > rl.log 2>&1 &
```

## 第 5 步（必须执行）：跑完立即提交结果，否则会丢
正式一轮跑完后，**立刻**把结果提交并推送（云环境的 origin 就是 CNB）：

```bash
git add -A data/rl_loop_history.json data/rl_match_report.json \
  data/final_dataset.jsonl my-engine/policy/
git commit -m "RL round 2: 自对弈+重训结果（胜率X.XX，是否采纳）"
git push origin main
```

然后读取结果并粘贴到回复里：
```bash
cat data/rl_loop_history.json
cat data/rl_match_report.json
```

并在回复中明确告诉我：新版 policy 胜率、是否采纳（>56% 采纳否则回滚）、Elo 差与置信区间、自对弈样本量、训练最终 val_top1。

## 注意事项
1. 路径含空格 "Star Chess"，脚本内部已处理；你自己拼 shell 命令时也要给路径加引号。
2. `match-concurrency` 保持 4，改成 8 会超订阅、不会更快。
3. 这是第二轮：第一轮胜率 52.67% 未达阈值已回滚，本轮从更大的 67383 样本起步，期望更强，但**仍可能不达 56%**，属正常。
4. 若新版胜率不达标，脚本会自动回滚 `policy.bin`，但 `final_dataset.jsonl` 的新增样本会保留（增量累积，这是预期行为）。
5. **不要省略第 5 步**；**不要做本提示词之外的任何事**（不写脚本、不改代码、不多跑轮次）。
