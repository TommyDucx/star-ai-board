# STAR 系统架构与工作流程交接文档

> 用途：让新对话（agent）快速了解现有系统，按相同步骤继续开发。
> 更新日期：2026-08-17

---

## 一、系统架构总览

```
┌───────────────────────── 本地开发机 (Mac) ─────────────────────────┐
│  /Users/tommydu/Documents/Star Chess      ← 唯一权威工作目录        │
│    ├─ server.js          Node WebSocket 服务（围棋+国际象棋引擎网关）│
│    ├─ public/            前端页面（index/chess/go/review.html）     │
│    ├─ my-engine/         自研 Rust 国际象棋引擎（Policy 引导 α-β）  │
│    │   ├─ src/eval.rs    评估：子力+PST+王盾+兵结构（PST 已修复）   │
│    │   ├─ src/search.rs  α-β + TT + killer + 历史 + qsearch + SEE  │
│    │   ├─ src/policy.rs  手写 CNN 推理（8×8×13→4096 走法概率）     │
│    │   ├─ src/main.rs    UCI 协议                                   │
│    │   └─ policy/        policy.bin/onnx/pt（策略模型）             │
│    ├─ data/              训练数据集（final_dataset.jsonl 等）       │
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
│    ├─ my-engine/target/release/my-engine  ← aarch64 编译的自研引擎  │
│    ├─ my-engine/policy.bin                ← 策略模型（引擎自动加载）│
│    ├─ public/stockfish    (78MB)                                    │
│    ├─ public/reckless     (65MB, Reckless 0.10，源码编译)           │
│    └─ public/katago                                                   │
│  /home/pi/reckless        Reckless 源码（含 networks/*.nnue 权重）  │
│  systemd 服务：star-ai-board（端口 8765）                           │
└──────────────────────────────────────────────────────────────────────┘

GitHub：github.com/TommyDucx/star-ai-board  ← 两目录共用的远程仓库
```

---

## 二、服务器与凭据（新对话必读）

| 项目 | 值 |
|---|---|
| 树莓派 SSH | `ssh pi@192.168.0.107`，密码 `n8imativ` |
| 树莓派主机名 | `pi-wildlife2`（Debian 13 aarch64） |
| 网站地址 | `http://192.168.0.107:8765` |
| 网站服务 | `systemctl restart star-ai-board`（systemd） |
| GitHub 仓库 | `https://github.com/TommyDucx/star-ai-board.git` |
| GitHub 推送 Token | `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` |
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
  "*password:" { send "n8imativ\r"; exp_continue }
  "*yes/no*" { send "yes\r"; exp_continue }
  eof
}
```
用法：`expect /tmp/rc.exp "systemctl is-active star-ai-board"`

```bash
# /tmp/scp.exp —— 传文件
#!/usr/bin/expect -f
set timeout 300
spawn scp -o StrictHostKeyChecking=no <本地文件> pi@192.168.0.107:<目标路径>
expect { "*password:" { send "n8imativ\r"; exp_continue } eof }
```
用法：`expect /tmp/scp.exp`

> 坑：expect 脚本的 cwd 与 shell 不同，scp 源文件必须用**绝对路径**。

---

## 四、标准工作流程（按此步骤执行）

### 1. 本地开发
在 `~/Documents/Star Chess` 修改代码（前端 public/、服务 server.js、引擎 my-engine/src/）。

### 2. 同步到树莓派
```bash
cd "/Users/tommydu/Documents/Star Chess"
# 全量同步（排除大二进制/数据/缓存）
tar czf /tmp/star-chess.tar.gz --exclude=.git --exclude=node_modules \
  --exclude=my-engine/target --exclude=data \
  --exclude=public/stockfish --exclude=public/reckless --exclude=public/katago .
expect /tmp/scp.exp   # 传到 /home/pi/star-chess.tar.gz
expect /tmp/rc.exp "tar xzf /home/pi/star-chess.tar.gz -C /home/pi/star-ai-board"
```
> ⚠️ 别覆盖 public/ 下的 stockfish/reckless/katago（树莓派特有二进制，本地 gitignore 没有）。

### 3. 编译自研引擎（树莓派 aarch64）
```bash
expect /tmp/rc.exp "cd /home/pi/star-ai-board/my-engine && \
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

### 6. 提交并推送 GitHub
```bash
cd "/Users/tommydu/Documents/Star Chess"
git add <文件>
git commit -m "..."
# 先直连试，失败用代理：
export http_proxy=http://127.0.0.1:1087 https_proxy=http://127.0.0.1:1087
git push "https://x-access-token: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@github.com/TommyDucx/star-ai-board.git" main
```

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

---

## 九、当前页面/引擎清单

| 页面 | URL | 说明 |
|---|---|---|
| 首页 | `/` | 围棋+国际象棋 AI 演示 |
| 国际象棋 | `/chess.html` | Stockfish / Reckless / **MyEngine**（自研），点击式+拖拽下棋、AI 推荐高亮 |
| 围棋 | `/go.html` | KataGo 推荐 |
| 复盘 | `/review.html` | 走法复盘 |

自研引擎目前已上线 `chess.html` 引擎下拉（`MyEngine 0.2.0（自研策略模型）`）。

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

### 长期方向（需先补数据管线课，不是下一步）

- **NNUE 代际跃迁**：需要「搜索后 self-play 标签」+ 增量更新（HalfKP/HalfKA），而非「静态局面 + 对局结果」。当前 9 次数据实验全败证明数据管线能力不足，这是「先补课」的长期目标。
- 若继续，唯一可能有效的是换数据范式（教师引擎深度搜索打标签 + NNUE 架构），而非在现有 eval/CNN 上继续调参。
