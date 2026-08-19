# CNB 云 Agent 提示词（Texel Tuning 评估调参 · 全流程）

> 复制以下整段给 CNB 云 agent 使用。请**严格按提示词执行，不要自行编写脚本、不要偏离流程**。

---

你是一个国际象棋引擎开发助手。请在一个有 8 核 CPU 的云环境里，帮我跑**Texel Tuning**（用自对弈数据自动调优引擎 `eval.rs` 的 25 个标量参数）。

## 背景
自研 Rust 国际象棋引擎（α-β + 手工 Tapered 评估）。评估函数是「参数 × 特征」的线性函数，因此可以用 logistic 回归自动调参（Texel 方法）：最小化 `(result − sigmoid(eval/400))²`。仓库里已备好完整工具链（**直接使用，不要改代码**）：
- `texel_eval.py` —— 参数化 eval + 线性特征提取（已与 Rust 侧 golden 校验一致）
- `texel_data.py` —— 从自对弈 PGN 提取「安静局面 + 对局结果」
- `texel_tune.py` —— logistic 回归调 25 个标量参数
- `texel_apply.py` —— 把调参结果写回 `my-engine/src/eval.rs`
- `match.py` —— 引擎对弈器（用于自对弈生成数据 + 最终验证）

## 任务流程（严格按顺序）

### 第 0 步：拉代码 + 编译引擎
```bash
git clone https://cnb.cool/duwenfeng/Star-Chess.git
cd Star-Chess
# 装 Rust（若环境没有）：curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
cd my-engine/handcrafted && cargo build --release && cd ../..
```

### 第 1 步：环境准备
```bash
pip install python-chess numpy
```

### 第 2 步：自对弈生成数据（约 2 小时，核心耗时步骤）
用引擎自己 vs 自己下 5000 局（浅搜索即可，目的是产生多样化的安静局面，不需要下得很好）：
```bash
python3 match.py --eng ./my-engine/handcrafted/target/release/my-engine \
  --games 5000 --concurrency 8 --movetime 200 \
  --name-a a --name-b b --out /tmp/texel_selfplay.json
```
（`match.py` 会同时输出 `/tmp/texel_selfplay.pgn`，含每局 Result。后台运行 + 保留日志 `nohup ... > selfplay.log 2>&1 &`。）

### 第 3 步：提取安静局面 + 结果
```bash
python3 texel_data.py --pgn /tmp/texel_selfplay.pgn --out /tmp/texel_data.txt --min-ply 8
```
预期产出约 5~10 万条 `FEN\tresult`。

### 第 4 步：调参（几分钟）
```bash
python3 texel_tune.py --data /tmp/texel_data.txt --epochs 200 --lr 0.1 --out /tmp/tuned_params.json
```
观察 loss 是否下降。若数据量够，loss 应明显低于初始值。

### 第 5 步：写回 eval.rs + 编译新引擎
```bash
python3 texel_apply.py --params /tmp/tuned_params.json --eval-rs my-engine/src/eval.rs
cd my-engine/handcrafted && cargo build --release && cd ../..
cp my-engine/handcrafted/target/release/my-engine /tmp/my-engine_tuned
```

### 第 6 步：编译旧引擎（调参前的父提交，作为对照）
```bash
git worktree add /tmp/star-old HEAD~1
cd /tmp/star-old/my-engine && cargo build --release && cd -
cp /tmp/star-old/my-engine/handcrafted/target/release/my-engine /tmp/my-engine_old
```

### 第 7 步：对弈验证（新旧 eval，400 局，约 1 小时）
```bash
python3 match.py --eng-a /tmp/my-engine_old --eng-b /tmp/my-engine_tuned \
  --policy-a ./my-engine/policy.bin --policy-b ./my-engine/policy.bin \
  --games 400 --concurrency 4 --movetime 300 \
  --threads-a 1 --threads-b 1 \
  --name-a old --name-b tuned --out /tmp/match_texel.json
```
（若机器核数不足，`--concurrency` 可降到 2。）

### 第 8 步：报告结果
```bash
cat /tmp/tuned_params.json
cat /tmp/match_texel.json
```
在回复中明确告诉我：
- 调参前后 loss 值（初始 loss → 最终 loss）
- 25 个参数里变化最大的前几个（名称 + 初始值 → 调后值）
- 对弈结果：old vs tuned 的胜负和、tuned 胜率（=1−score_A）、Elo 差（=−elo_diff_A_minus_B）、95% CI、LOS（tuned 更强概率 = 1−LOS_A_better）

## 注意事项（务必遵守）
1. **只用仓库自带脚本**，不要自己写脚本、不要改任何代码/路径（`texel_apply.py` 会改 `eval.rs` 参数，这是唯一预期的改动）。
2. 自对弈第 2 步用 `--concurrency 8`（8 核吃满）；对弈验证第 7 步每槽位 2 引擎，`--concurrency` 保持 4。
3. 若第 2 步 5000 局太慢，可降到 3000 局（数据量仍够调 25 个参数），但不要低于 2000 局。
4. 若第 5 步 `texel_apply.py` 报「未找到常量」，说明工作区代码不是最新（缺少具名常量），先 `git pull origin main` 再试。
5. 结果无需 commit/push，把 `tuned_params.json` 和 `match_texel.json` 内容贴回复里即可。
