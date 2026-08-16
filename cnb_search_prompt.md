# 搜索侧优化对弈验证（IID + TT age）—— CNB 云 agent 提示词

你是一个国际象棋引擎开发助手。请在云环境里帮我验证两个**搜索侧**优化（纯代码改动，不涉及 Policy/数据），用大样本对弈坐实它们是否真的涨棋力。

## ⚠️ 重要约束（必须遵守，禁止自作主张）
1. **只用仓库自带的 `match.py`**，禁止自写任何 supervisor/watcher/对弈脚本。
2. **只跑下面指定的两个对比**，不要额外加实验、不要改参数、不要改任何脚本逻辑。
3. **禁止修改任何代码/脚本**——你只需要 `git checkout` 到指定 commit、编译、对弈、贴结果。
4. 两个对比各 400 局，不要多跑也不要少跑。

## 项目背景
自研 Rust 国际象棋引擎（`my-engine`，入门级）。此前数据/评估侧优化连续 6 次失败（残差 CNN、数据加权、Stockfish 标签、Texel 调参等，全部负收益），唯一确定性正向是搜索侧结构优化（Lazy SMP 多线程 +51 Elo）。现在要验证两个新的搜索侧改动：

- **IID（内部迭代加深）**：PV 节点 TT 无 hash move 时先浅搜一遍改善走法排序。commit `60ec644`。
- **TT age 换代修复**：把 TT 的 age 换代从"每次迭代加深"改为"每次 go 一次"，修复多线程重复换代导致命中率下降。commit `449e4eb`。

## 第 0 步：拉取代码并确认版本
```bash
cd /workspace
git fetch origin
git reset --hard origin/main      # 若目录已是仓库且干净，可 git pull --ff-only origin main
git log --oneline -1              # 必须显示 60ec644 是 HEAD
```
预期 HEAD = `60ec644`（feat: IID 内部迭代加深…）。如果对不上，先 `git reset --hard origin/main` 再确认。

## 第 1 步：编译 4 个版本
同一工作区顺序 checkout 到不同 commit 编译（cargo 增量编译，每次很快）。`policy.bin` 在各 commit 间一致，无需单独处理。

```bash
cd /workspace/my-engine

# 1. IID 新版（当前 HEAD 60ec644）
cargo build --release && cp target/release/my-engine /tmp/eng_iid_new

# 2. IID 旧版（IID 之前 1d695bd，含 TT age）
git checkout 1d695bd && cargo build --release && cp target/release/my-engine /tmp/eng_iid_old

# 3. TT age 新版（449e4eb，含 TT age 修复）
git checkout 449e4eb && cargo build --release && cp target/release/my-engine /tmp/eng_ttage_new

# 4. TT age 旧版（4b95527，TT age 修复之前）
git checkout 4b95527 && cargo build --release && cp target/release/my-engine /tmp/eng_ttage_old

# 恢复 HEAD
git checkout main
```

验证 4 个二进制都存在且能响应 UCI：
```bash
for b in eng_iid_new eng_iid_old eng_ttage_new eng_ttage_old; do
  echo "=== $b ==="
  printf 'uci\nisready\nquit\n' | /tmp/$b 2>/dev/null | grep -E "readyok" && echo OK
done
```

## 第 2 步：验证 IID（400 局）
```bash
cd /workspace
python3 match.py \
  --eng-a /tmp/eng_iid_new --eng-b /tmp/eng_iid_old \
  --policy-a /workspace/my-engine/policy.bin --policy-b /workspace/my-engine/policy.bin \
  --games 400 --concurrency 4 --movetime 300 \
  --threads-a 4 --threads-b 4 \
  --name-a iid_new --name-b iid_old \
  --out /tmp/match_iid.json
```
- A 方 = 含 IID，B 方 = 无 IID。若 `elo_diff_A_minus_B` 为正，说明 IID 涨棋力。

## 第 3 步：验证 TT age（400 局）
```bash
cd /workspace
python3 match.py \
  --eng-a /tmp/eng_ttage_new --eng-b /tmp/eng_ttage_old \
  --policy-a /workspace/my-engine/policy.bin --policy-b /workspace/my-engine/policy.bin \
  --games 400 --concurrency 4 --movetime 300 \
  --threads-a 4 --threads-b 4 \
  --name-a ttage_new --name-b ttage_old \
  --out /tmp/match_ttage.json
```
- A 方 = 含 TT age 修复，B 方 = 无。若 `elo_diff_A_minus_B` 为正，说明 TT age 修复涨棋力。

## 第 4 步：贴结果（无需 commit/push）
跑完后，把 **`/tmp/match_iid.json` 和 `/tmp/match_ttage.json` 的完整内容**直接贴到回复里，并按下面格式汇总：

```
【IID】胜负和、Elo 差、95% CI、LOS（iid_new 更强概率）
【TT age】胜负和、Elo 差、95% CI、LOS（ttage_new 更强概率）
```

## 环境说明
- 需 Rust（rustup + cargo）和 python3 + `python-chess`（match.py 依赖）。若环境已重置，先装：`cargo` 编译引擎；`pip install python-chess`。
- 8 核机器：`--concurrency 4` 是安全值（每个槽位开 2 个引擎进程，4×2=8 正好吃满），不要改成 8。
- 400 局 / concurrency 4 / movetime 300 单组约 70 分钟，两组约 2.5 小时。
- 若某组对弈中途崩溃，只重跑崩溃的那一组，不要重跑已完成的那组。

## 结果如何判断（供你参考，最终由我分析）
- 正 Elo 且 LOS > 95% → 该改动成立，可采纳；
- 正 Elo 但 LOS 未过 95% → 方向正向但需更多局坐实；
- 负 Elo → 该改动否定，回滚。
