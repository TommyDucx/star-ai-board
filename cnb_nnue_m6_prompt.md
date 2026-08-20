# NNUE 增量引擎对局验证（M5 Phase 3）—— CNB 云 agent 提示词

你是一个国际象棋引擎开发助手。请在云环境（Linux）里完成增量 NNUE 引擎的**训练（早停）→ golden test → 冒烟 → 对局验证**。

## 背景

- **Phase 1（已完成）**：fixed-color .scnn（30.2 万局面）+ 增量架构（acc128→32→32→1）训练，val_mse 0.008、corr 0.32（偏弱但通过预筛）。
- **Phase 2（已完成，本地 commit `8410a97`）**：`nnue.rs` 重写为 v2 增量累加器 + `search.rs` 累加器栈集成。
  - 增量 eval 成本 ~µs，搜索深度已恢复（本地 depth 12 可搜；M3 静态 CNN 同深度要 66s）。
  - golden test v2（PyTorch vs Rust）max_diff=0.0 PASS；delta 单元测试 PASS。
- 本阶段目标：**用对局判断增量 NNUE eval 是否够格**（铁律：最终只认对局）。先 pilot 40 局，合格再 500 局。

## ⚠️ 约束
1. **只用仓库自带脚本**（`train_nnue_incremental.py` / `golden_nnue.py` / `match.py` / `data-etl`），禁止自造脚本、禁止改脚本/引擎代码。
2. 只跑指定步骤与参数。
3. **跑完必须 commit+push**（`nnue_inc.bin` + 评测报告），结果贴回复。

## 第 0 步：拉取代码
```bash
cd /workspace
git fetch origin && git reset --hard origin/main
git log --oneline -1    # 应显示 8410a97（Phase 2 引擎集成）
ls my-engine/nnue/src/nnue.rs my-engine/policy/train_nnue_incremental.py
```
> HEAD 不对先告诉我，别继续。

## 第 1 步：编译引擎
```bash
cd /workspace
cd my-engine/nnue && cargo build --release && cargo build --release --bin nnue_eval && cd ../..
ls -la my-engine/nnue/target/release/my-engine-nnue my-engine/nnue/target/release/nnue_eval
```

## 第 2 步：重新训练（早停，取 best-val 权重）
Phase 1 的模型是 epoch39（val 已过拟合回升）；训练器现在**自动保存 best-val**（约 epoch 2-4），重训一次拿最优权重：
```bash
cd /workspace
# 若 data/nnue/train_fc.scnn 不存在（工作区被清），先重建：
#   gzip -dc data/eval_labels.txt.gz | ./data-etl/target/release/data-etl --input - --stm-cp --fixed-color \
#     --output data/nnue/train_fc.scnn --stats data/nnue/etl_fc_stats.json
python3 my-engine/policy/train_nnue_incremental.py \
  --scnn data/nnue/train_fc.scnn --epochs 40 --batch 256 --lr 3e-3
```
贴：`best val_mse = ...` 及对应 epoch。

## 第 3 步：golden test（必过）
```bash
cd /workspace
python3 my-engine/policy/golden_nnue.py \
  --nnue my-engine/policy/nnue_inc.bin \
  --fens my-engine/policy/golden_fens.txt \
  --rust-bin my-engine/nnue/target/release/nnue_eval
```
**必须输出 `GOLDEN TEST PASS`**（max_abs_diff < 1e-3）。FAIL 就贴结果停，不要继续。

## 第 4 步：冒烟 + 深度检查（核心验证：深度恢复）
```bash
cd /workspace/my-engine/nnue
cp ../policy/nnue_inc.bin ./nnue.bin
printf 'uci\nsetoption name Eval value nnue\nisready\nposition startpos moves e2e4 e7e5 g1f3 b8c6 f1b5\n\ngo movetime 300\nquit\n' \
  | ./target/release/my-engine-nnue 2>/dev/null | grep -E "info depth" | tail -1
rm -f nnue.bin
```
**关键观察**：movetime 300ms 下 NNUE 侧应能搜到 **depth 10+**（M3 静态版只能 depth 1-2）。若仍深度塌陷（<6），说明集成有问题，停下报告。

## 第 5 步：Pilot 40 局（同一二进制，仅 Eval 不同）
A = `Eval=handcrafted`（默认，等价 v2_smp），B = `Eval=nnue`：
```bash
cd /workspace
python3 match.py --eng my-engine/nnue/target/release/my-engine-nnue \
  --name-a handcrafted --name-b nnue \
  --nnue-b my-engine/policy/nnue_inc.bin --eval-b nnue \
  --games 40 --movetime 300 --concurrency 8 --threads-a 1 --threads-b 1 \
  --out match_nnue_pilot.json
cat match_nnue_pilot.json
```

## 第 6 步：决策门（如实判断）
- **合格**：NNUE 与 handcrafted 接近（Elo 差 <100，或 NNUE 占优）→ 跑 500 局定论：
```bash
python3 match.py --eng my-engine/nnue/target/release/my-engine-nnue \
  --name-a handcrafted --name-b nnue \
  --nnue-b my-engine/policy/nnue_inc.bin --eval-b nnue \
  --games 500 --movetime 300 --concurrency 8 --threads-a 1 --threads-b 1 \
  --out match_nnue_500.json
cat match_nnue_500.json
```
- **明显偏弱**（Elo 差 >>100）：eval 质量问题。贴 pilot 结果与理由，**不跑 500 局**（省核时）。下一步方向 = 加数据（并入 HF Lichess 源）或升级 HalfKP。
- **深度塌陷**（<6 层）：集成 bug，停下报告。

## 第 7 步：提交 + 推送 + 汇报
```bash
cd /workspace
cp my-engine/policy/nnue_inc.bin my-engine/policy/nnue.bin
git add my-engine/policy/nnue.bin match_nnue_*.json
git commit -m "data(M5): 增量 NNUE 训练(best-val)+pilot/500局评测报告"
git push origin main
```
> `nnue.bin`（~0.41MB）入库供后续部署；`.scnn`/`.pt` 在 gitignore，勿 push。

贴回：
1. HEAD 确认 + 编译成功；
2. best val_mse / 对应 epoch；
3. golden test max_abs_diff + PASS/FAIL；
4. 冒烟 depth（movetime 300 的 info depth）；
5. pilot 40 局 JSON（或 500 局 JSON）+ 你的决策与理由；
6. commit hash。

## 环境说明
- 8 核：`match.py --concurrency 8`（8 局并行 × 每局 1 线程）。
- 训练 CPU 即可（10.3 万参数，`.scnn` memmap）。若 data/nnue/train_fc.scnn 丢失，按第 2 步注释重建（data-etl 在 data-etl/target/release/data-etl）。
- 铁律提醒：本阶段结论**只以对局为准**；val/深度只是辅助观测。
