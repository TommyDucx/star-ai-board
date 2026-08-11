# S.T.A.R. — 围棋 & 国际象棋 AI 下一步推荐

根据对方的落子，AI 实时分析局面并推荐你下一步的最佳落点。
- **围棋**：KataGo（本地引擎，eigen/CPU 后端）
- **国际象棋**：Stockfish 18（本地引擎，UCI 协议）

## 启动
```bash
cd "/Users/tommydu/Documents/Default Project/star"
npm install        # 首次
node server.js     # → http://localhost:8765
```

> **注意**：本仓库**不包含引擎二进制**（GitHub 单文件限制）：
> - `Stockfish`：从 [stockfishchess.org/download](https://stockfishchess.org/download/) 下载 macOS 版，解压后放到 `public/stockfish` 并 `chmod +x`
> - `Reckless`（国际象棋第二引擎，页面可切换）：源码在 [codedeliveryservice/Reckless](https://github.com/codedeliveryservice/Reckless)，`make` 编译后放到 `public/reckless`；或从 Releases 下载对应平台二进制
> - `KataGo`：`brew install katago`，或用 `GO_MODEL` 环境变量指定网络文件（默认指向本地 goeye 的 `g170e-b10c128.txt.gz`）
> - 启动后可在 `/go.html`、`/chess.html` 直接使用；引擎不可用时页面会提示。

## 国际象棋引擎选择
`/chess.html` 面板顶部可选择引擎：
- **Stockfish 18**：支持 Elo 分级（难度下拉可选）
- **Reckless 0.10**：自带棋力，难度下拉忽略

## 国际象棋复盘（chess.com 风格）
对局结束后点「结束复盘」，跳转到独立复盘页：
- **逐手 Stockfish 分析**，按「厘兵损失」判定 9 级走法：精妙(!) / 最优 / 极佳 / 合格 / 开局谱着 / 不精确(?!) / 失误(?) / 战术遗漏(⚠) / 严重错误(??)
- **白黑准确率**、开局/中局/残局分段评分、**对局教练总结**（指出失误步与转折）
- **优势曲线**（白方厘兵 cp，正=白优，绿点=妙手、红点=大漏转折）
- **自动播放**：逐手推进，**走到关键节点（大漏/妙手/失误）自动停下**并点评
- 每步点评含：胜率/评估变化、损失厘兵、**更优着法**、引擎 Top 3 推荐、问题说明
- 统计看板：各等级白黑计数、最大优势、转折点步数、平均损失
- 走法列表（点击跳转）+ ←/→/⏮ 导航

## 页面
| 路径 | 内容 |
|------|------|
| `/` | 主页（入口） |
| `/go.html` | 围棋：点击棋盘落子，落子后 KataGo 自动分析，数字标注 Top 推荐点 + 胜率/目差 |
| `/chess.html` | 国际象棋：拖拽走棋，AI 实时推荐最佳走法 + 评估 + 候选列表 |

## 配置（server.js 顶部）
- `KATAGO`：KataGo 二进制路径（默认 `/usr/local/bin/katago`）
- `GO_MODEL`：KataGo 网络文件（默认 goeye 的 `g170e-b10c128.txt.gz`，可用环境变量 `GO_MODEL` 覆盖）
- `STOCKFISH`：Stockfish 二进制（`public/stockfish`）
- 端口：`PORT`（默认 8765）

## 引擎说明
- 围棋走 KataGo `analysis` 协议（line-delimited JSON），请求含 `initialStones`、`initialPlayer`、`maxVisits`；响应返回候选点 `moveInfos`（胜率、目差、PV）。
- 国际象棋走 Stockfish UCI：`position fen ...` + `go movetime ...`，返回 `bestmove` 与 MultiPV 候选。
- 引擎为长驻进程，KataGo 首次启动需加载模型（约 10-20s，eigen CPU 后端）。
