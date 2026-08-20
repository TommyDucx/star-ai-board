# NNUE HalfKP 王桶特征训练（M6 Phase 1，数据侧验证）—— CNB 云 agent 提示词

你是一个国际象棋引擎开发助手。请在云环境（Linux）里训练 **HalfKP（王格耦合）** 评估网络，验证一个关键假设：**fixed-color HalfK-768（无王格耦合）是 M5 的硬瓶颈（corr 0.75、pilot 4-36 仍输 381 Elo）；把特征耦合到白王格（HalfKP + 32 王桶）能否显著提升 eval 质量？**

> 本阶段只做**数据 + 训练 + 质量预筛**（corr），不做引擎集成、不对局。corr 显著高于 Phase 4 的 0.75 → 值得投入引擎集成；否则判定为架构/数据双重瓶颈。

## 背景（务必先读 `cnb_nnue_incremental_design.md` 的「升级路径」）
- M5 已确认：增量引擎本体正确（深度恢复、golden 0 diff），败在 eval 质量。
- 数据是有效变量：30 万→200 万，corr 0.31→0.75、pilot 0-40→4-36，但 Elo 差仍 381。
- 结论：**fixed-color HalfK-768 无王格耦合 = 硬瓶颈**。HalfKP 把每个特征与白王格桶耦合，能学"子力对王的相对价值"（王翼攻防/残局王近战）。
- 规格（data-etl `--halfkp` 已实现并本地验证 200 条与 python 参考逐位一致）：
  - 王桶 B=32：bucket = file*4 + rank//2；每桶 704 槽（us 白非王 320 + them 黑含王 384）
  - 特征空间 = 32×704 = 22528；稀疏（每局面 ~31 个下标）
  - fixed-color（us=白恒等），标签 eval_white；输出 = 白方胜率 logit

## ⚠️ 约束
1. **只用仓库自带脚本**（`data-etl` / `train_nnue_halfkp.py` / `parquet_dump.py`），禁止自造脚本、禁止改代码/参数。
2. 只跑指定步骤。
3. **跑完必须 commit+push**（本轮 push 统计 json 即可；模型等引擎侧 golden 后再定），结果贴回复。

## 第 0 步：拉取代码
```bash
cd /workspace
git fetch origin && git reset --hard origin/main
git log --oneline -1    # 应显示 M6 本地提交（含 data-etl/src/halfkp.rs + train_nnue_halfkp.py）
ls data-etl/src/halfkp.rs my-engine/policy/train_nnue_halfkp.py
```

## 第 1 步：编译 data-etl
```bash
cd /workspace
cd data-etl && cargo build --release && cd ..
```
> ⚠️ 注意：第一轮结果 corr 0.21 是 **bug**（标签视角与 fixed-color 特征错配，已修复并本地复现 corr 0.26@80K）。请用**最新 HEAD**（含修复的 data-etl）重跑本提示词，标签现在正确。

## 第 2 步：准备 HF 数据 → HalfKP .scnn
> 若 Phase 4 下载的 `data_0000.parquet` 还在工作区（约 2.1GB），直接复用；否则重新下载：
```bash
cd /workspace
[ -f data_0000.parquet ] || curl -L -C - -o data_0000.parquet \
  "https://huggingface.co/datasets/Lichess/chess-position-evaluations/resolve/main/data/data_0000.parquet"
python3 my-engine/policy/parquet_dump.py --parquet data_0000.parquet --min-depth 15 \
  | ./data-etl/target/release/data-etl --input - --halfkp \
      --hash-subsample 2 \
      --output data/nnue/train_hkp.scnn --stats data/nnue/etl_hkp_stats.json
cat data/nnue/etl_hkp_stats.json   # 记录 kept_positions（预期 ~500 万级）
```
> `.scnn`（~800MB，定长 140B/条）勿 push（gitignore）。

## 第 3 步：训练 HalfKP
```bash
cd /workspace
python3 my-engine/policy/train_nnue_halfkp.py \
  --scnn data/nnue/train_hkp.scnn \
  --max-samples 5000000 --epochs 20 --batch 256 --lr 3e-3
```
> 内存：稀疏 int64 加载 5M×32 ≈ 1.5GB，16GB 容器安全（不会像 Phase 4 那样 OOM）。
> 贴：`best val_mse`、对应 epoch、**corr**（训练日志每轮都有 corr）。

## 第 4 步：质量预筛（数据侧，最终仍以对局为准）
**判断门**：
- ✅ **显著提升**：corr > **0.80**（Phase 4 HalfK 200 万为 0.75；HalfKP 王格耦合 + 500 万应更高）→ 值得投入引擎集成（下一步本地做 nnue.rs v3 + search 王桶边界）。
- ❌ **无明显提升**：corr ≤ 0.75 或不高于 Phase 4 → 王格耦合没救回来，贴完整日志，**停**（等指示，可能需更大 accumulator 或换数据策略）。

## 第 5 步：提交 + 推送 + 汇报
```bash
cd /workspace
git add data/nnue/etl_hkp_stats.json
git commit -m "data(M6): HalfKP 训练统计（王桶耦合，HF 500万源）"
git push origin main
```

贴回：HEAD / ETL kept / best val_mse + corr（对比 0.75）/ 训练耗时 / 判断与理由 / commit hash。

## 环境说明
- 8 核 CPU，训练 500 万 × 20 epochs 预计 1-2 小时（稀疏累加器，比 dense 快）。
- 若 parquet 需重新下载，走 `curl -L -C -` 断点续传。
- 铁律：corr 只是预筛，最终仍只认对局；本阶段判断只决定"是否值得投入引擎集成"。
