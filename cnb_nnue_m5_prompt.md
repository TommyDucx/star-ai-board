# NNUE 增量架构训练 + 质量预筛（M5 Phase 1）—— CNB 云 agent 提示词

你是一个国际象棋引擎开发助手。请在云环境（Linux）里为**增量 NNUE** 架构训练评估模型并做质量预筛。这是增量 NNUE 工程的第一阶段（数据 + 训练），**不碰引擎代码、不做对局**。

## 背景（务必先读 `cnb_nnue_incremental_design.md`）

- M3 静态 CNN eval 每个节点 ~390K MACs，是手写 eval 的 ~100 倍 → 搜索深度塌陷 → pilot 0-40。
- M5 改为**增量累加器架构**：`768 特征(fixed-color) → Linear(128) 累加器 → relu → 32→32→1`（~5K MACs/节点，深度可恢复）。
- **fixed-color** 是关键：特征不随轮走方翻色（否则增量无从谈起），标签改为 **eval_white**（白方视角）。
- 本阶段目标：用教师深搜 eval 标签（`data/eval_labels.txt.gz`，40 万行）训练该架构，报告 val 质量，作为是否值得投入引擎集成的预筛。

## ⚠️ 约束
1. **只用仓库自带脚本**（`data-etl` / `train_nnue_incremental.py`），禁止自造脚本、禁止改脚本逻辑/参数。
2. 只跑下面指定步骤与参数，不要额外实验。
3. **跑完必须 commit+push**（本轮无模型入库——`nnue_inc.bin` 先不推，等 Phase 2 引擎侧 golden test 后再定；本轮 push 统计文件即可），并把关键输出贴到回复里。

## 第 0 步：拉取代码
```bash
cd /workspace
git fetch origin && git reset --hard origin/main
git log --oneline -1    # 应显示 b2a785f（my-engine 拆分 handcrafted/nnue）
ls data/eval_labels.txt.gz
ls my-engine/policy/train_nnue_incremental.py
```
> 若 HEAD 不对或脚本缺失，先告诉我，别继续。

## 第 1 步：编译 data-etl（含 --fixed-color）
```bash
cd /workspace
cd data-etl && cargo build --release && cd ..
ls -la data-etl/target/release/data-etl
```

## 第 2 步：教师标签 → fixed-color .scnn
```bash
cd /workspace
mkdir -p data/nnue
gzip -dc data/eval_labels.txt.gz \
  | ./data-etl/target/release/data-etl --input - --stm-cp --fixed-color \
      --output data/nnue/train_fc.scnn --sidecar data/nnue/train_fc_sidecar.tsv \
      --stats data/nnue/etl_fc_stats.json
cat data/nnue/etl_fc_stats.json    # 记录 kept_positions（预期 ~30 万）
```
> `--stm-cp` = 教师标签 cp 是行棋方视角；`--fixed-color` = 特征不翻色 + 标签转 eval_white。
> `.scnn` 约 230MB，勿 push（gitignore 已忽略 data/nnue/）。

## 第 3 步：训练增量 NNUE
```bash
cd /workspace
python3 my-engine/policy/train_nnue_incremental.py \
  --scnn data/nnue/train_fc.scnn --epochs 40 --batch 256 --lr 3e-3
```
产出：`my-engine/policy/policy_nnue_inc.pt` + `my-engine/policy/nnue_inc.bin`（version=2）。

## 第 4 步：质量预筛（数据侧，最终仍以对局为准）
把训练日志的关键行贴回（`epoch 最后几行` + `val MAE(cp)` + `corr`）。

**判断门**：
- ✅ **通过**：val_mse 显著低于随机（随机基线 ~0.25），收敛值越低越好；`corr` 明显 > 0（参考：M3 静态 CNN 在 30 万样本上 corr 达到 0.6+ 量级，累加器架构更弱，corr 0.4+ 即可接受）；val MAE(cp) 合理（参考几十 cp 量级）。
- ❌ **不通过**：val_mse 几乎不降（仍 >0.1）或 corr≈0（架构学不动 eval）→ 贴完整日志，**不要继续**，等我决定（可能加数据或改架构）。

## 第 5 步：提交 + 推送 + 汇报
```bash
cd /workspace
git add data/nnue/etl_fc_stats.json
git commit -m "data(M5): 增量 NNUE 训练结果统计（fixed-color .scnn, 教师标签 30 万局面）"
git push origin main
```
> `nnue_inc.bin` 本轮**不 push**（~0.4MB，等 Phase 2 引擎侧 golden test 通过后再由云推送做对局）。

把以下信息贴到回复里：
1. HEAD 确认（b2a785f）+ data-etl 编译成功；
2. ETL stats：`kept_positions`；
3. 训练：末轮 val_mse / val MAE(cp) / corr（含随机基线对比说明）；
4. 你的通过/不通过判断 + 理由；
5. commit hash。

## 环境说明
- 8 核机器；训练用 CPU 即可（10.3 万参数，`.scnn` memmap 读，不会 OOM）。
- 若 `train_nnue_incremental.py` 报错（路径/格式），贴报错回来，不要自行改脚本。
- 本阶段是**预筛**：val 好 ≠ 棋力好（铁律：最终只认对局）。预筛通过后，本地会做 Phase 2 引擎集成，再开 Phase 3 对局验证。
