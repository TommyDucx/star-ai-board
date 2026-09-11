# QA Fixes 方案

> 对应 qa_issues.md 的 10 个 ISSUE，全部经源码核实。日期 2026-08-22。
> 原则：最小可验证修复，不做重构；改 .js 必须 html 里 ?v=N+1（AGENTS.md 坑9）。

### ISSUE-001 | 已确认 | 根因：public/js/chess.js 全文无 movelist 渲染逻辑（chess.html:98 的 `<table id="movelist">` 是死元素） | 方案：chess.js 新增 `updateMoveList()`——读 `game.history()` 两列成行填入 tbody、滚动到底部；挂到 `updateStatus()` 末尾调用（doMove / engineThink AI 落子 / undo / newGame 全部经过 updateStatus，单点覆盖所有路径） | 回归风险：低（纯新增渲染） | 验证：走 3 步后断言 `#movelist tr` 数量=2 且含 SAN 文本
### ISSUE-002 | 已确认 | 根因：chess.js:206 engineThink 与 :161 scheduleEval 的 rpc 无取消机制；newGame()/undo() 重置后，迟到的 Promise 继续在全新棋盘上 game.move()+setStatus（旧引擎名残留） | 方案：加会话令牌 `let session=0`；newGame()、undo()、side change 各 `session++`；engineThink/scheduleEval 在 await 前捕获 `const my=session`，await 后 `if(my!==session) return`（丢弃迟到结果，不再落子不再写状态） | 回归风险：低（只在重置后丢弃结果） | 验证：触发思考→立刻新对局→等 5s 断言 history 保持 0、status 为「白方行棋」
### ISSUE-003 | 已确认 | 根因：chess.js:277 renderCands 把 PV 每一步独立用 san() 对**当前局面**转换（第 2 手起非法→回退原始 uci）；且首着在两个 span 重复显示（"d5 d5"） | 方案：新增 `pvLine(pv)`——从 game.fen() 克隆 Chess 逐手推进收集 SAN（非法即断）；renderCands 用它替换 slice(0,4).map(san)，同时去掉首 span 与 pv 行的首着重复 | 回归风险：低 | 验证：推荐列表每条 pv 行无 c2c4 类原始坐标、首着不重复
### ISSUE-004 | 已确认 | 根因：go.js:71 SVG 写死像素 width/height 属性（19路=538px），CSS 无 max-width 约束，375px 视口溢出 82px | 方案：go.html 内联 style 加媒体查询 ≤640px：`.board-card svg{max-width:100%;height:auto}` `.panel-go{width:100%}`（viewBox 保证等比缩放） | 回归风险：低（仅小屏生效） | 验证：375px 仿真 scrollWidth≤375
### ISSUE-005 | 已确认 | 根因：review.html 明细表/统计表在小屏无横向滚动兜底，内容把容器撑到 527px | 方案：review.html 加媒体查询 ≤640px：`.rev-wrap table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch}` `.rev-wrap{padding:18px 10px 40px}` `#curve-box{padding:8px}` | 回归风险：低 | 验证：375px 仿真无横向溢出（若仍有溢出元素再用 CDP 精确定位补一条规则）
### ISSUE-006 | 已确认 | 根因：server.js:165-173 静态服务对全部资源发 `no-cache,no-store,must-revalidate` 且无 gzip（jquery.min.js 88KB 明文），热加载全量重传 | 方案：server.js 引入 zlib——text/* 且 >1KB 且 Accept-Encoding 含 gzip 时 gzipSync 返回并带 `Vary: Accept-Encoding`；缓存策略分级：.html → `no-cache`（保持新鲜校验），其余静态 → `public, max-age=604800`（?v=N 版本号已具备，安全） | 回归风险：中低（改的是响应头与编码，注意旧 Chrome 不支持则走非压缩分支；html 不长缓存避免改版不生效） | 验证：curl -I 看 Content-Encoding: gzip 与 Cache-Control；二次加载 from-cache
### ISSUE-007 | 已确认 | 根因：public/ 下无 favicon.ico，浏览器默认请求必 404 | 方案：用脚本生成一个 16×16 合法 ICO 放入 public/favicon.ico（无需改任何 html） | 回归风险：零 | 验证：curl -o /dev/null -w %{http_code} /favicon.ico = 200
### ISSUE-008 | 已确认 | 根因：chess.js:292 `白方 +${(c.evalCp/100).toFixed(2)}` 对负 cp 产生 "+-" | 方案：改为 `${c.evalCp>=0?"+":""}${(c.evalCp/100).toFixed(2)}` | 回归风险：零 | 验证：负分局面评估文本形如「白方 -0.26」
### ISSUE-009 | 已确认 | 根因：AGENTS.md 第九节宣称「实时胜率折线图」，实现里只有竖条 evalfill + 百分比，无折线图组件（注释提及但从未实现） | 方案：补上轻量实现——chess.html panel 里加 `<canvas id="evalchart" width="276" height="56">`；chess.js 维护 `evalHist[]`（每次 updateEval push 白方胜率），newGame 清空；drawEvalChart() 画折线+末点高亮，50% 处虚线基准 | 回归风险：低（纯新增，canvas 不存在时静默跳过） | 验证：走子后 canvas 非空白（getImageData 采样有非透明像素）
### ISSUE-010 | 已确认 | 根因：前端从未定义 window.__errs 错误采集器（QA 规范依赖它） | 方案：5 个页面 head 内联 4 行脚本：`window.__errs=[];window.addEventListener("error",e=>window.__errs.push(String(e.message)))` | 回归风险：零 | 验证：任意页 evaluate typeof window.__errs === object

## 建议实施顺序（一次部署打包）

1. **server.js**（ISSUE-006/007 服务端部分）：gzip + 缓存分级 —— 收益最大（冷加载 8.8s 大头是传输）
2. **chess.js + chess.html v28→29**（ISSUE-001/002/003/008/009）：功能缺陷集中在这两文件，一次改完
3. **go.html / review.html 媒体查询**（ISSUE-004/005）：纯 CSS 追加
4. **favicon.ico**（ISSUE-007）+ **各页 __errs 内联**（ISSUE-010）
5. 同步树莓派 → 重启 star-ai-board → CDP 全量回归（10 条验证步骤 + 通过清单复测）
