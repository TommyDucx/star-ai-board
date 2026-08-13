# S.T.A.R. 项目解析（来自会话 ses_018b89a65ffeQ563XjFXkW9OQ4）

> 通过对话还原的项目全貌。源会话文件：`/Users/tommydu/Downloads/ses_018b89a65ffeQ563XjFXkW9OQ4.json`（约 12MB，1370 条消息，91 条用户 / 1279 条助手）

---

## 一、项目是什么

**S.T.A.R. —— 围棋 & 国际象棋 AI 下一步推荐系统**（仓库名 `star-ai-board`）

- GitHub：`https://github.com/TommyDucx/star-ai-board`（公开仓库）
- 本地路径：`/Users/tommydu/Documents/Default Project/star`
- 运行方式：`node server.js` → `http://localhost:8765`（端口可经 `PORT` 环境变量改）
- 本质：把你的 **GoEye（围棋 KataGo 识别）** 和 **Stockfish 国际象棋前端** 两个项目，统一搬到网页上，做成一个"看对方落子→AI 推荐你下一步"的对弈辅助网站。

---

## 二、演进历程（关键转折）

这个项目并非一开始就是棋类网站，而是经历了一次大转向：

| 阶段 | 主题 | 用户核心诉求 |
|------|------|--------------|
| 1. 起步 | 高中生错题管理 + 知识库网页 | 模仿 projectkylin.org.cn 风格；灵动光标轨迹、页面切换动画、磁吸交互 |
| 2. 错题识别 | PDF/图片上传自动拆题 | 自动识别每道错题+解析并入库；后简化为"剪裁题目+解析截图、多选导出合成 PDF" |
| 3. 文本方向 | 改成上传 md/word 文本，用 DeepSeek API 分类 | 调用 `sk-aa9d9025...` 直接让模型处理，绕开 OCR 不准的问题 |
| 4. **彻底转向** | 删掉全部错题功能，改为棋类推荐网站 | "把所有功能全部删了，改成一个围棋和国际象棋的…推荐网站，把 goeye 直接搬到网页上，download 里有 stockfish，下载前端实现和围棋一样的下一步推荐" |
| 5. 棋类完善 | 围棋 + 国际象棋双棋种 | 点击/拖拽下棋、AI 推荐按钮、引擎切换、胜率评估、chess.com 式复盘、介绍页、部署树莓派 |

**记忆锚点（第 717 条用户消息）**：这是整个项目的分水岭——之前 700+ 条消息做的错题系统被全部推翻，重做成一个"围棋+国际象棋 AI 推荐"网站，并明确要求复用 `/Applications` 里的 GoEye 和 Downloads 里的 Stockfish。

---

## 三、技术架构

**后端**
- `server.js`（Node.js，依赖仅 `ws`）：HTTP 静态服务 + WebSocket，负责拉起并常驻引擎进程
- 配置项集中在文件顶部：`KATAGO`（默认 `/usr/local/bin/katago`）、`GO_MODEL`（KataGo 网络文件，默认指 goeye 的 `g170e-b10c128.txt.gz`，可 `GO_MODEL` 覆盖）、`STOCKFISH`、`PORT`（默认 8765）

**前端**（原生 HTML/CSS/JS，无 Vue/React）
- `public/index.html` 主页入口
- `public/intro.js` + `public/main.html` 创意介绍页（强交互、灵动、顶部"进入系统"按钮）
- `public/go.html` + `public/js/go.js` 围棋页（点击落子→KataGo 分析→数字标注 Top 推荐点 + 胜率/目差）
- `public/chess.html` + `public/js/chess.js` 国际象棋页（拖拽+点击式走棋，参考 chess.com；AI 实时推荐 + 评估 + 候选列表；引擎切换 Stockfish/Reckless）
- `public/review.html` + `public/js/review.js` 复盘页（chess.com 风格）
- `public/css/motion.css` + `public/js/motion.js` 切换动画与光标轨迹（保留自早期错题系统的灵动风格）

**引擎**
- 围棋：`KataGo`（本地，eigen/CPU 后端），走 `analysis` 协议（line-delimited JSON），返回 `moveInfos`（胜率、目差、PV）
- 国际象棋：`Stockfish 18`（UCI）、`Reckless 0.10`、以及**自研 Rust 引擎 `my-engine`**
- `my-engine/`：Rust 项目（依赖 `chess` crate），阶段 1 已完成基础引擎（评估=子力+PST+王盾+兵结构；迭代加深 α-β + MVV-LVA + UCI），并做了搜索优化（Zobrist 换位表、历史启发表、杀手走法，效率约提升 8 倍），已部署到树莓派。**计划阶段 2：Policy Model 训练（8×8×N 张量 + 小型 CNN → ONNX 接入搜索引导）**

**注意**：引擎二进制不入库（`.gitignore` 排除 `public/stockfish`、`public/reckless`），需自行下载放置。

---

## 四、功能清单（最终状态）

- ✅ 围棋：点击落子、KataGo 自动分析、Top 推荐点标注、胜率/目差
- ✅ 国际象棋：拖拽 + 点击式下棋、AI 推荐下一步、实时胜率评估（右侧，每步实时计算）、引擎切换（Stockfish / Reckless / 自研 my-engine）、难度/Elo 分级
- ✅ 复盘系统（chess.com 风格）：逐手 Stockfish 分析、9 级走法判定（精妙/最优/极佳/合格/开局谱着/不精确/失误/战术遗漏/严重错误）、白黑准确率、开中残分段评分、优势曲线、关键节点自动停+点评、统计看板
- ✅ 创意介绍页：强交互、灵动动画、光标轨迹、磁吸效果，顶部"进入系统"
- ✅ 部署：已部署到树莓派 `pi@192.168.0.107`（SSH）

---

## 五、当前状态

- Git：`main` 分支，最新提交 `5062fe9`（my-engine 阶段 1 搜索优化），已推送到 `origin/main`
- 远程地址为 token-free 形式（`https://github.com/TommyDucx/star-ai-board.git`）
- 本地与树莓派均已更新

---

## 六、与你现有项目的关联

这份会话正是你当前两个主力项目的"前身/合并版"：
- **GoEye**（macOS 围棋实时识别 App）→ 被搬进网页成了 `go.html`
- **Stockfish 国际象棋 web 前端** → 即 `chess.html`

也就是说，S.T.A.R. 是这两个项目在网页端的统一载体；后续你在 GoEye / Stockfish 上的迭代，可与这个仓库对照参考。
