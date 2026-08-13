# MyEngine 0.2.0 架构说明

> 自研国际象棋引擎：Policy 引导的 α-β 搜索，Rust 手写推理，零外部依赖。
> 依据源码 my-engine/src/ 整理，2026-08-13。

---

## 一、整体框架

```
UCI 协议 (main.rs)
   │  行循环解析 uci / position / go / stop / setoption / quit
   │  负责维护「历史局面键 + 半步计数」(chess crate 的 Board 不保存)
   ▼
Searcher (search.rs)        ← 每次 go 在独立线程运行，搜完归还(保留换位表跨步复用)
   ├─ α-β 迭代加深 + PVS + LMR + 空着/反向前向裁剪
   ├─ Zobrist 换位表 (1M, 带年龄老化)
   ├─ 杀手走法 + 历史启发 + 反证历史
   ├─ 静态搜索 qsearch(SEE) + 将军延伸
   ├─ 重复局面 / 50 步 / 将军 / 逼和 判定
   └─ Policy 引导: 只做 1 次前向，注入整张历史启发表 → 影响所有层排序
         │
         ├─ eval.rs   启发式评估（子力+PST+王安全+兵结构，tapered）
         └─ policy.rs 手写 CNN 推理（8×8×13 → 4096 走法概率）
```

- **UCI 层职责**：`main.rs` 从 `position ... moves ...` 重建棋局，记录「自最后一次不可逆走法后的全部局面键」`hist` 与「半步计数」`halfmove`，喂给搜索——否则引擎看不见重复局面与 50 步规则。
- **线程模型**：`go` 时把 `Searcher` 移到新线程搜索，完成后再 join 归还。`stop` 通过 `AtomicBool` 置位打断，时间到则在搜索内部同样置位。
- **TT 生命周期**：只在 `ucinewgame` 清空，跨步保留上一盘搜索结果是**有意为之**，用「代号老化」淘汰陈旧条目。

---

## 二、搜索流程 (search.rs)

### 1. 迭代加深主循环 `search()`
- 固定全窗 `(i32::MIN+MATE, i32::MAX-MATE)` 迭代加深，深度 1..=max_depth（movetime 模式下深度上限放开到 64，靠时间打断）。
- **已放弃渴望窗口**：实测节点 −0.2%，纯开销，注释中留了教训。
- 每次迭代产出 `info depth … score cp … pv …`（走 stderr）。

### 2. 根节点 `root_search()`
- 排序：`order_score` 基准 + `policy 概率 × 1000` 加权。
- 走子前把根局面压入 `path`，使子节点能识别「走回根局面」的重复。
- 失败低/高位仍写 TT（flag 2/1），避免下一迭代命中错误的"精确值"。

### 3. 内部节点 `alpha_beta()`
按顺序执行：
1. **时间检查**（每 4096 节点一次）+ 将杀/逼和判定。
2. **和棋判定**：`halfmove >= 100` 或 `path`/`game_hist` 重复 → 0 分（空着子树内 `null_ply>0` 时关闭此判定，避免假和值污染空着裁剪）。
3. **将军延伸**：前沿仍被将军时多搜一层（ply<48 上限）。
4. **TT 探测**：命中且深度足够按 flag 返回/收窄窗口；否则取 hash move 排序。key 用 `get_hash()`(含吃过路兵) + 显式混入行棋方 —— 补偿 chess 3.2.0 的两个坑（Hash 不含 EP；null_move 不翻转 SIDE_TO_MOVE 项）。
5. **反向前向裁剪**：浅层非将军节点静态分 − 110×depth ≥ beta → 直接返回。
6. **空着裁剪**：depth≥3、非将军、且行棋方有非兵非王子力（zugzwang 保护），R=2/3。
7. **PVS + LMR**：第 1 手全窗；后续走法减深空窗试探（LMR：depth≥3 且 mv_count≥4 的安静走法，减 1~2 层），超 alpha 再按原深度重验，仍需扩窗时全窗重搜。
8. **裁剪（已移除）**：LMP + 前向 futility 实测 Elo −69.7，代码中留了完整教训注释，勿加回。
9. **截断时更新**：杀手走法、历史启发 `+depth²`（夹到 1<<24）、**反证历史**（对本次截断前未截断的安静走法 −depth² 惩罚）。
10. 写入 TT（时间被打断时不写，防哨兵污染）。

### 4. 静态搜索 `quiesce()`
- 叶节点继续搜「吃子/升变/吃过路兵」，消除 horizon effect。
- 被将军时不能 stand-pat，必须搜全部合法应着。
- **SEE 裁剪**：静态必亏的吃子直接不搜（升变除外）。
- 时间到返回哨兵 0，子搜索的哨兵不得用于更新 alpha/截断。

### 5. 走法排序 `order_score()`
```
hash move        1_000_000
吃子 MVV-LVA     100_000 + 10×victim − attacker (+50_000 升变)
升变             90_000 + 100
杀手1            80_000
杀手2            70_000
历史/policy      min(history, 60_000)   ← policy 概率×20000 注入
```
- 历史分必须夹在 60_000（killer 之下），否则累积的安静走法会压过吃子/杀手。
- **SEE 排序已回滚**：用 SEE 把亏子吃子降级实测节点 +14%，保留纯 MVV-LVA。

### 6. SEE `see()`
目标格静态换子清算，返回行棋方视角净得分。近似：不校验王吃合法性（王价值 20000，影响可忽略）、升变近似为"当场变子"。

---

## 三、评估函数 (eval.rs)

全部从**白方视角**返回（正=白优），`eval_stm()` 再按行棋方取号给 negamax 用。

| 组成 | 说明 |
|---|---|
| 子力价值 | P100/N320/B330/R500/Q900/K20000 |
| PST 位置表 | 6 张按视觉顺序书写（行0=rank8）；白方用 `63-idx` 翻转、黑方直接 idx（**已修复的方向 bug**） |
| 王位置 | 中局表与残局表按 game phase **线性插值**（tapered eval），残局王抢中心 |
| 王翼掩护 | 王前两格 × 有兵（第1行+12/第2行+8），按阶段缩放 |
| 兵结构 | 叠兵 −15/个、孤兵 −20、通路兵 +[0,5,10,20,35,60,100]（按推进行数） |
| 双象 | +30 |
| 车占线 | 开放线 +20 / 半开放线 +10 |

- 单遍扫描棋盘收集特征，phase = N/B+1, R+2, Q+4，开局 24 = 纯中局，0 = 纯残局。

---

## 四、Policy 网络 (policy.rs)

手写推理，零依赖，**模型与训练端 torch 完全对应**。

### 网络结构（~33.6 万参数）
```
输入  8×8×13    12 个棋子色块 + 轮走方(黑=1)   row0=rank8
Conv1 13→16     3×3, pad=1, ReLU
Conv2 16→16     3×3, pad=1, ReLU   → 16×64=1024
FC1  1024→64    ReLU
FC2  64→4096    logits = from*64+to 走法概率
Softmax → 概率
```

### 模型文件 policy.bin
- 1.34MB float32 顺序拼接：`conv1_w/b → conv2_w/b → fc1_w/b → fc2_w/b`。
- 由 `policy/export_weights.py`（读 `policy.pt`）导出，`policy/validate_policy.py` / `policy_golden_test.py` 校验 Rust 推理与 PyTorch 输出一致。
- **加载路径**：优先二进制同目录 → `./policy.bin` → `my-engine/policy.bin` → `my-engine/policy/policy.bin`。

### Policy 引导方式
- root 走法按 `概率 × 1000` 加权排序。
- 关键设计：4096 个输出恰好与 history 表下标同构，**只做 1 次前向，把整张概率注入历史启发表（×20000）**，让 policy 在**所有层**参与排序而非仅根节点。
- 量级控制在 killer(70_000) 之下，只影响"安静走法"内部排序，不压过战术信号。
- 可用 `setoption name Policy value false` 关闭做对照实验。

---

## 五、UCI 特性

| 命令 | 行为 |
|---|---|
| `uci` | 上报 `MyEngine 0.2.0`，option `Policy`(check, default true) |
| `isready` | `readyok` |
| `position startpos/fen … moves …` | 重建棋局 + 历史键 + 半步计数（不可逆走法后丢弃旧历史） |
| `go` | 支持 depth / movetime / wtime / btime / winc / binc；时间分配 `time/30 + inc/2`（夹 50..5000ms） |
| `stop` / `quit` | AtomicBool 置位 + join 线程 |
| `info` | 走 stderr（`eprintln`），`bestmove` 走 stdout |

---

## 六、训练与导出管道 (my-engine/policy/)

```
data/final_dataset.jsonl (FEN + bestmove_uci)
      │  train_policy.py：8× D4 对称增广 + 合法着法过滤 + 标签同步变换
      ▼
PolicyNet (torch) 40 epochs, Adam lr=2e-3, StepLR(15,0.3)
      │  policy.pt
      ▼
export_weights.py → policy.bin (float32 拼接)
      │
      ▼
policy.rs 手写推理  +  validate_policy.py / policy_golden_test.py 比对
```

---

## 七、关键教训（已踩坑，代码注释留档）

1. **TT key 双坑**：chess 3.2.0 的 `Hash for Board` 不含吃过路兵；`null_move()` 不翻转行棋方 XOR → 空着子树会把反号分值写进 TT 污染搜索。
2. **TT 老化**：无「代」概念时深条目占死槽位，命中率持续下降。
3. **PST 方向**：表按视觉顺序写，白方必须 `63-idx` 翻转。
4. **渴望窗口无效**：节点 −0.2% 纯开销，已回退。
5. **LMP/前向 futility 有害**：节点 −60% 但 Elo −69.7，节点基准不能代理棋力，已移除。
6. **SEE 排序有害**：节点 +14%，已回退到纯 MVV-LVA。
7. **时间打断必须挡在 TT 写入前**：否则哨兵分值污染换位表并残留整局。
8. **反证历史**：对未截断的安静走法记惩罚，等价重排序，可用节点基准验证。

---

## 八、当前棋力定位

入门级：vs Stockfish Elo 800 约 50–77 步落败。后续方向见 AGENTS.md「十、下一步建议」。
