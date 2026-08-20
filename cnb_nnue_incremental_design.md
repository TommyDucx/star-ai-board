# NNUE 增量推理实现方案（M5，HalfK-768 → 增量累加器）

> 目标读者：本地 agent（我）实现引擎代码 / 云 agent 跑训练与对局。
> 前提：M0–M4 已完成——数据管线跑通、M3 静态 CNN 接入 eval.rs（UCI `Eval` 开关）、
> M4 pilot 0-40（静态 NNUE eval ~100x 慢 → 搜索深度塌陷）。本方案解决"eval 太慢"。

---

## 一、背景：为什么静态 CNN 必败

| 指标 | 手写 eval | M3 静态 CNN | 目标（增量 NNUE） |
|---|---|---|---|
| 每节点 eval 成本 | ~4K ops | ~390K MACs | ~5K MACs + 增量维护 |
| 相对手写 | 1x | ~100x | ~1.5x |
| 300ms 内搜索深度 | 10–11 | 1–2（0-40） | 10+（可竞争） |

**结论**：静态 CNN 的棋力瓶颈不在 eval 质量（golden test 一致、能学习），而在**每节点全量重算 390K MACs**。NNUE 的经典解法 = **增量累加器**：把"特征 → 第一个线性层"的结果（累加器）在搜索过程中**逐层增量维护**，eval 时只跑小头网络。

## 二、架构：HalfK-768 fixed-color → 累加器(128) → 小头

```
输入: 768 个二进制特征（12 通道×64 格，FIXED-COLOR，白=0-5/黑=6-11）
        ↓ Linear(768→128) —— 只在局面装载时全量算一次（~98K MACs）
累加器: acc[128]（搜索中增量维护，每步只改 2-3 个特征对应的列）
        ↓ relu
h1[128] → Linear(128→32) → relu → h2[32] → Linear(32→32) → relu → h3[32]
        ↓ Linear(32→1)
z（logit）→ sigmoid → 白方胜率
```

**参数**：103,649（≈M3 静态版 135K），`.bin` 约 0.41MB。

### 2.1 为什么必须 fixed-color（关键设计决策）

现有 M3 的 HalfK-768 特征是 **stm 视角**（黑走时颜色互换）。颜色互换意味着"轮走方翻转"时**全部 768 个特征都变**——增量更新无从谈起（每层都要全量重算）。

**改成 fixed-color**：白棋固定进通道 0-5、黑棋 6-11，不随 stm 变。于是：
- 一步棋只改变 **2–3 个特征**（动子 from/to + 被吃的子）→ 累加器增量更新 2-3 个 128 维列（~400 ops）。
- 网络输出 = **白方胜率**（`eval_white`），引擎侧按 stm 取负（与手写 `evaluate`/`eval_stm` 完全同构）。

> 等价性验证：棋盘旋转/镜像**不保持** SF eval（M0 实测 rot90 519→-74），故**无 D4 增广**；颜色互换严格保持 eval（M0 已验证），fixed-color 编码不破坏这一性质，只是把"翻色"从特征里拿出来放到引擎侧取负。

### 2.2 增量更新规则（每步 2-3 列）

对 `acc = W_a @ x + b_a`（x 稀疏，非零=棋盘上的每个子）：
- 安静走子：`acc += -col(from_sq旧子) + col(to_sq新子)`（2 列）
- 吃子：`acc += -col(from) - col(被吃子) + col(to)`（3 列）
- 升变：from 兵列移除 + to 升变子列加入（2 列，子型不同）
- 王车易位：4 子移动 → 最多 8 列更新（罕见，直接 8 列加减即可）
- 吃过路兵：3 列

**特例**：被将军时 qsearch 的"不真实走子"（如空着 null move）不改变棋盘 → 累加器不变，直接复用父节点值。

### 2.3 eval 成本预算

- 每节点 eval（头网络）：`128 + 128×32 + 32×32 + 32 ≈ 5K MACs` ← 与手写 eval 同量级 ✅
- 每步增量维护：2-3 × 128 ≈ **400 ops** ← 几乎免费 ✅
- 结论：搜索深度可恢复到与手写 eval 相当（10+ 层），NNUE eval 质量开始生效。

## 三、数据管线（已完成脚本改造）

`data-etl` 新增 `--fixed-color`：特征**不翻色** + 标签转 `eval_white`（白方视角）。
- 教师标签源：`gzip -dc data/eval_labels.txt.gz | data-etl --stm-cp --fixed-color ...`
  （`--stm-cp` 表示输入 cp 已是行棋方视角 → `eval_white = stm_white ? cp : -cp`）
- HF Lichess 源：cp 本就是白方视角 → `eval_white = cp`，同样走 `--fixed-color`。

已本地验证：300 条与 python-chess 不翻色编码逐位一致 + eval_white 标签正确（PASS）。

## 四、训练（云 agent，Phase 1）

`train_nnue_incremental.py`（已就绪）：
- 读 fixed-color `.scnn`（memmap），标签 `T = sigmoid(eval_white/400)`，MSE。
- 架构与 Rust 推理逐层对应（`nnue.bin` 头 version=2 区分 M3 静态版）。
- 数据量：优先教师标签 30.2 万（搜索后 eval 范式）；若 val 质量不足，扩展（再跑 make_eval_labels 或并入 HF 数据）。
- **质量预筛（数据侧代理，最终仍以对局为准）**：val MSE 应显著低于随机（~0.25），corr 明显 >0；与 M3 静态 CNN 的 val 对比作为参考——累加器架构更弱，val 略差可接受，但若完全学不动（corr≈0）则停。

## 五、引擎集成（本地代码，Phase 2）

### 5.1 nnue.rs 新架构（version 2）
- 用 `nnue_inc.bin`（version=2）加载 acc/head 权重。
- `predict_logit(features) -> f32`：relu 链式小头（~5K MACs）。
- `features_from_board`（fixed-color，不翻色）—— 与 data-etl `--fixed-color` 逐位一致（golden test 验证）。

### 5.2 search.rs 累加器栈（关键改造）
当前搜索用 `board.make_move_new(mv)`（不可变拷贝）。累加器作为**独立的栈**与棋盘同步维护：

```rust
struct Searcher {
    acc_stack: Vec<[f32; 128]>,   // 每层一个累加器；acc_stack[ply] = 第 ply 层局面
    nnue: Option<Arc<Nnue>>,
}
// 装载局面（position 命令）时：acc_stack[0] = W_a @ features(board)
// 走子进入子节点时：acc_stack[ply+1] = acc_stack[ply] + delta(board, mv)   // 2-3 列
// 返回父节点时：pop
```

改造点：
1. `make_move_new` 的调用处（root_search / quiesce / alpha_beta）在递归前算 `delta(board, mv)` 并 push，返回前 pop。
2. eval 调用点（qsearch stand_pat / futility / 静态 eval）在 NNUE 模式下改读 `acc_stack.last()` 的头网络输出：
   `cp_stm = ±(173.7 * head(acc_stack.last()))`（白走取正，黑走取负）。
3. 非 NNUE 模式完全走原路径，行为零变化（隔离在 nnue/ 路线，不动 handcrafted/）。

### 5.3 golden test
`golden_nnue.py` 扩展：加载 `nnue_inc.bin`(v2) → PyTorch 头网络输出 vs Rust `nnue.rs`(v2) 前向，max diff < 1e-3。

## 六、对局验证（云 agent，Phase 3）

1. **golden test**（必过，PASS 才继续）。
2. **pilot 40 局**：`my-engine/nnue/target/release/my-engine-nnue`（`setoption Eval nnue`）vs
   `my-engine/handcrafted/target/release/my-engine`（默认手写），`match.py --eval-b nnue --threads 1 --movetime 300`。
   - **关键观察**：NNUE 侧搜索深度是否恢复到 ~10（不再塌陷）——这是本次的核心修复目标。
3. **决策门**：
   - 深度恢复 + 成绩接近（Elo 差 <100）→ 跑 500 局定论。
   - 深度恢复但 eval 明显偏弱（Elo 差 >>100）→ eval 质量问题，查数据/架构（升级 HalfKP 见下）。
   - 深度仍塌陷 → 集成有 bug，回查累加器栈。

## 七、升级路径（M6，本轮不做）

- **HalfKP + 王桶**：特征索引耦合王格（`(piece, piece_sq, king_bucket)`），可学习"子力对王的相对价值"（王翼攻防/残局王近战）。王移动换桶时全量重算累加器（罕见，成本可接受）。
- **整数量化**（i32 累加器 + i8 头，SF 风格）：再降 2-4x 速度 + 更小模型。
- **搜索后 self-play 标签**：最终标签源仍为"教师引擎深搜 eval + 增量更新"，与本文架构天然兼容（特征/累加器不变，只换标签生成）。

## 八、里程碑与分工

| 阶段 | 内容 | 执行者 |
|---|---|---|
| Phase 1 | data-etl `--fixed-color` + 训练 + 质量预筛 | **云 agent**（提示词：cnb_nnue_m5_prompt.md）|
| Phase 2 | nnue.rs v2 + search.rs 累加器栈 + golden test | **本地**（我）|
| Phase 3 | golden test + pilot 40 局 +（合格则）500 局 | **云 agent**（Phase 2 完成后新提示词）|

**铁律**：eval 任何改动最终只以对局（500+ 局）定论；Phase 1 的 val 只是预筛（省钱），不是结论。
