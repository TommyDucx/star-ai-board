# Texel Tuning 重做（冻结攻王权重 + CCRL 116 万高质量数据）—— CNB 云 agent 提示词

你是一个国际象棋引擎开发助手。请在云环境里帮我**重做一次 Texel 调参**。上次用引擎自对弈数据（5.8 万局面）调参，因「攻王权重过拟合」实测 −61.4 Elo 失败。这次有两个关键改进：① 用 CCRL 顶级/中等引擎对局清洗出的 **116 万高质量局面**（结果客观、多样）；② **冻结全部攻王权重**（katt_* + 兵冲锋），只调子力值/兵形/车线/通路兵/王盾这些安全参数。

## ⚠️ 重要约束
1. 只用仓库自带的脚本（`texel_tune.py` / `texel_apply.py` / `match.py`），禁止自造脚本。
2. 只跑下面指定的步骤，不要额外加实验、不要改任何脚本逻辑。
3. 调参用 `--freeze` 默认值（冻结 katt_queen/katt_rook/katt_knight/katt_bishop/katt_pawn/pawn_storm），**不要去掉冻结**。

## 项目背景
自研 Rust 引擎（`my-engine`）。eval.rs 的 25 个标量参数是手工调的，上次 Texel 用 self-play 数据调参，攻王权重暴涨（katt_knight +59）导致引擎在进攻局面误判已占优、激进剪枝、忽略防守，−61.4 Elo。这次用 CCRL 数据（客观结果）+ 冻结攻王权重，规避这个失败模式。

## 第 0 步：拉取代码
```bash
cd /workspace
git fetch origin
git reset --hard origin/main
git log --oneline -1    # 应显示 a9c9cb3（texel_tune.py 冻结功能）
```
预期 HEAD = `a9c9cb3`。确认 `data/ccrl_texel.txt.gz`（116 万局面，13MB）在仓库里。

## 第 1 步：准备环境 + 解压数据
```bash
pip install numpy python-chess
cd /workspace
gzip -dc data/ccrl_texel.txt.gz > /workspace/ccrl_texel.txt
wc -l /workspace/ccrl_texel.txt     # 应约 1166102 行
head -2 /workspace/ccrl_texel.txt  # 格式应为 FEN<TAB>result，result 为 1.0/0.5/0.0
```

## 第 2 步：跑 Texel 调参（冻结攻王权重）
```bash
cd /workspace
python3 texel_tune.py --data /workspace/ccrl_texel.txt \
  --epochs 200 --lr 0.05 --out /workspace/tuned_params.json
```
- 脚本会打印「冻结 6 个参数: [katt_queen, katt_rook, katt_knight, katt_bishop, katt_pawn, pawn_storm]」——确认这行出现。
- 特征提取 116 万局面约 20~30 分钟（单进程 CPU），属正常，耐心等待。
- 记录：初始 loss、最终 loss、以及调参结果表（每个参数 初始 → 调后，冻结项应标注 [冻结] 且值不变）。

## 第 3 步：写回 eval.rs
```bash
cd /workspace
python3 texel_apply.py --params /workspace/tuned_params.json --eval-rs my-engine/src/eval.rs
# 验证写回（关键常量应变化、katt_* 应保持原值）
grep -E "const (KATTACK|PAWN_STORM|BISHOP_PAIR|DOUBLED|PASSED_BONUS)" my-engine/src/eval.rs
```
注意：`texel_apply.py` 会把 tuned_params.json 里的值写回 eval.rs 的具名常量。冻结的 katt_* 值不变（因为调参时冻结了），这是预期行为。

## 第 4 步：编译新旧两个版本
```bash
cd /workspace/my-engine
# 旧版（调参前，HEAD a9c9cb3 的原始 eval.rs）
git checkout a9c9cb3 -- src/eval.rs
cargo build --release && cp target/release/my-engine /tmp/eng_old

# 新版（texel_apply 写回后的 eval.rs）
# （上面 texel_apply.py 已修改了 src/eval.rs，此刻就是新版）
cargo build --release && cp target/release/my-engine /tmp/eng_new

# 冒烟：确认两个引擎都能正常走子
for b in eng_old eng_new; do
  printf 'position startpos\ngo depth 6\nquit\n' | /tmp/$b 2>/dev/null | grep bestmove && echo "$b OK"
done
```

## 第 5 步：400 局对弈验证
```bash
cd /workspace
python3 match.py \
  --eng-a /tmp/eng_new --eng-b /tmp/eng_old \
  --policy-a /workspace/my-engine/policy.bin --policy-b /workspace/my-engine/policy.bin \
  --games 400 --concurrency 4 --movetime 300 \
  --threads-a 1 --threads-b 1 \
  --name-a tuned --name-b old \
  --out /tmp/match_texel2.json
```
- A 方 = 调参后（tuned），B 方 = 调参前（old）。
- 若 `elo_diff_A_minus_B` 为正，说明这次调参涨棋力；为负则失败。

## 第 6 步：汇报 + 提交（必做）
1. 把以下信息贴到回复里：
   - 冻结参数确认行、初始 loss、最终 loss；
   - 调参结果表（重点：katt_* 是否冻结不变、子力值/兵形/通路兵/王盾变化多少）；
   - `/tmp/match_texel2.json` 完整内容（胜负和、Elo 差、95% CI、LOS）。
2. **不要把调参后的 eval.rs 提交**（除非对弈验证正向且你被要求采纳）。工作区保留即可，结果以回复为准。

## 环境说明
- 8 核机器：调参特征提取是单进程（~30 分钟），对弈 `--concurrency 4`（每槽 2 引擎进程，4×2=8 核正好吃满）。
- 400 局对弈约 70 分钟。
- 若中途某步崩溃，从失败那步重跑，不要重跑已完成步骤。

## 结果判断（供参考，最终由我分析）
- 正 Elo 且 LOS > 95% → 调参成功，可采纳（我再决定是否提交 eval.rs + 同步树莓派）；
- 正 Elo 但未过 95% → 方向正向，需更多局坐实；
- 负 Elo → 失败，回滚（`git checkout -- my-engine/src/eval.rs`）。
