# STAR 系统架构与工作流程交接文档

> 用途：让新对话（agent）快速了解现有系统，按相同步骤继续开发。
> 更新日期：2026-08-19
>
> 📌 **先读 `WORKING_PRINCIPLES.md`** —— 本地 agent ↔ 云 agent 协作规范（什么时候只写提示词交云 agent、什么时候本地跑、实验验证铁律、git 协作）。

---

## 一、系统架构总览

```
┌───────────────────────── 本地开发机 (Mac) ─────────────────────────┐
│  /Users/tommydu/Documents/Star Chess      ← 唯一权威工作目录        │
│    ├─ server.js          Node WebSocket 服务（围棋+国际象棋引擎网关）│
│    ├─ public/            前端页面（index/chess/go/review.html）     │
│    ├─ my-engine/         自研 Rust 引擎目录（两条技术路线隔离，互不覆盖）│
│    │   ├─ handcrafted/   手写启发式 eval 路线（= 原 v2_smp 引擎，原样保留）│
│    │   │   ├─ src/       eval(子力+PST+王盾+兵形) + search(α-β+TT+killer+SEE)│
│    │   │   │             + policy(8×8×13→4096 手写 CNN) + main(UCI)       │
│    │   │   └─ policy.bin 策略模型                                        │
│    │   ├─ nnue/          NNUE 路线（M3 静态 CNN 已接入，增量推理进行中）  │
│    │   │   └─ src/       main/eval(含 UCI Eval 开关)/search/policy/nnue   │
│    │   └─ policy/        NNUE 训练脚本（train_nnue/qa_nnue/golden_nnue）  │
│    ├─ data-etl/          NNUE 数据 ETL（Rust：清洗+HalfK-768+.scnn）│
│    ├─ data/              训练数据集（final_dataset.jsonl / nnue/）  │
│    ├─ dataset_gen.py / selfplay.py / make_teacher.py / match.py    │
│    └─ train_pipeline.sh / train_self.sh   训练/自对弈脚本           │
│                                                                      │
│  旧目录 /Users/tommydu/Documents/Default Project/star  ← 已废弃     │
│  旧目录 /Users/tommydu/Documents/Default Project/data  ← 数据副本   │
└──────────────────────────────────────────────────────────────────────┘

┌───────────────────────── 树莓派 (部署端) ───────────────────────────┐
│  主机：pi-wildlife2    IP：192.168.0.107（已固定静态 IP，netplan）  │
│  /home/pi/star-ai-board                  ← 运行中的网站+服务        │
│    ├─ server.js / public/（与本地同步）                              │
│    ├─ my-engine/handcrafted/target/release/my-engine  ← aarch64 编译的自研引擎  │
│    ├─ my-engine/policy.bin                ← 策略模型（引擎自动加载）│
│    ├─ public/stockfish    (78MB)                                    │
│    ├─ public/reckless     (65MB, Reckless 0.10，源码编译)           │
│    ├─ public/engines/     ← CCRL 顶级引擎目录（8 个，见第九节清单） │
│    └─ public/katago                                                   │
│  /home/pi/reckless        Reckless 源码（含 networks/*.nnue 权重）  │
│  /home/pi/engines/        CCRL 引擎源码+构建产物（可复编）          │
│  systemd 服务：star-ai-board（端口 8765）                           │
└──────────────────────────────────────────────────────────────────────┘

GitHub：github.com/TommyDucx/star-ai-board  ← 两目录共用的远程仓库
```

---

## 二、服务器与凭据（新对话必读）

| 项目 | 值 |
|---|---|
| 树莓派 SSH | `ssh pi@192.168.0.107`，密码见环境变量 `$PI_PASS`（勿写回文档） |
| 树莓派主机名 | `pi-wildlife2`（Debian 13 aarch64） |
| 网站地址 | `http://192.168.0.107:8765` |
| 网站服务 | `systemctl restart star-ai-board`（systemd） |
| GitHub 仓库 | `https://github.com/TommyDucx/star-ai-board.git` |
| GitHub 推送 Token | 本机凭据存储（`git credential` / keychain），命令里用 `$GITHUB_TOKEN`，勿写回文档 |
| 本地代理（访问 GitHub 等国外站） | `export http_proxy=http://127.0.0.1:1087; export https_proxy=http://127.0.0.1:1087` |
| 树莓派访问 GitHub | ❌ 不通（国内网络），源码/权重需本地中转 |
| 树莓派默认网关/DNS | 192.168.0.1 / 120.196.165.24 |

> ⚠️ 注意：GitHub 直连推送经常失败（Connection reset），**直连失败时务必用上面的本地代理**。
> 树莓派已固定 IP 192.168.0.107（netplan 配置，勿再改）。

---

## 三、SSH/SCP 自动化脚本（expect 模式）

所有远程操作通过 expect 脚本自动输入密码。**新建 expect 脚本**：

```bash
# /tmp/rc.exp —— 远程执行命令
#!/usr/bin/expect -f
set timeout 60
spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 pi@192.168.0.107 {*}$argv
expect {
  "*password:" { send "$env(PI_PASS)\r"; exp_continue }
  "*yes/no*" { send "yes\r"; exp_continue }
  eof
}
```
用法：`PI_PASS=xxxx expect /tmp/rc.exp "systemctl is-active star-ai-board"`

```bash
# /tmp/scp.exp —— 传文件
#!/usr/bin/expect -f
set timeout 300
spawn scp -o StrictHostKeyChecking=no <本地文件> pi@192.168.0.107:<目标路径>
expect { "*password:" { send "$env(PI_PASS)\r"; exp_continue } eof }
```
用法：`PI_PASS=xxxx expect /tmp/scp.exp`

> 坑：expect 脚本的 cwd 与 shell 不同，scp 源文件必须用**绝对路径**。

---

## 四、标准工作流程（按此步骤执行）

### 1. 本地开发
在 `~/Documents/Star Chess` 修改代码（前端 public/、服务 server.js、引擎 my-engine/handcrafted/src/）。

### 2. 同步到树莓派
```bash
cd "/Users/tommydu/Documents/Star Chess"
# 全量同步（排除大二进制/数据/缓存）
tar czf /tmp/star-chess.tar.gz --exclude=.git --exclude=node_modules \
  --exclude=my-engine/handcrafted/target --exclude=my-engine/nnue/target --exclude=data \
  --exclude=public/stockfish --exclude=public/reckless --exclude=public/katago .
expect /tmp/scp.exp   # 传到 /home/pi/star-chess.tar.gz
expect /tmp/rc.exp "tar xzf /home/pi/star-chess.tar.gz -C /home/pi/star-ai-board"
```
> ⚠️ 别覆盖 public/ 下的 stockfish/reckless/katago（树莓派特有二进制，本地 gitignore 没有）。

### 3. 编译自研引擎（树莓派 aarch64）
```bash
expect /tmp/rc.exp "cd /home/pi/star-ai-board/my-engine/handcrafted && \
  export PATH=/home/pi/.cargo/bin:\$PATH CARGO_BUILD_JOBS=4 && cargo build --release"
```

### 4. 重启服务并验证
```bash
expect /tmp/rc.exp "sudo systemctl restart star-ai-board; sleep 2; systemctl is-active star-ai-board"
expect /tmp/rc.exp "journalctl -u star-ai-board -n 5 --no-pager | grep -iE '引擎|engine'"
```
预期日志：`国际象棋引擎: stockfish / reckless / my-engine`

### 5. 页面功能验证（CDP 无头 Chrome 测试）
用 headless Chrome + WebSocket CDP 写 JS 脚本验证（模式见下）。

### 6. 提交并双端推送（cnb + GitHub）
```bash
cd "/Users/tommydu/Documents/Star Chess"
git add <文件>
git commit -m "..."
# ① 推送 cnb（云端 agent 同步源）
git push cnb main
# ② 推送 GitHub：先直连试，失败用代理（token 在本机凭据存储，勿写进命令/文档）
export http_proxy=http://127.0.0.1:1087 https_proxy=http://127.0.0.1:1087
git push origin main
# ⚠️ 两端口径以本地 commit 为准；若任一端 push 失败，另一端也先别重试（避免分叉），先排查
```
> 凭据管理：`git push cnb main` / `git push origin main` 走本机凭据存储（osxkeychain / `~/.git-credentials`），token 不在仓库里明文出现。

---

## 五、页面功能 CDP 验证模板

1. 启动 headless Chrome：`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-port=940X about:blank`
2. Node 脚本连 `http://127.0.0.1:940X/json/version` 的 WebSocket，`Runtime.evaluate` 执行测试
3. 常用断言：
   - 引擎下拉：`[...document.getElementById('engine').options].map(o=>o.value+':'+o.textContent).join('|')` → 应含 `stockfish / reckless / my-engine`
   - 走子：选引擎后 `engineThink()`，等数秒查 `document.getElementById('status').textContent` 与 `__game.history().length`
   - 点击式下棋：向 `.board-b72b1 .square-e2` dispatch `PointerEvent('pointerdown'/'pointerup')`，断言 `window.selectedSq()` 与 `.star-hl.dot` 数量
   - 错误：`window.__errs` 数组应为空
4. **选择器注意**：页面内联 style 中 `rgba(215,255,63,...)` 会被浏览器规范化为 `rgba(215, 255, 63, ...)`（带空格），选择器要写 `[style*="215, 255, 63"]`

---

## 六、自研引擎 my-engine 说明

- **棋力定位**：入门级（vs Stockfish Elo 800 约 50-77 步落败）
- **搜索**：迭代加深 α-β + Zobrist 换位表(4M) + 杀手 + 历史启发 + MVV-LVA + **qsearch(SEE)** + 将军/重复局面/50步规则 + **Lazy SMP 多线程**
- **多线程（Lazy SMP）**：`Threads` 参数控制；TT 用 `Arc<RwLock>` 共享、Policy 用 `Arc` 共享，每线程独立 history/killer/path；实测 4 线程 vs 单线程 **+51 Elo**（96 局，LOS 95.4%）
- **进攻排序**：`order_score` 对安静走法加进攻增益（兵突破 +8000 / 车后进开放线 +8000 / 马象逼近对方王城 +6000），夹在 killer(70000) 之下，属等价重排序
- **Policy 引导**：8×8×13 输入（12 棋子色块+轮走方），2×Conv3×3 + 2×FC → 4096 走法概率；Rust 手写推理（零依赖），policy 概率注入**整张 history 表**（全局排序）+ root 加权；每 `go` 只前向 1 次（约 0.12ms）
- **模型文件**：`policy.bin`（33.6 万参数，1.34MB，float32 拼接，顺序：conv1_w/b、conv2_w/b、fc1_w/b、fc2_w/b）
- **Policy 加载**：优先二进制同目录 → `./policy.bin` → `my-engine/policy.bin` → `my-engine/policy/policy.bin`
- **UCI 参数**：`Policy`(bool, default true) / `PolicyAggressiveness`(0~100, default 50) / `Hash`(MB, default 96) / `Contempt`(0~200, default 50) / `Threads`(1~16, default 1)；`info` 走 stderr（`eprintln`），`bestmove` 走 stdout
- **重新训练**：`python3 my-engine/policy/train_policy.py`（读取 data/final_dataset.jsonl），导出 `policy.bin` 用 `export_weights.py`；训练依赖 torch + onnx + onnxruntime（本地用 miniconda `pfllib` 环境）

> ⚠️ 已实验并否定的方向（**9 连败，勿重试**，详见 memory 日志 2026-08-13 ~ 08-17）：

**数据侧/评估侧 7 连败**（根因：静态 eval/Policy 拟合对局结果 ≠ 搜索棋力，eval 与剪枝耦合）：
> - 残差 CNN + 数据加权重训：−40 Elo（消融定位为「数据过滤+加权」与「残差+FC96」双负贡献，已回滚到无残差 FC64 + 原数据）
> - LMP / 前向 futility：−69.7 Elo（代码注释留档）
> - Stockfish 教师标签：−34.9 Elo（外来标签与引擎 eval 不自洽）
> - 纯 α-β 自蒸馏标签：−34.9 Elo
> - deep 自洽标签（policy 开 + 深搜索）：−6.1 Elo（400 局，未复现 96 局 +47）
> - Texel tuning（self-play 数据）：−61.4 Elo（攻王过拟合，katt_ 暴涨）
> - Texel tuning（CCRL 116 万数据 + 冻结攻王）：**−110.4 Elo**（scale 漂移，子力值砍半/通路兵王盾归零）

**搜索侧精细化 2 连败**：
> - IID 内部迭代加深：−20 Elo（浅搜索引擎 300ms 仅 10-11 层，浅搜成本收益比不划算）
> - TT age 换代上移：−38.4 Elo（迭代加深每次换代是「清旧促新」的特性，不是 bug）

**铁律**：任何影响「走法排序 / eval / 剪枝」的改动，只能用对局验证（500+ 局），不能用 loss/val_top1/节点数代理，也不能用「理论分析」判定某处是 bug/优化。小样本 Elo 不可信（+47 都可能是噪声）。

---

## 七、数据与训练管道

| 文件 | 说明 |
|---|---|
| `data/final_dataset.jsonl` | 7,383 条训练数据（自对弈 5,907 + Lichess 1,476，80/20） |
| `data/selfplay.jsonl` / `selfplay.pgn` | 自对弈原始数据 |
| `dataset_gen.py` | 数据集生成（Lichess 攻击局 + 自对弈） |
| `selfplay.py` | 自对弈生成器 |
| `make_teacher.py` / `make_self_teacher.py` | 教师数据（self-teacher 训练） |
| `match.py` | UCI 引擎对弈器（树莓派上也可跑） |
| `train_pipeline.sh` / `train_self.sh` | 训练流水线脚本 |

数据管道：`dataset_gen.py`（或 `selfplay.py`）→ `merge_dataset.py` → `final_dataset.jsonl` → `train_policy.py` → `policy.pt/onnx` → `export_weights.py` → `policy.bin`

### NNUE 数据管线（2026-08-19 新闭环，M0–M2 完成）

```
Lichess/chess-position-evaluations (HF, parquet, 957M 行, cp/mate 均白方视角)
  → parquet_dump.py (pyarrow 流式, 深度≥15 预滤)
  → data-etl (Rust, 清洗+去重+HalfK-768+.scnn)
  → train_nnue.py (memmap 训练, 12×8×8→标量 eval)
  → policy_nnue.pt / nnue.bin
```

- **数据源**：HF `Lichess/chess-position-evaluations`（官方 lichess 分析板 SF 评估）。下载走本地代理，**hf.co CDN 实测 22MB/s**。单个 data_0000.parquet 54M 行 / 2.1GB；全量 42GB（20 文件）不必全下。
- **schema 实测**：cp 与 mate 都是**白方视角**（正=白优/白将杀），已用本地 SF 交叉验证；FEN 只有 4 字段（无 fullmove/半步行数）。
- **清洗（data-etl 全阈值 CLI 化）**：depth≥15 / 子力≤30（ply 过滤的替代，因 FEN 无 fullmove）/ 去将军 / 去可升变 / 按 Zobrist 去重（MultiPV 多行取**最优线** = 对行棋方最有利的 comparable 分）/ 可选 hash 空间下采样。mate→cp：`sign*(30000-2|m|)` 再 clamp ±2000。输出 `.scnn`（magic SCNN + u32 v + u64 N + u32 768 + N×(768×u8 特征 + f32 cp_stm + f32 result_stm=NaN)）。
- **特征编码 HalfK-768**：12 通道×64 格，**stm 视角**（黑走时颜色互换，不镜像棋盘）。SF 实测：棋盘旋转/镜像**不保持 eval**（rot90 可 519→-74），故**训练无 D4 增广**，仅颜色互换规范化合法。
- **golden test**：`qa_nnue.py` 用 python-chess 逐位比对特征（1500/1500 一致）+ 最优线标签验证 + 分布统计。
- **训练**：`train_nnue.py` memmap 读 .scnn，标签 T=sigmoid(cp_stm/400)，MSE，135K 参数 CNN（无增广）。当前数据：5.66M 唯一局面（hash 下采样 2，.scnn 4.4GB）。

---

## 八、常见坑与经验

1. **GitHub 推送失败** → 用本地代理 `http://127.0.0.1:1087` 重试
2. **树莓派访问 GitHub 不通** → 源码/权重一律本地下载后 scp
3. **Reckless 编译**：build.rs 会从 GitHub 下载 NNUE 权重（`networks/v60-7f587dfb.nnue`，63MB），树莓派需先放好该文件（`~/reckless/networks/`）跳过下载；运行时按**编译时嵌入的绝对路径**读权重，`~/reckless/networks/` 不能删
4. **多文件 scp**：basename 是文件名，目标目录别弄错（曾把 motion.js 传到 public/ 而非 public/js/）
5. **PST 方向 bug**（已修复）：位置表按视觉顺序书写（第 0 行=rank8），chess crate 的 `Square::to_index()` 是 a1=0，白方必须 `63-idx` 翻转，黑方直接 idx
6. **棋盘高亮位置**：白方朝下时 `row = 8 - rank`，黑方朝下 `row = rank - 1`
7. **点击式下棋**：chessboard.js 会拦截 click，用 pointerdown 记录格子 + 移动距离>6px 判定拖拽（不要用 click / 不要依赖 pointerup 的 e.target）
8. **本地 Rust**：rustc/cargo 1.97 在 `/usr/local/bin`；树莓派用 rustup 装 1.97（`/home/pi/.cargo/bin`，非交互 shell 要 export PATH）
9. **前端 JS 缓存**：改 JS 后记得在 index.html/chess.html 里加 `?v=N` 版本号
10. **首页磁吸**：由 motion.js 的 `.magnetic` class 控制（hover 才磁吸，离开回正）；演示盘已移除磁吸
11. **git stash 回滚陷阱**（2026-08-13 踩过）：源码可能被意外 `git stash` 导致工作区回退到旧 HEAD，表现为「改完的代码消失、编译产物变小、UCI option 变少」。排查：`git stash list`，用 `git show stash@{0}:<文件>` 看 stash 内容，`git checkout stash@{0} -- <文件>` 恢复。**改完代码后先 `git status` 确认源码在 modified 列表，再编译**，否则会拿旧代码编译+对弈、得出错误结论
12. **match.py 线程参数**：已支持 `--threads-a/--threads-b`（默认 1）；对比多线程收益时注意 `concurrency × Threads ≤ 物理核数`，否则线程争抢 CPU 会污染测量
13. **ETL 子力计数坑**：`material_count(fen)` 若直接数整行字节会连 `" b - -"` 的 6 个 token 一起算，导致实际 24 子以上的局面全被误删（drop_material 从 6 万虚增到 13 万）。**只数 `fen.split()[0]`**。修这类"丢弃率异常高"先怀疑计数范围
14. **eval 增广铁律**：SF eval 在棋盘旋转/镜像下**不保持**（rot90 实测 519→-74，rot180 也漂移），NNUE 训练**禁止 D4 增广**，唯一合法规范化是颜色互换（黑走互换后 stm 恒为白，eval 严格保持）
15. **chess crate 比 python-chess 更严**：`Board::from_str` 会拒绝「轮不到走的一方被将军」等非法 FEN（Lichess 数据 0.1~0.4% 非法），这是正确丢弃不是 bug
16. **Lichess eval 视角**：HF `Lichess/chess-position-evaluations` 的 cp/mate 都是**白方视角**；MultiPV 反规范化使数据 ~6 倍冗余（1M 行仅 17% 唯一），必须按 FEN 去重取对行棋方最优线

---

## 九、当前页面/引擎清单

| 页面 | URL | 说明 |
|---|---|---|
| 首页 | `/` | 围棋+国际象棋 AI 演示 |
| 国际象棋 | `/chess.html` | **BiaoZi 手写eval** / **BiaoZi NNUE** / Stockfish / Reckless / 8 个 CCRL 顶级引擎（见下方清单），点击式+拖拽下棋、AI 推荐高亮、实时胜率折线图 |
| 围棋 | `/go.html` | KataGo 推荐 |
| 复盘 | `/review.html` | 走法复盘 |

双自研引擎已上线 `chess.html` 引擎下拉（**BiaoZi 两个置顶**，server.js ENGINES 对象顺序即下拉顺序）：
- `my-engine`（**BiaoZi 手写eval**）→ `my-engine/handcrafted/`，v2_smp 生产引擎
- `my-engine-nnue`（**BiaoZi NNUE（增量评估）**）→ `my-engine/nnue/`，NNUE 增量累加器（`Eval=nnue`，server.js 引擎级 option 注入）
- NNUE 模型 `my-engine/policy/nnue.bin`（v2，Phase4 HF 200万 best-val，corr 0.75）随部署拷到 `nnue/target/nnue.bin`

### 完整引擎清单（下拉顺序 = server.js ENGINES 顺序）

| key | 显示名 | 棋力定位 | 获取方式 |
|---|---|---|---|
| `my-engine` | BiaoZi 手写eval | 自研 v2_smp（Lazy SMP +51 Elo） | 源码编译（aarch64） |
| `my-engine-nnue` | BiaoZi NNUE（增量评估） | 自研 NNUE 增量路线 | 源码编译（aarch64） |
| `stockfish` | Stockfish 18 | CCRL #1，支持 UCI_Elo 限强 | 预编译 |
| `reckless` | Reckless 0.10 | CCRL #2，激进风格 | 源码编译 |
| `plentychess` | PlentyChess 8.0 | CCRL #3 | aarch64 预编译 |
| `alexandria` | Alexandria 9 | CCRL #6 | 源码编译 |
| `viridithas` | Viridithas 20 | CCRL #7 | aarch64 预编译 |
| `quanticade` | Quanticade Cronus 3.0 | CCRL #9 | C 源码编译 |
| `halogen` | Halogen 15 | CCRL #11 | C++ 编译（ARM NEON） |
| `clover` | Clover 9.1 | CCRL #13 | C++ 编译（修 x86 flag） |
| `berserk` | Berserk 13 | CCRL #14 | C 源码编译 |
| `ethereal` | Ethereal 14 | CCRL #26（无 NNUE 降级版） | C 源码编译 |

- 可用性：server.js 启动时 `fs.existsSync` 检测 `public/engines/<key>` 二进制，不存在的前端自动隐藏。
- 权重文件：`hati.nnue`(quanticade)、`quantised.nnue`(clover)、`nn.net`(alexandria)、`berserk-*.nn` 与二进制同目录。
- 未能部署：pawnocchio（Zig 运行时 `InvalidSyscall`）、obsidian（x86 专属头文件 `nmmintrin.h`）、caissa（缺权重 `eval-82-383B.pnn`）。

---

## 十、棋力提升记录与结论（2026-08-17 定论）

### 唯一净收益：Lazy SMP 多线程 +51 Elo

| 标签 | 内容 | 结果 |
|---|---|---|
| `v1_baseline` | 第一批安全优化：进攻走子排序加分、双车叠开放线、TT 扩容 4M、native 编译、Hash 默认 96 | 无回归 |
| `v2_smp`（**最终版**） | Lazy SMP 多线程搜索（TT/Policy 共享、Threads 参数、fork 辅助线程） | 96 局 **+51 Elo / LOS 95.4%**，已部署树莓派 |

### 9 连败记录（全部否定，勿重试）

| 方向 | 结果 |
|---|---|
| 数据侧 7 连败（重训/换血/Texel×2） | 残差 CNN −40 / LMP −69.7 / SF 标签 −34.9 / αβ蒸馏 −34.9 / deep自洽 −6.1 / Texel(self-play) −61.4 / Texel(CCRL+冻结) −110.4 |
| 搜索侧 2 连败 | IID −20 / TT age −38.4 |

### 结论

- 入门级引擎在「手工启发式 eval + α-β」框架下已到**实际天花板**，唯一净收益 = Lazy SMP +51 Elo。
- **数据侧 / 评估侧 / 搜索侧精细化全部封板**，不要再投入。`search.rs` 已回滚到 `v2_smp` 状态。

### 长期方向（M0–M4 已跑通，结论：静态 CNN 太慢，下一步增量推理）

- **数据闭环已就绪**（2026-08-19）：5.66M 安静局面 + HalfK-768 + 标量 eval 网络已可训练；教师深搜 eval 标签（40 万行）→ data-etl `--stm-cp` → 30.2 万唯一局面。
- **M3 引擎集成完成**：`nnue.rs` 静态 CNN 推理接入 `eval.rs`（UCI `Eval` 开关，默认手写），golden test 对 PyTorch 逐位一致（PASS）。
- **M4 对局验证完成**：pilot 40 局 **0-40**（LOS=1.0）。根因 = 静态 NNUE eval ~100x 慢 → 搜索深度塌陷。**静态推理已封板**（深度受限，棋力必输），不要用静态 CNN 跑正式 500 局。
- 下一步 = **NNUE 增量推理**（HalfKP 特征增量更新 + 王桶，eval 成本降到 µs 级）才能真正谈棋力；标签源最终仍是「搜索后 self-play 标签 + 增量更新（HalfKP/HalfKA）」。
