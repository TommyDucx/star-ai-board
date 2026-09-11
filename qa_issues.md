# STAR 网站 QA Issues

> 测试对象：http://192.168.0.107:8765（树莓派生产服务）
> 方法：headless Chrome 151 + CDP（Runtime.evaluate / Performance / Emulation），测试日期 2026-08-22
> 环境：本机代理已用 no_proxy=192.168.0.107 绕过；Chrome 加 --no-proxy-server

### ISSUE-001 | 高 | ✅状态:已修复(2026-08-22 部署+线上CDP验证 movelist 填充) | /chess.html | 打开页面→走任意几步（或直接观察新对局）→查看面板下方走法区域 | 预期：#movelist 表格随对局填充着法记录；实际：表格永远为空，200px 高的空白区块 | 证据：chess.html:98 存在 `<table id="movelist">`，但 public/js/chess.js 全文无任何 movelist 引用/填充代码；实测 `document.querySelectorAll('#movelist tr, #movelist td').length === 0`（走了 d4、AI 回 c5 之后仍为 0）

### ISSUE-002 | 中 | ✅状态:已修复(session令牌，线上竞态测试 hist=0) | /chess.html | 点击「AI 推荐下一步」触发 engineThink()→在引擎返回前点击「新对局」→等待约 3 秒 | 预期：新对局重置为空棋盘且保持干净；实际：迟到的 AI 回复在重置后的棋盘上自动落子，状态栏还显示切换前的引擎名 | 证据：实测 afterMidThinkSwitch = {hist:1, status:"[BiaoZi 手写eval] AI 落子：e4 · 轮到 黑方", engineVal:"reckless"}——已切到 reckless 并点了新对局，旧 BiaoZi 请求的 e4 仍落到全新棋盘上（engineThink 的 rpc 无取消机制）

### ISSUE-003 | 中 | ✅状态:已修复(pvLine顺序SAN，线上无原始uci) | /chess.html | 选引擎点「AI 推荐下一步」→看右侧「推荐走法」列表每条的 PV 行 | 预期：候选线以 SAN 可读格式显示后续几手；实际：第 2 手起 san() 对当前局面转换单步失败，回退显示原始 UCI 坐标，与分数粘连难读 | 证据：cands 文本实测 "1 d5 d5 c2c4-0.262 Nf6 Nf6 c2c4-0.223 d6 d6 e2e4-0.50"（renderCands 中 `(c.pv).slice(0,4).map(san)` 未按序列推进局面）

### ISSUE-004 | 中 | ✅状态:已修复(媒体查询，375px scrollW=375) | /go.html | 375px 宽视口打开围棋页 | 预期：布局收缩适配、无横向滚动条；实际：横向溢出 82px，棋盘(538px)被截断需左右拖动 | 证据：Emulation.setDeviceMetricsOverride 375×667 实测 scrollW=457 vs clientW=375，溢出元素 DIV.board-card right=457、SVG 棋盘宽 538px 不收缩

### ISSUE-005 | 中 | ✅状态:已修复(表格横向滚动兜底，375px 无溢出) | /review.html | 375px 宽视口打开复盘页（含优势曲线/明细） | 预期：无横向滚动条；实际：横向溢出 152px | 证据：实测 scrollW=527 vs clientW=375，溢出元素 TABLE/TBODY/TR right=527（曲线盒/明细表固定宽度未做移动端适配）

### ISSUE-006 | 中 | ✅状态:已修复(gzip+缓存分级，jquery 88KB→30KB) | 全站（首页最重） | 冷缓存访问各页，记录 DCL/load 与资源传输 | 预期：局域网内秒开；实际：首页首次加载 DCL 8.48s / load 8.81s（TTFB 仅 564ms），20 个请求每个 JS 约 2s；其余页 1.3~2.3s 尚可 | 证据：qa_perf 实测 cold: {"/": dcl 8480/load 8814, slowest intro.js 1958ms}；服务器响应头无 Content-Encoding（jquery.min.js 88KB 明文传输）且 Cache-Control: no-cache,no-store,must-revalidate——热加载仍全量重传 202KB（?v=N 版本号已具备，缓存却全禁）

### ISSUE-007 | 低 | ✅状态:已修复(favicon.ico 200) | 全站 | 打开任意页面看控制台 | 预期：无资源加载错误；实际：每页报 favicon.ico 404 | 证据：console "[log.error] Failed to load resource: 404 http://192.168.0.107:8765/favicon.ico"；public/ 下确认无 favicon.ico

### ISSUE-008 | 低 | ✅状态:已修复(显示 -0.16) | /chess.html | 走子后查看「评估：」文本 | 预期：负分显示如 "白方 -0.26"；实际：正负号拼接成 "白方 +-0.26" | 证据：updateEval 中 `"白方 +" + (c.evalCp/100).toFixed(2)` 对负 cp 产生 "+-"；实测 evaltxt="评估：白方 +-0.26（深度 12）"

### ISSUE-009 | 低 | ✅状态:已修复(evalchart 折线图实现并绘制) | /chess.html + AGENTS.md | 按 AGENTS.md 第九节检查「实时胜率折线图 canvas/svg」 | 预期：存在胜率折线图组件；实际：chess.html 无任何折线图元素，唯一 canvas(756×469) 是 motion.js 特效层（空白属正常）；胜率仅以竖条 #evalfill + 百分比文本呈现，文档与实现不符 | 证据：chess.js/chess.html 中无折线图绘制代码（仅注释提及"折线图"）；canvas 像素采样 opaquePx=0 且 DOM 内无对应图表容器

### ISSUE-010 | 低 | ✅状态:已修复(__errs 全站采集器就位) | 全站 | 按 QA 规范读取 window.__errs | 预期：__errs 为收集到的运行时错误数组；实际：所有前端文件均未定义 window.__errs，错误监控机制不存在（本报告以 console/exception 事件替代采集） | 证据：rg "__errs" public/ 无匹配；页面 evaluate `(window.__errs||[])` 恒为 []

## 通过清单（实测通过项）

- A 首页 `/`：HTTP 200、标题正常、围棋+国象演示盘渲染、磁吸元素存在、控制台除 favicon 外无错误
- B1 chess.html 控制台无任何 JS 异常/报错（全程多轮交互）
- B2 引擎下拉 12 项完整有序：「BiaoZi 手写eval」置顶、「BiaoZi NNUE」第二，stockfish/reckless 及 PlentyChess/Alexandria/Viridithas/Quanticade/Halogen/Clover/Berserk/Ethereal 全部列出；默认选中即 BiaoZi 手写eval
- B3 点击式走子：pointerdown/up 合成事件选中 e2/d2 → selectedSq 有值、`.star-hl.sel` + `.star-hl.dot`(e3/e4) 高亮出现 → 点 e4 完成走子 history 1→（注：3 次执行中 1 次首次点击未生效，重复执行不可复现，疑为加载动画期间时序偶发）
- B4 engineThink()：status 更新为「[引擎名] AI 落子：xxx · 轮到 xx」，AI 棋子上盘渲染，thinking 指示器 on→off 正常（引擎响应 <400ms~数秒）
- B5 AI 推荐高亮：from/to 两格覆盖层 rgba(215, 255, 63, 0.28/0.42) 正常出现并按设计 1.2s 后消失
- B7 压力交互：30 连点随机格 FEN 始终合法、无 JS 报错；思考中切引擎、spam 新对局/悔棋/翻转×10 页面不崩（唯一问题见 ISSUE-002）
- C go.html：19×19 SVG 361 交叉点渲染、点击落子自动触发 KataGo 分析（"分析中…"→"分析完成"）、Top5 推荐圈(#d7ff3f)渲染、胜率条更新（白胜率 60.7% · 目差 +2.5，含 7.5 贴目逻辑合理）
- D review.html：预置 5 步对局复盘分析 7.5s 完成、白/黑准确率与分段显示、COACH 教练总结生成、优势曲线 SVG 有内容、⏮开局/←上一步/下一步→/▶自动播放控件全部响应（pos 0/5→1/5，播放键正确变 ⏸）
- E 性能：go/review DCL 1.3~2.1s、chess 1.8~2.2s；全部页面加载及交互期间 >100ms 长任务数为 0
- F 移动端：/ 与 /chess.html 在 375px 下无横向溢出；所有按钮触控高度 ≥34px

## 总结

问题总数 **10**：高 **1**（ISSUE-001）、中 **5**（ISSUE-002~006）、低 **4**（ISSUE-007~010）。无崩溃级缺陷，核心下棋/分析链路可用。

**最影响体验的 3 件事：**
1. **走法列表永不显示**（ISSUE-001）：UI 元素在、实现缺失，用户每次对局都看到一块 200px 空白区，属功能级缺陷。
2. **「新对局」会被进行中的引擎请求污染**（ISSUE-002）：重置后棋盘自动多出旧请求的落子、状态栏引擎名错乱，直接破坏用户对棋局状态的信任。
3. **手机端 go/review 横向溢出 + 首页冷加载 8.8s**（ISSUE-004/005/006）：移动端两页需左右拖动才能看全，叠加静态资源禁缓存且无压缩，首访体验明显拖沓。

---
## 修复部署记录
2026-08-22 C 阶段完成：8 个文件（server.js、chess.js、5 个 html、favicon.ico 新增）已 scp 同步至 pi@192.168.0.107:/home/pi/star-ai-board 并重启 star-ai-board（active），线上 CDP 回归 10/10 通过。

### ISSUE-011 | 中 | /chess.html | 第二轮发现：选中棋子（有合法点高亮）→ 点「翻转」| 预期：翻转后选中态与合法点高亮保持；实际：overlay 全部消失（board.flip() 重建格子 DOM），但内部 selectedSq 还在，点击仍可走子——视觉与状态脱节 | 证据：实测 before=e2|2 → afterFlip=e2|0 | ✅状态:已修复(2026-08-22 flipBoard 后调用 render() 重绘，线上验证 e2|2→e2|2)
### ISSUE-012 | 中 | /go.html | 第二轮发现：点击落子触发自动分析，KataGo 返回结果（推荐5条+胜率已更新）| 预期：状态栏更新为完成态；实际：永久停留「分析中…」——go.js:191 `if (!auto) setStatus("分析完成")` 把 auto 链路的状态更新整个跳过 | 证据：30s 内 status 恒为「分析中…」而 cands=5、gwr 已刷新 | ✅状态:已修复(2026-08-22 auto 分支也 setStatus「分析完成 · 轮到 x方」，线上验证通过)

## 第二轮回归记录（2026-08-22）
深度边界测试通过项：王车易位 O-O ✓ / 升变 a8=Q ✓ / 将死局面走子锁定 ✓ / 思考中悔棋无污染 ✓ /
连发5次engineThink无错误 ✓ / movelist随悔棋增减 ✓ / 复盘全流程(准确率100/100、翻页) ✓ /
围棋9路切换81交叉点 ✓ / **热加载 DCL 274ms·传输0字节（缓存生效，对比首轮冷加载8.8s）** ✓
未复现：首轮 B3「首次点击偶发失效」（两轮复测均正常，判定为测试时序偶发，不立项）

### ISSUE-013 | 中 | /review.html | 第三轮发现：复盘页 #movelist 容器存在但 review.js 从未填充（与 ISSUE-001 同类缺陷），用户只能靠 ←/→ 翻，无法直接跳到某一步 | 证据：两轮实测 rows=0；grep 无任何 movelist 引用 | ✅状态:已修复(2026-08-22 renderMoveList() 成对填充+点击跳转+当前步高亮，线上验证 6 步棋点击第4步跳转 4/6)
### ISSUE-014 | 低 | /review.html | 第三轮发现：长对局分析可达数十秒，期间状态栏只有静态「分析中…」无进度 | 证据：T1 实测 22 局面 11.4s 分析全程无进度变化 | ✅状态:已修复(2026-08-22 循环内 setStatus「分析中 i/n…」，线上捕捉到「分析中 7/7…」)

## 第三轮回归记录（2026-08-22）
通过项：**服务重启断线无缝恢复**（WS 重连+sendQueue 排队，重启后请求零丢失零报错）✓ /
**3 标签并发 Stockfish 无串扰**（每连接独立 id，服务端按引擎排队）✓ /
AI 连续自走 16 步正常、堆内存 2.1→3.1MB 稳定 ✓ / 复盘 22 局面 16.8s 完成且准确率正常 ✓

### ISSUE-015 | 中(体验) | / 首页 | 用户反馈：磁吸卡片鼠标离开瞬间弹回原位、再进入又猛地吸过去 | 根因：motion.js 旧实现在 pointermove 里直接写 transform（出界立即归零），仅靠 0.12s CSS transition 缓冲——本质是二值开关无插值；且 CSS transition 与逐事件写入互相打架 | ✅状态:已重做(2026-08-22)：改为 rAF 弹性插值（目标值+每帧 LERP 0.16 收敛，收敛后自动停帧）+ 激活半径外扩 48px 钟形衰减（靠近渐吸/离开缓回，全程无突变点）+ 移除 CSS transform 过渡避免双重平滑 + 触屏(hover:none)不启用 + 离开窗口/切标签自动回正。本地采样验证离开后 5 帧渐变回正(约250ms)；线上 MutationObserver 实测 32 帧连续写入、离开后平滑归零、零报错。motion.js/css 升 v27（全站引用统一补版本号）

### ISSUE-016 | 高(安全/可用性) | server.js | 第四轮发现：一条 WS 消息即可永久卡死共享引擎队列——畸形请求（如缺 fen → `position fen undefined`）让引擎永远不回 bestmove，而 _waitFor 无超时，串行队列从此对所有人无响应（探针实测：后续所有请求全部静默，HTTP 静态仍活） | ✅状态:已修复(2026-08-22)：_waitFor 增加强制超时（uci 握手/isready 10s、bestmove movetime+15s），超时即 reject 并放行队列
### ISSUE-017 | 高(安全) | server.js | 客户端参数未净化直拼进引擎 stdin：fen/elo 可注入 UCI 命令（实测 `fen+"\ngo infinite"` 能让共享引擎无限搜索）、go stones/boardSize 可注入 GTP 命令（`pass\nquit` 杀 gnugo） | ✅状态:已修复(2026-08-22)：新增 validFen 正则白名单 + cleanStr 控制字符清洗；chess 参数 clampInt（movetime/multipv≤10/elo）；go stones 白名单（色∈{B,W}、着点 GTP 格式、≤361 子）、side/boardSize/komi/maxVisits 全部数值钳制；非法立即回 error 响应
### ISSUE-018 | 中(安全) | server.js | WS 默认 maxPayload 100MB 对树莓派过大；multipv 无上限可被滥用 | ✅状态:已修复(2026-08-22)：maxPayload=256KB；multipv clamp 1..10

## 第四轮回归记录（2026-08-22 安全加固）
探针复测（加固后）：路径穿越×5 全 404 ✓ / 敏感文件×6 全 404 ✓ / 畸形消息不崩 ✓ /
缺参·注入·非法 FEN 立即回错误响应 ✓ / FEN 注入拒绝 ✓ / GTP 着点注入拒绝 ✓ /
boardSize 注入被钳制后正常分析（返回 moveInfos）✓ / 2MB 巨型消息连接被掐断且服务健康 ✓ /
正常分析链路无损（真实 FEN → bestmove b1c3）✓ / 页面冒烟 ALL PASS ✓
附带修复：review.js rpc 改用 sendQueue（旧 onopen 覆盖模式会丢首请求）；三页断线瞬间 reject 所有挂起请求（防「分析中」永久卡死）；go/review 补 wss 协议适配。
版本号：chess.js v31 / go.js v9 / review.js v6

### ISSUE-019 | 中(性能) | 全站 motion.js | 第五轮发现：光标拖尾 canvas 的 rAF 循环永不停止——空闲时仍以 ~60fps 全屏 clearRect+重绘（代码层面 step() 无条件自续），树莓派/笔记本持续烧 CPU/GPU | ✅状态:已修复(2026-08-22)：只在指针真实移动时生成拖尾点；「拖尾散尽 + 平滑点追上光标」即停帧，pointermove 唤醒。本地像素级验证：移动有迹、静止衰减、旧位清空
### ISSUE-020 | 低(交互) | 全站 data-nav 链接 | 三连点导航创建 3 个叠加 route-slice overlay（探针实测 created=3）；Cmd/Ctrl/Shift+点击被无条件 preventDefault 劫持，「新标签页打开」失效；reduced-motion 下 CSS 动画被禁后覆盖层退化为静态全屏色块挡脸 | ✅状态:已修复(2026-08-22)：sliceRoute/handoff 加防重入（动画中忽略后续触发）+ REDUCED 直接 location 跳转 + 导航失败复位可重试；新增 Motion.wireNav() 集中委托（修饰键/非左键放行浏览器默认行为），移除五页重复内联绑定
## 第五轮回归记录（2026-08-22 互动与动画专项）
修复过程中发现并纠正自伤：正则批量删除内联脚本产生悬挂大括号致三页 <script> 块语法错误（__errs 捕获 SyntaxError）→ 已逐一修复并 node --check 全部内联块。
线上复测：motion.js v28 生效 / 三连点=1 层 / cmd+click 放行 / __errs 空 / 服务 active。涟漪与 boot 增加减动效跳过。

### ISSUE-021 | 中 | /go.html | 第六轮发现：aiAnalyze 回调无会话保护——落子后立刻清盘，迟到结果照常「分析完成」并污染空盘（5 条推荐+胜率 61%）；更危险的是分析中切棋盘尺寸，19 路坐标（D16/Q17）渲染到 13 路盘的推荐列表里，点击即越界 | 证据：T1 空盘 cands=5/winlabel 61%；T2 firstCand="C4 D16 Q16..." 出现在 13 路 | ✅状态:已修复(2026-08-22)：引入 gen 棋局代次（place/undo/clearBoard/切尺寸时自增），aiAnalyze await 后代次不符即整体丢弃。线上复测：清盘/切尺寸后 cands=0、状态保持清空、正常落子分析不受影响
### ISSUE-022 | 中(资源) | server.js | 围棋引擎池按 key 各驻留一个进程、10 分钟才回收——切换模型实测同时驻留 2 个 katago（108+145MB），12 个模型全切一遍 ≈1.5GB+ 常驻，4GB 版 Pi 有 OOM 风险 | ✅状态:已修复(2026-08-22)：启动新引擎前先 stop 并移除池内其它引擎，任意时刻最多驻留一个围棋引擎；线上验证切换后单进程
## 第六轮回归记录（2026-08-22）
正常链路无损：落子→分析完成→5 条推荐+胜率更新 ✓ / errs=0 ✓。版本号 go.js v10。

### ISSUE-023 | 中(资源) | server.js | 第七轮发现：国际象棋引擎进程只生不灭（ChessEngine 无回收）——soak 轮换 4 个引擎后即驻留 ~500MB（stockfish 250MB/reckless 79MB/berserk 70MB/my-engine 100MB），12 个引擎全用一遍 ≈2-3GB 永久占用 | ✅状态:已修复(2026-08-22)：ChessEngine 记录 lastUse，60s 巡检回收空闲 >5min 的引擎（quit 优雅退出 + kill 兜底）；线上全流程验证：触发→250MB 驻留→6.5min 后释放→再请求正常重生
### ISSUE-024 | 低(安全) | server.js | 静态响应零安全头（无 nosniff/X-Frame-Options/Referrer-Policy） | ✅状态:已修复(2026-08-22)：三个基础安全头已加，curl 验证生效
## 第七轮回归记录（2026-08-22 压力与边界专项）
Soak-lite（24 轮×6 请求混引擎+畸形消息，~4min）：144 请求 ok=120 err=24（全部为预期的 bad-fen 拒绝），node RSS 58→62MB 平稳无泄漏模式、线程数稳定 189-192 ✓
review 边界：无数据「没有可复盘的对局」✓ / 损坏 JSON「数据损坏」✓ / 傻瓜将杀 4 步复盘（准确率 53.6/81.7、严重错误标记）✓
chess 杂项：movetime3000 端到端 3.5s ✓ / 切 reckless 难度下拉禁用+文案切换、切回恢复 ✓ / BiaoZi 升变 a8=Q 显示 ✓

## 公网版本核验（2026-08-22）
穿透方式：Cloudflare 快速隧道（cloudflared --url localhost:8765，日志 /tmp/cloudflared.log）
公网地址：https://admission-decided-penny-warranty.trycloudflare.com（快速隧道重启会变，勿硬编码）

核验结果（全部最新 ✓）：
- 静态资源：chess.js v31 / go.js v10 / review.js v6 / motion.js v28 / motion.css v27
- favicon 200 / gzip / 缓存分级 / 安全头（nosniff 等）全部生效
- wss WebSocket 穿透 Cloudflare 正常：握手 OK、12 引擎全可用、走子分析返回 bestmove
- 浏览器级端到端（HTTPS 页面→wss→AI 落子）：点击走子 movelist 填充、AI 回手 e5、评估 -0.10、零报错

### ISSUE-025 | 中 | /go.html | 第八轮发现：「我方执子」下拉是完全未接线的死控件（go.js 零引用）——选执白无任何效果，行棋顺序永远黑先，提示文案写死「当前执黑」 | ✅状态:已修复(2026-08-22)：定义最小语义——执白且空盘时 AI 代黑开局一手（KataGo 首选自动落子），提示文案动态更新，analyzingGen 防连点；线上验证：切执白→AI 自动落黑一子（盘面 stones=1）→「分析完成 · 轮到白方」
### ISSUE-026 | 低(信息) | server.js 引擎巡检 | 12 个引擎健康巡检全部通过（bestmove 正常、depth 6~15），无失效引擎——记录为基线数据，非缺陷
## 第八轮回归记录（2026-08-22）
特殊走法：吃过路兵 exf6 ✓ / 鼠标拖拽走子 d4 ✓ / go 执白 AI 代开局 ✓ / 公网双客户端并发（stockfish+reckless 经 wss 同时分析均成功）✓
版本号：go.js v11。引擎巡检基线：my-engine d8 / nnue d6 / stockfish d12 / reckless d12 / plentychess d10 / alexandria d9 / viridithas d11 / quanticade d8 / halogen d11 / clover d15 / berserk d13 / ethereal d15

### ISSUE-027 | 中(逻辑) | /go.html | 第九轮发现：「翻转」按钮实现为交换全部棋子颜色而非翻转视图——直接改写 board 会破坏 moveLog 与局面的对应（下一手颜色判断错乱、复盘失真），属状态污染型逻辑洞 | ✅状态:已修复(2026-08-22)：改为 svg transform rotate(180deg) 视图旋转 + 点击坐标映射(r,c → N-1-r,N-1-c)。本地验证：翻转后点视觉(15,15)精确落到真实(3,3)（cx=26+3×27=107），原局面零改动
## 过渡设计重做（2026-08-22，用户需求「更灵动」）
Boot 启动页全新编排：
- 入场：PROJECT 左擦入保留；S.T.A.R. 改为「字距收缩 .55em→.08em + 模糊聚焦上升」入场，叠加信号绿 shimmer 流光循环
- 新元素：规则线生长完成后脉冲光点从左向右巡行 / 三枚进度点波浪脉动 / 扫描线上下巡航
- 退场：内容升腾模糊淡出(.34s) → 双幕布上下拉开(.62s) 揭示真实页面（替代原来的单侧擦出）
Slice 切页：扫屏面板加 -7° 斜切 + scaleX 防露角，信号快门加拖尾辉光，速度感更强
Handoff 光束：新增细回声光束（延迟 70ms/45% 透明度）制造纵深
Enter-node 进场：偶数子元素改用「右侧揭示+斜向浮入」变体，多卡片方向交错
版本：motion.js v29 / motion.css v28 / go.js v12。reduced-motion 全部自动降级。

## 特效包上线（2026-08-22 第二批，用户需求「画面更丰富灵动」）
全站新特效（纯 CSS/轻量 JS，reduced-motion 全部自动降级，性能零长任务）：
1. **极光氛围层**：三色径向光斑（信号绿/青/紫）26s 缓慢漂移，screen 混合只提亮背景，motion.js 自动注入
2. **Boot 星尘**：22 颗发光微粒自底上浮（随机尺寸/透明度/速度），boot 移除即销毁零残留
3. **Boot HUD**：四角括号取景框 + 右下旋转刻度环（带信号点轨道）
4. **卡片流光**：magnetic 卡片 hover 单次斜向扫光（115° 高光带）
5. **AI 落子弹跳**：chess 页 AI 回手后棋子落地回弹动画（piece-drop，animationend 自清理）
6. **复盘曲线描边**：优势曲线首次渲染从左向右 1.2s 生长（getTotalLength+dashoffset），导航重绘不重播
7. **双环涟漪**：点击涟漪新增外圈回声环同步扩散
版本：motion.js v30 / motion.css v29 / chess.js v32 / review.js v7。本地验证：星尘22/HUD4/环旋转/sheen渐变/弹跳样式/曲线transition 全部生效，errs=[]；已部署树莓派并同步公网。

## Boot 启动页重设计 v3「UCI 握手叙事」（2026-08-22，frontend-design skill 指导）
设计立场：boot 不做泛泛赛博光效，而是演一场**棋类引擎真实的启动仪式**——UCI 协议握手。
签名动效：S.T.A.R. 从棋子 Unicode（♔♕♖♗♘♙…）+ hex 乱码中**逐位解码锁定**（rAF 驱动 ~0.9s），
锁定瞬间字距收缩 + 双层辉光确认。
完整编排：
- 背景棋盘格随机闪烁（引擎扫描棋盘隐喻）
- 左下角 UCI 终端日志逐行打印：> uci / < id name S.T.A.R. ENGINE / < uciok / > isready / < readyok / > go boot sequence
- 阶段标签 + 三段进度条：INIT → HANDSHAKE → READY
- 锁定后规则线生长+光点巡行、扫描线巡航；退场沿用内容升腾+双幕布拉开
工程细节：最终态为 CSS 默认样式（无 JS/reduced-motion 天然正确）；解码/日志/进度定时器在 exit 时统一清理；
rAF 在元素脱离后自停。砍掉了上一版的 shimmer 流光（解码辉光已足够——Chanel 原则）。
版本 motion.js v31 / motion.css v30。本地验证：乱码含棋子字符、6 行日志、READY 推进、移除干净 errs=[]。已部署+公网同步。

## 棋感特效包上线（2026-08-22 第三批）
1. **吃子碎裂**：Motion.fx 粒子引擎（canvas 全屏层 z88，碎片矩形带重力+自旋，16 粒/次，空闲自动停帧）；
   被吃方配色碎片从目标格迸出（白子→浅灰系、黑子→深灰系，混信号绿火花），用户走子与 AI 走子双路径触发
2. **将军王座警报**：in_check 时行棋方王格红色呼吸脉冲（board() 扫描定位王格），走子/新对局即清除
3. **将杀终局大戏**：全屏暗化 + CHECKMATE 色差抖动大字（青/红 text-shadow 错位 + steps 抖动）+ 手数标注，
   2.6s 自动消散或点击跳过；newGame 立即清除
4. **围棋落子涟漪**：最近一手信号绿 SMIL 圆环扩散（随 innerHTML 重建自然重播），悔棋后转移到新最后一手
5. **思考指示器**：跳动省略号（信号绿）
工程注记：initFx 必须在 window.Motion 导出之后执行（fx 接口挂载依赖）——本轮踩过并修复的初始化顺序坑。
本地验证：exd5 burst(382,270) 坐标精确 / Re1+ 警报落 h1 / Qh4# 终局 BLACK WINS 抖动 / go 涟漪 2 环 / errs=[]。
版本 motion.js v32 / chess.js v33 / go.js v13。已部署树莓派。

## 材质+音效包上线（2026-08-22 第四批）
### 音效（Web Audio 程序化合成，零音频资源）
- 引擎：Motion.sfx——振荡器+指数包络（blip）与白噪+滤波（knock）两类基元组合
- 音色：棋子落子(木质嗒=三角波滑落+低通噪) / 吃子(双层重击) / 易位(双嗒错开90ms) /
  围棋石子(标志性啪嗒=3.2kHz瞬态+1.86kHz体腔正弦+280Hz共鸣) / 将军(双短促警示) / 将杀(三连下行锯齿) / 复盘步进微咔
- 首次手势解锁 AudioContext；🔊/🔇 开关按钮自动注入顶栏（index 无 topbar 则固定右下角圆钮兜底），
  localStorage 持久化，开启时播试听咔
- 挂点：chess doMove/AI 回手(moveSfx 分流吃子易位)、新进入将军 check、将杀 mate、go place stone、review nav tick
### 材质
- 围棋盘：SVG linearGradient 木色渐变 + pattern 年轮纹（双色波浪线）+ 内框阴影，替换原纯色平涂
- 全站面板碳纹噪点：data-URI feTurbulence SVG 平铺（栅格化一次零运行成本），选择器加 body 前缀压过页面内联样式
- CRT 暗角收边：.vignette 径向渐变层随 initAmbient 注入
版本 motion.js v33 / chess.js v34 / go.js v14 / review.js v8 / motion.css v31。
本地验证：四页按钮齐全、噪点生效（review 为子元素级属预期）、木纹三件套就位、开关持久化往返正确、errs=[]。已部署树莓派。

### ISSUE-028 | 中 | server.js | 第十轮代码审查发现：GtpEngine.stop()/KataGoEngine._kill() 回收后不置 dead 标记——gnugo 等被空闲回收后的请求会连环报 "gtp not running"，直到 10 分钟池清除才自愈；KataGo 也要先失败一次才自愈 | ✅状态:已修复(2026-08-22)：stop/_kill 即置 dead=true，下次请求直接走重建路径
### ISSUE-029 | 低 | /chess.html | 翻转棋盘重建格子 DOM 会连带丢掉将军警报层（选中高亮上轮已修，警报层漏了） | ✅状态:已修复(2026-08-22)：flipBoard 内补 updateStatus() 刷新
## 第十轮回归记录（2026-08-22 新增面审查 + 线上巡检）
特效四批叠加后的性能回归：index/chess 特效全开+持续鼠标流+走子交互，长任务数 0、errs 0 ✓
线上巡检：cloudflared/服务双 active ✓ / 公网 200 (1.28s) ✓ / 引擎进程正常 ✓
版本 chess.js v35。

### ISSUE-030 | 中 | /chess.html | 第十一轮翻转专项发现（几何断言抓出）：AI 推荐高亮在黑方视角下横向全错——highlightBest 只镜像了行（row），漏了列（file），翻转后高亮块出现在错误文件上。此 bug 自高亮功能诞生起就存在，此前 QA 只验「出现」未验「位置」 | ✅状态:已修复(2026-08-22)：col = flip ? 7-f : f；实测翻转态 e5/Ne2 两次回手覆盖层中心与目标格偏差 <6px
### ISSUE-031 | 低(调试接口) | public/js/chess.js:527 | window.__board = board 在模块加载时执行，捕获的是 null（initBoard 在 window.load 后才赋值）——调试接口自始至终不可用，也导致历次依赖它的测试只跑了半截 | ✅状态:已修复(2026-08-22)：initBoard 内重新挂载真实引用
## 翻转专项回归记录（2026-08-22，11 项全过）
翻转态下逐项验证：走子 e4 ✓ / 选马高亮 3 合法点 ✓ / 将军警报落 e1 且视觉重合 ✓ / 吃子碎裂坐标精确 ✓ /
AI 高亮几何 centeredOk=true ×2（修复后）✓ / piece-drop 弹跳 ✓ / movelist·评估条正常 ✓ /
围棋页视图旋转+点击映射（第9轮）✓。另：测试框架修正——CDP exceptionDetails 在响应顶层，此前所有异常被吞成 undefined。
版本 chess.js v37。

## 视口预算排版上线（2026-08-22，需求：1440×900 屏最大化浏览器内无滚动）
布局改造：html/body 100vh + overflow hidden，topbar flex:none，内容区 flex:1 撑满剩余；
chess 页新增 fitBoard()（构造前按视口算边长，clamp 280~720，评估条随行），面板改纵向 flex
让走法列表吃掉剩余高度内部滚动，#cands 加 148px 内滚；go 页 CELL/PAD 改动态，fitGo() 按
winbar/标签实测高度反推棋盘边长（300~640），resize/切路数即席重排。
≤960px 宽自动回退自然文档流（移动端可滚动属预期）。
多分辨率实测（CDP 仿真）：1440×790 / 1280×720 / 1512×848 / 1920×1080 双页 v+h 滚动全 false ✓；
棋盘自适应 460→702(chess)/638(go) ✓；大棋盘下点击映射精确（e2 选中 2 点、e4 落子）✓。
版本 chess.js v38 / go.js v15。已部署树莓派。

## 排版回调（2026-08-22，用户反馈：自适应棋盘过大）
保留视口预算布局（无滚动 + 模块位置自适应），棋盘恢复固定原尺寸：chess 460×460 / go 538(CELL27·PAD26)。
移除 fitBoard()/fitGo() 缩放逻辑。四档分辨率复测双页零滚动 ✓，边长确认 460/538 ✓。
版本 chess.js v39 / go.js v16。已部署树莓派。

## 排版 v3 上线（2026-08-22，需求：棋盘置顶、模块下沉）
chess/go 两页重构为「board-zone 置顶居中 + 底部模块坞」：
- chess 坞内四模块：对局设置 / 操作与评估(按钮·状态·思考·evaltxt·折线图) / 推荐走法(内滚) / 对局记录(内滚)
- go 坞内四模块：对局设置 / 操作与状态 / 胜率评估 / 推荐落点(内滚)
棋盘保持固定原尺寸（460/538），≤1180/1080px 宽自动换行回退。
实测 1440×790 与 1280×720：双页零滚动，boardTop≈74 紧贴 topbar，dock 在下 ✓；
功能抽测 e4 落子 + movelist 归坞 ✓，go 四模块就位 ✓。纯 HTML/CSS 改动（JS 零改动），已部署树莓派。

## 排版 v4 上线（2026-08-22，需求：恢复左右布局、右侧重排提空间利用）
棋盘居左（460/538 原尺寸 + 评估条/胜率条随行），右侧 2×2 模块网格与棋盘等高（align stretch）：
- chess：对局设置 | 操作+状态+评估折线图 ‖ 推荐走法(内滚) | 对局记录(内滚)
- go：引擎/大小/执子/强度 | 按钮+状态 ‖ 胜率评估 | 推荐落点(内滚)
右栏宽度 min(640, 100vw-560)（go 同理），≤1240px 宽自动换行回退。
实测 1440×790 / 1280×720 双页零滚动、四模块就位、走子正常。纯 HTML/CSS，已部署树莓派。

## 特效 v5 上线（2026-08-22，交互反馈强化）
chess：①开局/新对局 32 枚棋子错峰集结落位（回弹曲线+16ms 步进）②新对局信号绿斜向扫屏重置
③吃子时棋盘微震（±2px 180ms）④新进入将军屏幕红边径向脉冲一次 ⑤AI 思考中棋盘呼吸辉光（随 setThinking 开关）
⑥评估变化 ≥8cp 时评估文本方向色闪（绿升/红降）
go：思考中木盘 drop-shadow 呼吸辉光；悔棋/清空扫屏重置。
过程注记：首轮补丁因断言过期整体未落盘、次轮只写了调用侧导致半残——已全量重打并 grep 验证 5 函数定义+调用齐备。
本地验证：sweep=true/assembling=32/辉光开关/震屏/红边消散/go 扫屏 全过，errs=[]。
版本 chess.js v40 / go.js v17。已部署树莓派。

## go 页样式与 chess 对齐（2026-08-22）
清理三处历史残留：①死 CSS（.go-wrap/.panel-go/@media960 旧块）②网格行高 1fr/1.2fr → 与 chess 一致的 1fr/1fr
③site.css 版本参数 v5→v26 统一。确认 .wrbar/.wrmono 由共享 site.css 提供（14px 高恢复）。
新 style 与 chess.html v4 完全同构（仅配色沿用 go 主题），特效 v5 块与 cand 样式保留。
本地实测零滚动、四模块、链路正常。已部署树莓派。

### ISSUE-032 | 中(布局) | go.html + chess.html | 排版 v4 把 body{display:flex} 写丢 flex-direction:column——topbar 与内容区横向并排，topbar 占掉左侧 ~450px，棋盘被挤到页面中部偏右（实测 boardL=466），右侧栏也被压缩（620→408） | ✅状态:已修复(2026-08-22)：补 flex-direction:column。几何复测：go boardL 135/sideW 620、chess boardL 164/sideW 640，side.left ≥ board.right 全过，双页零滚动。已部署树莓派。

### ISSUE-033 | 中(布局) | go/chess | 用户截图实证：浏览器缩放 ≥125% 时等效视宽跌破 1240 断点，触发换行回退变竖排——断点定得过高没考虑缩放场景 | ✅状态:已修复(2026-08-22)：换行断点 1240/1180 → 880；右栏宽度改 clamp(下限, calc(100vw-X), 上限) 弹性钳制（go 330~620 / chess 340~640）；label 加省略号防撑破。实测等效 960/1100/1440 三档全部左右布局且零滚动。已部署树莓派。
