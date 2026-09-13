/* =============================================================================
   国际象棋前端：chessboard.js + chess.js + 本地 Stockfish（UCI）
   AI 推荐下一步：引擎思考后高亮 Top 候选走法
   ============================================================================= */
(function () {
  "use strict";
  const game = new Chess();
  let board = null;
  let myColor = "white";
  let ws = null, wsReady = false, msgId = 0, pending = new Map();
  const sendQueue = [];   // ws 未就绪时排队的请求（onopen 统一发送，重连不丢）
  let lastCandidates = [];
  let session = 0;   // 对局代次：新对局/悔棋时自增，作废迟到的引擎回复（防污染新棋局）

  /* ---------------- WS 连接 ---------------- */
  function connect() {
    try {
      // 公网是 HTTPS：必须用 wss://，ws:// 会被浏览器拦截并抛异常
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}`);
      ws.onopen = () => { wsReady = true; sendQueue.splice(0).forEach(fn => fn()); };
      ws.onclose = () => {
        wsReady = false;
        // 断线瞬间：所有挂起请求立即失败，避免永远悬空（分析卡死在「分析中」）
        for (const [, pr] of pending) pr.rej(new Error("连接中断"));
        pending.clear();
        setTimeout(connect, 2000);
      };
      ws.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m && (m.code === "AUTH_REQUIRED" || m.code === "MUST_CHANGE")) {
          const p = pending.get(m.id);
          if (p && p.silent) {
            pending.delete(m.id);
            p.rej(new Error(m.code === "AUTH_REQUIRED" ? "未登录" : "请先修改密码"));
          } else {
            location.href = "/admin/login.html";
          }
          return;
        }
        const p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          if (m.err || m.type === "error") p.rej(new Error(m.message || "引擎错误"));
          else p.res(m);
        }
      };
    } catch (e) {
      // ws 失败不影响棋盘渲染，稍后重试
      setTimeout(connect, 2000);
    }
  }
  function rpc(type, payload, opts) {
    return new Promise((res, rej) => {
      const id = "c" + (++msgId);
      pending.set(id, { res, rej, silent: !!(opts && opts.silent) });
      const send = () => ws.send(JSON.stringify({ type, id, ...payload }));
      if (wsReady) send(); else sendQueue.push(send);
    });
  }

  // 动态填充可用引擎（Reckless/自研引擎二进制未就位时不显示）
  async function loadEngines() {
    try {
      const r = await rpc("engines", {});
      const sel = document.getElementById("engine");
      if (!sel || !r.engines) return;
      const names = {
        stockfish: "Stockfish 18（≈3640·世界最强）",
        reckless: "Reckless 0.10（≈3600·顶级）",
        plentychess: "PlentyChess 8.0（≈3590·顶级）",
        alexandria: "Alexandria 9（≈3560·顶级）",
        viridithas: "Viridithas 20（≈3550·顶级）",
        quanticade: "Quanticade Cronus 3.0（≈3520·强）",
        halogen: "Halogen 15（≈3500·强）",
        clover: "Clover 9.1（≈3490·强）",
        berserk: "Berserk 13（≈3460·强）",
        ethereal: "Ethereal 14（≈3420·强）",
        "my-engine": "BiaoZi 手写eval（≈800·入门）",
        "my-engine-nnue": "BiaoZi NNUE（≈500·实验）",
      };
      sel.innerHTML = r.engines.filter(e => e.available)
        .map(e => `<option value="${e.key}">${names[e.key] || e.key}</option>`)
        .join("") || `<option value="stockfish">Stockfish 18</option>`;
    } catch (e) { /* 默认保留静态选项 */ }
  }

  /* ---------------- 独立功能模块：棋子合法位移计算、移动执行、渲染 ---------------- */

  // 棋子合法位移计算：输入棋子坐标，依据走法规则/阻挡/敌我棋子，输出合法目标格子集合
  function legalMovesOf(sq) {
    return game.moves({ square: sq, verbose: true }).map(m => m.to);
  }

  // 执行移动：原位置清空，目标位置放上棋子（chess.js 同步更新棋盘）
  function doMove(from, to) {
    const mv = game.move({ from, to, promotion: "q" });
    if (!mv) {
      return false;
    }
    captureFx(mv);
    moveSfx(mv);
    StarChessMotion.pulse(document.getElementById("board"), mv);
    updateStatus();
    scheduleEval();
    return true;
  }

  /* ---- 棋感特效：吃子碎裂 / 将军王座警报 / 将杀终局 ---- */
  function sqXY(sq) {
    const el = document.querySelector(".board-b72b1 .square-" + sq);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  // 吃子碎裂：被吃方颜色的碎片从目标格迸出（Motion.fx 由 motion.js 提供，REDUCED 下为空）
  function captureFx(mv) {
    if (!mv || !mv.captured || !window.Motion || !Motion.fx) return;
    const pos = sqXY(mv.to);
    if (!pos) return;
    Motion.fx.burst(pos.x, pos.y,
      mv.color === "w" ? ["#f5f5f5", "#b9bfb6", "#d7ff3f"] : ["#5a6167", "#2e343a", "#d7ff3f"]);
  }
  // 走子/吃子/易位 音效（Motion.sfx 由 motion.js 注入，未就绪时静默）
  function moveSfx(mv) {
    if (!window.Motion || !Motion.sfx) return;
    if (mv.captured) Motion.sfx.capture();
    else if (/[kq]/.test(mv.flags || "")) Motion.sfx.castle();
    else Motion.sfx.move();
  }
  let alarmEl = null;
  let lastInCheck = false;
  function clearKingAlarm() {
    if (alarmEl) { alarmEl.remove(); alarmEl = null; }
  }
  // 将军王座警报：行棋方王的格子红色脉冲（视觉焦点直接给到威胁源）
  function kingAlarm() {
    if (!game.in_check()) return;
    const bd = game.board();
    let sq = null;
    for (let r = 0; r < 8 && !sq; r++) for (let c = 0; c < 8; c++) {
      const pc = bd[r][c];
      if (pc && pc.type === "k" && pc.color === game.turn()) { sq = "abcdefgh"[c] + (8 - r); break; }
    }
    if (!sq) return;
    const host = document.querySelector(".board-b72b1 .square-" + sq);
    if (!host) return;
    alarmEl = document.createElement("div");
    alarmEl.className = "king-check";
    host.appendChild(alarmEl);
  }
  let finaleShown = false;
  // 将杀终局：全屏色差抖动大字 + 对局手数
  function checkmateFinale() {
    if (finaleShown) return;
    finaleShown = true;
    const winner = game.turn() === "w" ? "BLACK WINS" : "WHITE WINS";   // 轮到走的一方已被将死
    const ov = document.createElement("div");
    ov.className = "checkmate-finale";
    ov.innerHTML = `<small>— CHECKMATE —</small><b>${winner}</b>` +
      `<i>将死 · 共 ${game.history().length} 手 · 点击任意处继续</i>`;
    document.body.appendChild(ov);
    const kill = () => { ov.remove(); document.removeEventListener("pointerdown", kill); };
    setTimeout(kill, 2600);
    document.addEventListener("pointerdown", kill);
  }

  // 状态：选中棋子坐标 + 合法位移点集合
  let selectedSq = null;
  let legalTargets = [];

  function squareEl(sq) {
    return document.querySelector(`.board-b72b1 .square-${sq}`);
  }
  function clearSelection() {
    selectedSq = null;
    legalTargets = [];
  }

  // 同步局面与选中标记。实际落子才开启动画，选中状态更新永不打断棋子行程。
  function render(animate) {
    StarChessMotion.sync(board, game.fen(), animate);
    document.querySelectorAll(".star-hl").forEach(el => el.remove());
    if (!selectedSq) return;
    const selEl = squareEl(selectedSq);
    if (selEl) {
      const o = document.createElement("div");
      o.className = "star-hl sel";
      selEl.appendChild(o);
    }
    legalTargets.forEach(sq => {
      const t = squareEl(sq);
      if (t) {
        const d = document.createElement("div");
        d.className = "star-hl dot";
        t.appendChild(d);
      }
    });
  }

  // 格子点击事件（优先级不可打乱）
  function onSquareClick(square) {
    if (game.game_over()) return;
    const piece = game.get(square);

    // 1. 存在已选中棋子
    if (selectedSq) {
      if (square === selectedSq) {           // 点击选中棋子本身：清空选中、清空合法落点
        clearSelection();
        render(false);
        return;
      }
      if (legalTargets.includes(square)) {   // 点击合法落点：执行移动，重置选中与合法落点
        doMove(selectedSq, square);
        clearSelection();
        render(true);
        return;
      }
    }

    // 2. 无选中 或 上面条件均不命中
    if (piece && piece.color === game.turn()) {  // 点击己方棋子：更新选中坐标，计算该棋子全部合法移动点
      selectedSq = square;
      legalTargets = legalMovesOf(square);
    } else {                                     // 点击空白/敌方棋子：清空选中与合法落点
      clearSelection();
    }

    // 3. 执行一次棋盘刷新渲染
    render();
  }

  /* ---------------- 拖拽式下棋（拖拽开始清空选中，落子后统一渲染） ---------------- */
  function onDragStart(source, piece) {
    if (game.game_over()) return false;
    clearSelection();
    document.querySelectorAll(".star-hl").forEach(el => el.remove());
    return true;
  }
  function onDrop(source, target) {
    if (!doMove(source, target)) return "snapback";
  }
  function onSnapEnd() { render(false); }

  let evalTimer = null;
  function scheduleEval() {
    clearTimeout(evalTimer);
    evalTimer = setTimeout(async () => {
      if (game.game_over()) return;
      const mySession = session;
      const engine = document.getElementById("engine").value;
      const engineName = document.getElementById("engine").options[document.getElementById("engine").selectedIndex].textContent;
      try {
        const r = await rpc("chess", { engine, fen: game.fen(), movetime: 250, multipv: 1 }, { silent: true });
        if (mySession !== session) return;   // 已重置对局：丢弃迟到的评估
        const c = (r.candidates && r.candidates[0]) || null;
        if (c) updateEval(c);
      } catch (e) { /* 静默：保持上一版胜率 */ }
    }, 400);
  }

  // chessboard.js 0.3.0 不支持 onSquareClick 且会拦截 click 事件；
  // 用 pointerdown 记录格子 + 移动距离判定点击（点击棋子任意位置均可选中，不依赖 up 的 target）
  let press = null;
  function boardPointer(e) {
    // e.target 可能是 document（合成事件/极端时序），closest 不存在时直接忽略
    const sqEl = e.target && e.target.closest ? e.target.closest(".square-55d63") : null;
    const sq = sqEl ? ((sqEl.className.match(/square-([a-h][1-8])/) || [])[1] || null) : null;
    if (e.type === "pointerdown") {
      press = { sq, x: e.clientX, y: e.clientY, moved: false };
    } else if (e.type === "pointermove" && press) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.moved = true;
    } else if (e.type === "pointerup" && press) {
      if (!press.moved && press.sq) onSquareClick(press.sq);   // 未拖动 = 点击
      press = null;
    }
  }
  function initBoard() {
    board = Chessboard("board", {
      draggable: true,
      position: "start",
      onDragStart, onDrop, onSnapEnd, onSquareClick,
      pieceTheme: "img/chesspieces/wikipedia/{piece}.png",
      ...StarChessMotion.boardOptions(),
    });
    window.__board = board;   // 调试/测试用（此处才是真实引用，模块加载时 board 还是 null）
    document.getElementById("board").addEventListener("pointerdown", boardPointer);
    document.addEventListener("pointermove", boardPointer);
    document.addEventListener("pointerup", boardPointer);
    applyOrientation();
    updateStatus();
    assemblePieces();   // 开局棋子集结动画
    scheduleEval();   // 初始局面也评估一次，让折线图从开局就有胜率点
  }

  /* ---------------- 引擎分析（点击「推荐下一步」→ 自动走出该步） ---------------- */
  async function engineThink() {
    if (game.game_over()) { setStatus("对局结束", true); return; }
    setThinking(true);
    const sideName = game.turn() === "w" ? "白方" : "黑方";
    const engineSel = document.getElementById("engine");
    const engineName = engineSel.options[engineSel.selectedIndex].textContent;
    const engine = engineSel.value;
    setStatus(`[${engineName}] 分析中…（当前轮到 ${sideName}）`);
    const mySession = session;   // 记住发起时的对局代次
    const elo = +document.getElementById("level").value || null;
    const movetime = +document.getElementById("movetime").value;
    try {
      const r = await rpc("chess", { engine, fen: game.fen(), elo, movetime, multipv: 3 }, { silent: true });
      if (mySession !== session) return;   // 期间发生了新对局/悔棋：丢弃迟到回复，不在新棋盘落子
      const cands = (r.candidates || []).map(c => ({ ...c, uci: c.pv && c.pv[0] }));
      renderCands(cands, r.bestmove);
      updateEval(cands[0]);
      const mv = r.bestmove ? san(r.bestmove) : "—";
      if (r.bestmove) {
        const done = game.move({ from: r.bestmove.slice(0, 2), to: r.bestmove.slice(2, 4), promotion: "q" });
        if (done) {
          captureFx(done);
          moveSfx(done);
          StarChessMotion.sync(board, game.fen(), true);
          StarChessMotion.pulse(document.getElementById("board"), done);
          updateStatus();
          const nextSide = game.turn() === "w" ? "白方" : "黑方";
          setStatus(`[${engineName}] AI 落子：${mv} · 轮到 ${nextSide}`, false);
          // 高亮 AI 刚走的一步（from→to），保证高亮位置与移动的棋子一致
          setTimeout(() => {
            highlightBest([r.bestmove]);
            // AI 棋子落地小弹跳：目标格 img 加一次性动画类
            const pc = document.querySelector(".square-" + r.bestmove.slice(2, 4) + " img");
            if (pc) {
              pc.classList.add("piece-drop");
              pc.addEventListener("animationend", () => pc.classList.remove("piece-drop"), { once: true });
            }
          }, 150);
        }
      }
    } catch (e) {
      if (e.message === "未登录") {
        setStatus("引擎功能需登录后使用 · 请点击右上角登录", true);
        showAuthHint();
        return;
      }
      setStatus("分析失败: " + e.message, true);
    } finally {
      setThinking(false);
    }
  }

  function san(uci) {
    const mv = { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: "q" };
    const m = new Chess(game.fen());
    try { const r = m.move(mv); return r ? r.san : uci; } catch (e) { return uci; }
  }

  // PV 线顺序转 SAN：从当前局面克隆棋盘逐手推进（每一步都在前一步之后的位置上转换），
  // 遇非法着即断——否则第 2 手起对当前局面转换必失败，只能显示原始 UCI 坐标。
  // skipFirst=true 时首着仍要在克隆盘上走出（后续着法依赖它），只是不显示。
  function pvLine(pv, skipFirst) {
    const b = new Chess(game.fen());
    const list = (pv || []).slice(0, 5);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      try {
        const r = b.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: "q" });
        if (!(skipFirst && i === 0)) out.push(r ? r.san : u);
      } catch (e) { break; }
    }
    return out.join(" ");
  }

  let hlEls = [];
  function clearOverlays() { hlEls.forEach(e => e.remove()); hlEls = []; }
  function highlightBest(pv) {
    // 使用独立覆盖层高亮（棋盘重绘不会清掉），基于格子坐标定位，与棋子位置一致
    clearOverlays();
    if (!pv || !pv[0]) return;
    const boardEl = document.getElementById("board");
    const r = boardEl.getBoundingClientRect();
    const size = r.width / 8;
    const orient = board.orientation();
    const flip = orient === "black";
    [pv[0].slice(0, 2), pv[0].slice(2, 4)].forEach((sq, i) => {
      const f = sq.charCodeAt(0) - 97;
      // 翻转时行、列都要镜像：旧实现只翻了行，横向位置在黑方视角下全错（实测几何校验抓出）
      let col = f, row = 8 - +sq[1];              // 白方朝下：a 列在左、rank1 在底
      if (flip) { col = 7 - f; row = +sq[1] - 1; } // 黑方朝下：a 列在右、rank1 在顶
      const el = document.createElement("div");
      el.style.cssText = `position:fixed;left:${r.left + col * size}px;top:${r.top + row * size}px;` +
        `width:${size}px;height:${size}px;background:rgba(215,255,63,${i === 0 ? 0.28 : 0.42});` +
        `pointer-events:none;z-index:90;`;
      document.body.appendChild(el);
      hlEls.push(el);
    });
    setTimeout(clearOverlays, 1200);
  }

  function renderCands(cands, best) {
    const el = document.getElementById("cands");
    el.innerHTML = cands.map((c, i) => {
      const score = c.mate != null ? `mate${c.mate < 0 ? "-" : "+"}${Math.abs(c.mate)}`
        : `${c.evalCp >= 0 ? "+" : ""}${(c.evalCp / 100).toFixed(2)}`;
      const uci = c.pv && c.pv[0];
      // 首格显示主着 SAN；后续 PV 线从第 2 手开始顺序转换（不重复首着）
      const pv = uci ? pvLine(c.pv, true) : "";
      return `<div class="cand"><span class="n">${i + 1}</span>
        <span style="font-size:13px">${uci ? san(uci) : "—"}</span>
        <span class="pv">${pv}</span><span class="score">${score}</span></div>`;
    }).join("") || '<div style="color:var(--faint);font-size:12px">暂无推荐</div>';
  }

  // 胜率历史（0..100，白方视角），驱动折线图
  const evalHist = [];
  function drawEvalChart() {
    const cv = document.getElementById("evalchart");
    if (!cv || !cv.getContext) return;
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(255,255,255,.14)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(4, H / 2); ctx.lineTo(W - 4, H / 2); ctx.stroke();
    ctx.setLineDash([]);
    if (evalHist.length < 2) return;
    ctx.strokeStyle = "#d7ff3f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    evalHist.forEach((v, i) => {
      const x = 4 + (i / (evalHist.length - 1)) * (W - 8);
      const y = H - 5 - (v / 100) * (H - 10);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // 末点高亮
    const lx = 4 + (W - 8), ly = H - 5 - (evalHist[evalHist.length - 1] / 100) * (H - 10);
    ctx.fillStyle = "#d7ff3f";
    ctx.beginPath(); ctx.arc(Math.min(lx, W - 6), ly, 3, 0, Math.PI * 2); ctx.fill();
  }

  let lastEvalCp = null;
  function flashEvalDir(cp) {
    if (lastEvalCp != null && Math.abs(cp - lastEvalCp) >= 8) {
      const el = document.getElementById("evaltxt");
      if (el) {
        el.classList.remove("flash-up", "flash-down");
        void el.offsetWidth;
        el.classList.add(cp > lastEvalCp ? "flash-up" : "flash-down");
        setTimeout(() => el.classList.remove("flash-up", "flash-down"), 700);
      }
    }
    lastEvalCp = cp;
  }
  function updateEval(c) {
    const el = document.getElementById("evaltxt");
    if (!c) { if (el) el.textContent = "评估：—"; return; }
    let txt, wpct;
    if (c.mate != null) {
      txt = `强制杀王 mate${c.mate < 0 ? "-" : "+"}${Math.abs(c.mate)}`;
      wpct = c.mate > 0 ? 100 : 0;   // mate 正 = 白方杀王
    } else {
      txt = `白方 ${c.evalCp >= 0 ? "+" : ""}${(c.evalCp / 100).toFixed(2)}`;
      wpct = 1 / (1 + Math.pow(10, -c.evalCp / 400)) * 100;  // logistic 换算白方胜率
    }
    wpct = Math.min(100, Math.max(0, wpct));
    if (c.evalCp != null) flashEvalDir(c.evalCp);
    evalHist.push(wpct);
    drawEvalChart();
    if (el) el.textContent = "评估：" + txt + "（深度 " + c.depth + "）";
    // 左侧竖条 + 胜率具体数值（白方视角，统一用 logistic 胜率）
    document.getElementById("evalfill").style.transform = "scaleY(" + (wpct / 100) + ")";
    const pctEl = document.getElementById("evalpct");
    if (pctEl) pctEl.textContent = `白 ${wpct.toFixed(1)}%`;
  }

  function resetEvalUI() {
    document.getElementById("evalfill").style.transform = "scaleY(0.5)";
    const pctEl = document.getElementById("evalpct");
    if (pctEl) pctEl.textContent = "白 50.0%";
    evalHist.length = 0;
    drawEvalChart();
  }

  // 走法列表：两列成行填入 #movelist（doMove/AI 落子/悔棋/新对局都经过 updateStatus，单点覆盖）
  function updateMoveList() {
    const tb = document.querySelector("#movelist tbody");
    if (!tb) return;
    const h = game.history();
    tb.innerHTML = h.length
      ? Array.from({ length: Math.ceil(h.length / 2) }, (_, i) =>
          `<tr><td class="num">${i + 1}.</td><td class="mv">${h[2 * i]}</td><td class="mv">${h[2 * i + 1] || ""}</td></tr>`
        ).join("")
      : "";
    const box = tb.closest(".moves");
    if (box) box.scrollTop = box.scrollHeight;
  }

  function updateStatus() {
    updateMoveList();
    clearKingAlarm();
    if (game.in_checkmate()) {
      checkmateFinale();
      if (window.Motion && Motion.sfx) Motion.sfx.mate();
      setStatus("将死！" + (game.turn() === "w" ? "黑方" : "白方") + " 胜", true); return;
    }
    if (game.in_draw()) { lastInCheck = false; setStatus("和棋", true); return; }
    const nowInCheck = game.in_check();
    if (nowInCheck && !lastInCheck) {
      if (window.Motion && Motion.sfx) Motion.sfx.check();
      edgeFlash();
    }
    lastInCheck = nowInCheck;
    kingAlarm();
    setStatus(`${game.turn() === "w" ? "白方" : "黑方"}行棋` + (nowInCheck ? "（将军）" : ""));
  }
  function setStatus(txt, alert) {
    const el = document.getElementById("status");
    el.textContent = txt;
    el.classList.toggle("alert", !!alert);
  }
  // 未登录提示：在状态栏下方插入小横幅（仅一次），引导登录而非强制跳转
  function showAuthHint() {
    if (document.querySelector(".auth-hint")) return;
    const anchor = document.getElementById("status");
    if (!anchor || !anchor.parentNode) return;
    const a = document.createElement("div");
    a.className = "auth-hint";
    a.style.cssText = "margin-top:8px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--muted);font-size:12px";
    a.innerHTML = '未登录 · 引擎推荐需登录 · <a href="/admin/login.html" style="color:var(--signal)">登录</a>';
    anchor.parentNode.insertBefore(a, anchor.nextSibling);
  }
  function setThinking(on) {
    document.getElementById("thinking").classList.toggle("on", on);
    const bz = document.querySelector(".board-zone");
    if (bz) bz.classList.toggle("thinking-glow", !!on);
  }

  /* ---- 特效工具 v5 ---- */
  function assemblePieces() {
    document.querySelectorAll("#board img[src*=chesspieces]").forEach((img, i) => {
      img.classList.remove("piece-assemble");
      void img.offsetWidth;
      img.style.animationDelay = (i * 16) + "ms";
      img.classList.add("piece-assemble");
      img.addEventListener("animationend", () => { img.classList.remove("piece-assemble"); img.style.animationDelay = ""; }, { once: true });
    });
  }
  function sweepReset() {
    const bz = document.querySelector(".board-zone");
    if (!bz) return;
    bz.querySelectorAll(".reset-sweep").forEach(e => e.remove());
    const d = document.createElement("div");
    d.className = "reset-sweep";
    bz.appendChild(d);
    setTimeout(() => d.remove(), 600);
  }
  let edgeFlashEl = null;
  function edgeFlash() {
    if (edgeFlashEl) return;
    edgeFlashEl = document.createElement("div");
    edgeFlashEl.className = "edge-red";
    document.body.appendChild(edgeFlashEl);
    setTimeout(() => { if (edgeFlashEl) { edgeFlashEl.remove(); edgeFlashEl = null; } }, 650);
  }
  /* ---------------- 按钮 ---------------- */
  function newGame() {
    session++; finaleShown = false; clearKingAlarm();
    document.querySelectorAll(".checkmate-finale").forEach(e => e.remove());
    game.reset();
    StarChessMotion.sync(board, game.fen(), false);
    lastCandidates = []; lastInCheck = false; clearOverlays(); lastEvalCp = null;
    resetEvalUI(); updateStatus();
    sweepReset();
    assemblePieces();
  }
  function undo() { session++; finaleShown = false; game.undo(); StarChessMotion.sync(board, game.fen(), true); updateStatus(); }
  function flipBoard() {
    board.flip();
    // flip 会重建格子 DOM，清掉 .star-hl overlay 与将军警报层；重绘选中态并刷新警报
    if (selectedSq) render();
    updateStatus();
  }

  // 依据"我执的棋"决定棋盘朝向：所选颜色在下方，另一色在上方
  function applyOrientation() {
    if (board) board.orientation(myColor === "white" ? "white" : "black");
  }
  document.getElementById("side").addEventListener("change", e => {
    myColor = e.target.value;
    newGame();
    applyOrientation();
  });
  document.getElementById("engine").addEventListener("change", e => {
    // Reckless / 自研引擎不支持 Elo 分级：切换时禁用难度
    const noElo = e.target.value !== "stockfish"; // 仅 Stockfish 支持 UCI_Elo 限强
    const levelSel = document.getElementById("level");
    levelSel.disabled = noElo;
    document.getElementById("level").parentElement.querySelector("label").textContent =
      noElo ? "难度（该引擎自带棋力，忽略此设置）" : "难度（引擎棋力）";
  });
  document.getElementById("movetime").addEventListener("input", e => {
    document.getElementById("mtlbl").textContent = e.target.value;
  });

  connect();
  loadEngines();
  // 未登录访客：探测 /api/me，401 时显示登录提示（不跳转）
  fetch("/api/me").then(r => { if (r.status === 401) showAuthHint(); }).catch(() => {});
  // 延迟到 window.load：公网/慢网络下 jQuery/chessboard.min.js 可能未就绪，
  // 立即执行会测到 #board=0 高度导致棋盘消失。所有资源就绪后再初始化。
  if (document.readyState === "complete") {
    initBoard();
  } else {
    window.addEventListener("load", initBoard, { once: true });
  }
  // 窄屏自适应：视口变化后按容器宽度重算棋盘尺寸
  window.addEventListener("resize", () => { if (board && board.resize) board.resize(); });
  window.engineThink = engineThink;
  window.newGame = newGame;
  window.undo = undo;
  window.flipBoard = flipBoard;
  window.__board = board;   // 调试/测试用
  window.__game = game;
  window.onSquareClick = onSquareClick;

  window.selectedSq = () => selectedSq;

  window.reviewGame = function () {
    const hist = game.history({ verbose: true });
    if (!hist.length) { setStatus("对局为空，先走几步再复盘", true); return; }
    // 存详细走法（含 UCI from/to、吃子、将军信息），供复盘页判定
    localStorage.setItem("star_review_moves", JSON.stringify(
      hist.map(m => ({
        from: m.from, to: m.to, promotion: m.promotion || null,
        san: m.san, color: m.color, piece: m.piece, captured: m.captured || null,
        flags: m.flags || "",
      }))
    ));
    location.href = "review.html";
  };

})();
