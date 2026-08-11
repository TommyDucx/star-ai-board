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
> - `KataGo`：`brew install katago`，或用 `GO_MODEL` 环境变量指定网络文件（默认指向本地 goeye 的 `g170e-b10c128.txt.gz`）
> - 启动后可在 `/go.html`、`/chess.html` 直接使用；引擎不可用时页面会提示。

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
