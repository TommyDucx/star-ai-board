# CNB 云 Agent 提示词（深搜索自洽标签 · 大样本确认换血方向）

> 复制以下整段给 CNB 云 agent 使用。请**严格按提示词执行，不要自行编写脚本、不要偏离流程**。

---

你是一个国际象棋引擎开发助手。请在一个有 8 核 CPU 的云环境里，帮我**验证"深搜索自洽标签"这个数据换血方向**（大样本对弈确认棋力收益）。

## 项目背景
自研 Rust 国际象棋引擎（Policy 引导的 α-β 搜索，入门级）。引擎里有一个轻量 Policy 网络（8×8×13→4096 走法概率），用于**走子排序引导**。

已做的实验（本地小样本）发现：
- Policy 的标签必须与引擎**自身搜索行为自洽**（即 policy 开启状态下引擎的走法），否则会误导排序；
- 用 Stockfish 走法 / 纯 α-β（policy 关闭）走法做标签，都是负收益（约 −35 Elo）；
- 用「**policy 开启 + 深搜索（movetime 1000ms）**」走法做标签，是唯一正向方向，本地 96 局对弈 **+47.3 Elo（LOS 93.7%）**，但样本量不够、CI 仍含 0，需要大样本坐实。

## 任务：大样本对弈验证这个方向

### 第 0 步：拉取代码 + 编译引擎
```bash
git clone https://cnb.cool/duwenfeng/Star-Chess.git
cd Star-Chess
cd my-engine && cargo build --release && cd ..
```
代码已是干净状态，包含新增的 `deep_label.py`（深搜索自洽标签生成器）和修复路径后的 `make_self_teacher.py`，**不需要改任何代码/路径**。

### 第 1 步：环境准备
Python 必须 3.10+，安装依赖：
```bash
pip install torch python-chess onnx onnxruntime
```

### 第 2 步：生成深搜索标签（约 10 分钟，8 进程）
```bash
python3 deep_label.py --in data/teacher_dataset.jsonl \
  --out data/deep_self_distill.jsonl --movetime 1000 --workers 8
```
`deep_label.py` 会用引擎自身（**policy 开启**）+ 每局面 1000ms 搜索，为 `teacher_dataset.jsonl` 的约 4400 个 FEN 打标签。预期产出约 4400 条 `data/deep_self_distill.jsonl`。

### 第 3 步：训练 Policy（约 6 分钟）
```bash
cd my-engine/policy
python3 train_policy.py --data ../../data/deep_self_distill.jsonl --epochs 25
python3 export_weights.py
cd ../..
```
训练完成会输出 `my-engine/policy/policy.pt` / `policy.onnx`，`export_weights.py` 生成 `my-engine/policy/policy.bin`（这就是"deep"新 policy）。
（注：`train_policy.py` 的路径可用 `RL_DATA` / `RL_OUTDIR` 环境变量覆盖，默认值已正确，无需改。）

### 第 4 步：大样本对弈（核心验证，约 1 小时）
对比 **旧 policy（`my-engine/policy.bin`，仓库里已有的权威版）** vs **新 deep policy（`my-engine/policy/policy.bin`）**：
```bash
python3 match.py --eng ./my-engine/target/release/my-engine \
  --policy-a ./my-engine/policy.bin \
  --policy-b ./my-engine/policy/policy.bin \
  --games 400 --concurrency 4 --movetime 300 \
  --threads-a 1 --threads-b 1 \
  --name-a old --name-b deep --out /tmp/match_deep_400.json
```
`match.py` 用 python-chess（第 1 步已装）。400 局 / 4 并发 / 300ms 约 1 小时，请后台运行并保留日志（`nohup ... > match.log 2>&1 &`）。

### 第 5 步：报告结果
读取并粘贴以下内容到回复里：
```bash
cat /tmp/match_deep_400.json
```
并在回复中明确告诉我：
- 新旧胜负/和棋数（results 字段）
- deep 的胜率（= 1 − score_A）和 Elo 差（= −elo_diff_A_minus_B）
- Elo 95% 置信区间、LOS（deep 更强的概率 = 1 − LOS_A_better）

## 注意事项（务必遵守）
1. **只用仓库自带脚本**（`deep_label.py` / `train_policy.py` / `export_weights.py` / `match.py`），不要自己写额外脚本、不要改任何代码/路径。
2. `match.py` 的 `--concurrency` 是"并行对局数"，每槽位开 2 个引擎进程，**保持 4**（4×2=8 进程正好吃满 8 核，改成 8 会超订阅）。
3. 路径含空格 "Star Chess" 无需担心（clone 出来是 `Star-Chess`，无空格）；自己拼 shell 命令时给路径加引号即可。
4. 若新版胜率显著强（LOS > 95% 且 Elo 正向），说明"深搜索自洽标签"换血方向成立，我会据此决定后续扩大数据规模；若仍未显著，则如实报告。
5. 结果无需 commit/push（本次只是验证），把 `/tmp/match_deep_400.json` 内容贴回复里即可。
