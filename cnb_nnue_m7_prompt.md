# NNUE 增量：数据扩量实验（M5 Phase 4，HF Lichess 5.66M）—— CNB 云 agent 提示词

你是一个国际象棋引擎开发助手。请在云环境（Linux）里验证一个关键假设：**增量 NNUE eval 太弱（pilot 0-40, corr 0.31）是数据量不足（30.2 万）还是架构表达力不足？** 方法：用 **HF Lichess chess-position-evaluations**（深度 15+ 高质量标签）扩到 **~5.66M 局面**，用**同一架构**（acc128→32→32→1，不改代码）重训，然后 pilot 40 局对比。

> 架构不变 = 隔离"数据"这个唯一变量。若 5.66M 数据仍 0-40，则判定为架构瓶颈，下一步走 HalfKP+王桶。

## ⚠️ 约束
1. **只用仓库自带脚本**（`parquet_dump.py` / `data-etl` / `train_nnue_incremental.py` / `golden_nnue.py` / `match.py`），禁止自造脚本、禁止改代码/参数（`--max-samples` 按下面指定）。
2. 只跑指定步骤。
3. **跑完必须 commit+push**，结果贴回复。

## 第 0 步：拉取代码
```bash
cd /workspace
git fetch origin && git reset --hard origin/main
git log --oneline -1    # 应显示 5ab8cd4
ls my-engine/policy/parquet_dump.py data-etl/target/release/data-etl
```

## 第 1 步：下载 HF Lichess 评估数据（1 个 parquet，约 2.1GB）
```bash
cd /workspace
# 国内网络走代理；hf.co CDN 实测 22MB/s
curl -L -x http://127.0.0.1:1087 \
  -o data_0000.parquet \
  "https://huggingface.co/datasets/Lichess/chess-position-evaluations/resolve/main/data/data_0000.parquet"
ls -la data_0000.parquet   # 应约 2.1GB（下载断点续传：curl -C -）
```
> 若代理不通，试直连；仍失败贴错误，我换方案（让本地中转）。

## 第 2 步：pyarrow（若缺）+ 转 fixed-color .scnn
```bash
pip install pyarrow    # 主容器没有就装；已有则跳过
cd /workspace
python3 my-engine/policy/parquet_dump.py --parquet data_0000.parquet --min-depth 15 \
  | ./data-etl/target/release/data-etl --input - --fixed-color \
      --hash-subsample 2 \
      --output data/nnue/train_fc_large.scnn --stats data/nnue/etl_fc_large_stats.json
cat data/nnue/etl_fc_large_stats.json   # 记录 kept_positions（预期 ~500 万级）
```
> 注意：HF 源 cp 是**白方视角**，不要加 `--stm-cp`（data-etl 会自动转 eval_white）。
> `.scnn` 预计 ~4GB，勿 push（gitignore）。

## 第 3 步：训练（同架构，扩量）
```bash
cd /workspace
python3 my-engine/policy/train_nnue_incremental.py \
  --scnn data/nnue/train_fc_large.scnn \
  --max-samples 3000000 --epochs 25 --batch 256 --lr 3e-3
```
贴：`best val_mse`（对比 Phase1/3 的 0.00677）、val MAE(cp)、corr（对比 0.31）。
> 300 万样本 × 25 epochs 预计 2-3 小时。若前 10 epochs corr 已显著 >0.5，可提前继续；若 corr ≤0.4 且不再上升，可提前停并如实报告（说明数据没解决）。

## 第 4 步：golden test（必过）
```bash
cd /workspace
python3 my-engine/policy/golden_nnue.py \
  --nnue my-engine/policy/nnue_inc.bin \
  --fens my-engine/policy/golden_fens.txt \
  --rust-bin my-engine/nnue/target/release/nnue_eval
# 必须 GOLDEN TEST PASS
```

## 第 5 步：冒烟 + 深度
```bash
cd /workspace/my-engine/nnue
cp ../policy/nnue_inc.bin ./nnue.bin
printf 'uci\nsetoption name Eval value nnue\nisready\nposition startpos moves e2e4 e7e5 g1f3 b8c6 f1b5\n\ngo movetime 300\nquit\n' \
  | ./target/release/my-engine-nnue 2>/dev/null | grep -E "info depth" | tail -1
rm -f nnue.bin
```

## 第 6 步：pilot 40 局（同一二进制，仅 Eval 不同）
```bash
cd /workspace
python3 match.py --eng my-engine/nnue/target/release/my-engine-nnue \
  --name-a handcrafted --name-b nnue \
  --nnue-b my-engine/policy/nnue_inc.bin --eval-b nnue \
  --games 40 --movetime 300 --concurrency 8 --threads-a 1 --threads-b 1 \
  --out match_nnue_pilot.json
cat match_nnue_pilot.json
```

## 第 7 步：决策门
- **数据解决了**（NNUE 接近/超过 handcrafted，Elo 差 <100 或占优）→ 跑 500 局定论：
  ```bash
  python3 match.py --eng my-engine/nnue/target/release/my-engine-nnue \
    --name-a handcrafted --name-b nnue \
    --nnue-b my-engine/policy/nnue_inc.bin --eval-b nnue \
    --games 500 --movetime 300 --concurrency 8 --threads-a 1 --threads-b 1 \
    --out match_nnue_500.json
  ```
- **数据没解决**（仍 0-x 或 Elo 差 >>100）→ **结论 = 架构瓶颈（fixed-color HalfK-768 无王格耦合，30万/300万数据都救不了）**，下一步升级 HalfKP+王桶。贴结果，不跑 500 局。

## 第 8 步：提交 + 推送 + 汇报
```bash
cd /workspace
git add my-engine/policy/nnue.bin match_nnue_pilot.json data/nnue/etl_fc_large_stats.json
git commit -m "data(M5): 增量 NNUE 数据扩量实验（HF 5.66M 源）+pilot 评测"
git push origin main
```
> `nnue.bin`（best-val 权重）入库；`.scnn`/parquet 勿 push。

贴回：HEAD / 下载耗时 / ETL kept / best val_mse+corr（对比 0.00677/0.31）/ golden / 冒烟 depth / pilot JSON / 决策结论 / commit hash。

## 环境说明
- 训练 300 万样本约 2-3 小时（CPU 8 核）。中途如 corr 数据趋势明确可提前判断。
- 下载若慢，用 `curl -C -` 断点续传，多试几次。
- 铁律：本实验结论以 pilot 对局为准，corr 只是观测。
