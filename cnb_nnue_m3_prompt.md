# NNUE 引擎集成 + 对局验证（M3–M4）—— CNB 云 agent 提示词

你是一个国际象棋引擎开发助手。请在云环境（Linux）里完成 NNUE 评估网络的**训练 → 引擎集成验证 → 对局评测**闭环。

## 背景

本地已完成（代码已提交，见 `078e5e3`）：
- **数据管线 M0–M2**：`data/eval_labels.txt.gz`（40 万行教师深搜 eval 标签，depth10 + 对称增广）已就绪；`data-etl`（Rust）可把标签转成 `.scnn`。
- **M3 引擎侧代码**：
  - `my-engine/src/nnue.rs`：HalfK-768→logit 手写 CNN 前向（与 `train_nnue.py` 的 EvalNet 结构逐层一致），加载 `nnue.bin`（`policy/export` 格式）。
  - `eval.rs`：`UCI Eval` 开关（`handcrafted` 默认 / `nnue`），`eval_stm` 切换。
  - `match.py`：新增 `--nnue-a/b --eval-a/b` 支持 A/B 对照。
  - `golden_nnue.py` + `src/bin/nnue_eval`：Rust vs PyTorch 逐位一致验证（随机权重本地已 PASS，max_diff=0.0）。
- **已知风险（务必如实汇报）**：静态 NNUE 推理每个节点约 23ms（vs 手写 eval 快几百倍），搜索深度会大幅下降（本地实测 depth3 需 66s）。**先跑小样本 pilot 对局测量深度差距，再决定是否跑 500 局**——不要盲目跑 500 局。

## ⚠️ 约束
1. **只用仓库自带脚本**（`train_nnue.py` / `golden_nnue.py` / `match.py` / `data-etl`），禁止自造脚本、禁止改脚本逻辑/参数。
2. 只跑下面指定步骤与参数，不要额外实验、不要加戏。
3. **跑完必须 commit+push 结果文件**（至少 `nnue.bin` + 评测报告），并把关键输出贴到回复里，否则结果随工作区关闭丢失。

## 第 0 步：拉取代码
```bash
cd /workspace
git fetch origin && git reset --hard origin/main
git log --oneline -1    # 应显示 078e5e3（M3 引擎集成）
ls data/eval_labels.txt.gz
```
> 若 HEAD 不是 078e5e3，先告诉我，别继续。

## 第 1 步：编译（data-etl + my-engine）
```bash
cd /workspace
# Rust 环境：若无 cargo，按 `curl https://sh.rustup.rs -sSf | sh` 安装后 source ~/.cargo/env
cd data-etl && cargo build --release && cd ..
cd my-engine && cargo build --release && cargo build --release --bin nnue_eval && cd ..
ls -la data-etl/target/release/data-etl my-engine/target/release/my-engine my-engine/target/release/nnue_eval
```
> 编译若因缺依赖失败，把报错贴回来。

## 第 2 步：教师标签 → .scnn（用 data-etl，`--stm-cp` 模式）
```bash
cd /workspace
mkdir -p data/nnue
gzip -dc data/eval_labels.txt.gz \
  | ./data-etl/target/release/data-etl --input - --stm-cp \
      --output data/nnue/train.scnn --sidecar data/nnue/train_sidecar.tsv \
      --stats data/nnue/etl_stats.json
cat data/nnue/etl_stats.json   # 记录 kept_positions（预期 ~30 万级别）
```
> `--stm-cp`：教师标签的 cp 已是**行棋方视角**，直接使用（data-etl 自动跳过白方视角转换）。预计耗时 <1 分钟。

## 第 3 步：训练 NNUE
```bash
cd /workspace
python3 my-engine/policy/train_nnue.py \
  --scnn data/nnue/train.scnn \
  --max-samples 300000 --epochs 30 --batch 256 --lr 3e-3
```
产出：`my-engine/policy/policy_nnue.pt` + `my-engine/policy/policy_nnue.onnx` + `my-engine/policy/nnue.bin`。
把训练日志的**末行 val_mse 与 val MAE(cp) / corr** 贴到回复里（预期 val_mse 明显低于初始 ~0.07，corr 明显高于 0）。

## 第 4 步：golden test（Rust 前向 vs PyTorch 逐位一致，必做）
```bash
cd /workspace
python3 my-engine/policy/golden_nnue.py \
  --nnue my-engine/policy/nnue.bin \
  --fens my-engine/policy/golden_fens.txt \
  --rust-bin my-engine/target/release/nnue_eval
```
**必须输出 `GOLDEN TEST PASS`**（max_abs_diff 应 <1e-3）。若 FAIL，把 mismatch 行贴回来，**不要继续**。

## 第 5 步：引擎冒烟（Eval=nnue）
```bash
cd /workspace/my-engine
cp policy/nnue.bin ./nnue.bin
printf 'uci\nsetoption name Eval value nnue\nisready\nposition startpos moves e2e4 e7e5 g1f3 b8c6 f1b5\n\ngo depth 3\nquit\n' | ./target/release/my-engine 2>/dev/null | grep -E "bestmove|info depth" | tail -3
rm -f nnue.bin
```
预期：能输出 bestmove（因静态 eval 慢，depth3 可能耗时几十秒，正常）。若卡死/崩溃，贴回来。

## 第 6 步：Pilot 对局（40 局，测深度差距，决定是否 500 局）
```bash
cd /workspace
python3 match.py --eng my-engine/target/release/my-engine \
  --name-a v2_smp --name-b nnue \
  --nnue-b my-engine/policy/nnue.bin --eval-b nnue \
  --games 40 --movetime 300 --concurrency 8 --threads-a 1 --threads-b 1 \
  --out match_nnue_pilot.json
cat match_nnue_pilot.json
```
> A = 手写 eval（v2_smp 基线，默认配置），B = NNUE eval。同一二进制，唯一差异 = Eval 模式。

**决策门（如实判断）**：
- 若 NNUE 在 pilot 中**显著落后**（Elo 差 >100 或完全被压制）且明显是搜索深度塌陷所致 → 这就是「静态推理太慢」的预期结果，**不要**再跑 500 局浪费核时。汇报结论：M3 闭环跑通（数据→训练→golden→集成→对局全链路 OK），但静态 NNUE 因深度受限棋力不足，下一步需增量推理。
- 若 NNUE 与基线接近（Elo 差 <100，LOS 不一边倒）→ 继续跑 500 局验证：
```bash
python3 match.py --eng my-engine/target/release/my-engine \
  --name-a v2_smp --name-b nnue \
  --nnue-b my-engine/policy/nnue.bin --eval-b nnue \
  --games 500 --movetime 300 --concurrency 8 --threads-a 1 --threads-b 1 \
  --out match_nnue_500.json
cat match_nnue_500.json
```

## 第 7 步：提交 + 推送 + 汇报
```bash
cd /workspace
cp my-engine/policy/nnue.bin my-engine/policy/nnue.bin
git add my-engine/policy/nnue.bin match_nnue_*.json data/nnue/etl_stats.json
git commit -m "data(M4): NNUE eval 训练集训练结果 + pilot/500局评测报告"
git push origin main
```
> 注意：`.scnn`（几百 MB）和 sidecar 在 gitignore 里，**不要** add 它们。`nnue.bin`（~0.5MB）必须入库（引擎运行依赖）。

把以下信息贴到回复里：
1. HEAD 确认（078e5e3）+ 编译是否成功；
2. ETL stats：`kept_positions`（训练样本数）；
3. 训练：末轮 val_mse / val MAE(cp) / corr；
4. golden test：max_abs_diff + PASS/FAIL；
5. 冒烟：bestmove 是否正常 + depth3 耗时；
6. pilot 40 局结果 JSON（或 500 局 JSON）+ 你的决策与理由；
7. commit hash。

## 环境说明
- 8 核机器：`match.py --concurrency 8`（8 局并行 × 每局 1 线程）。
- 训练用 CPU 即可（网络仅 13.5 万参数，`.scnn` 用 memmap 读，不会 OOM）。
- 若 Rust 编译环境缺失导致卡住，贴报错回来，不要自行改依赖。
