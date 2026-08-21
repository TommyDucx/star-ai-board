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
  let lastCandidates = [];
  let evalHistory = [];   // 全程白方胜率历史（用于折线图）

  /* ---------------- WS 连接 ---------------- */
  function connect() {
    ws = new WebSocket(`ws://${location.host}`);
    ws.onopen = () => { wsReady = true; };
    ws.onclose = () => { wsReady = false; setTimeout(connect, 2000); };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.err ? p.rej(new Error(m.message)) : p.res(m); }
    };
  }
  function rpc(type, payload) {
    return new Promise((res, rej) => {
      const id = "c" + (++msgId);
      pending.set(id, { res, rej });
      const send = () => ws.send(JSON.stringify({ type, id, ...payload }));
      if (wsReady) send(); else ws.onopen = () => { wsReady = true; send(); };
    });
  }

  // 动态填充可用引擎（Reckless/自研引擎二进制未就位时不显示）
  async function loadEngines() {
    try {
      const r = await rpc("engines", {});
      const sel = document.getElementById("engine");
      if (!sel || !r.engines) return;
      const names = { stockfish: "Stockfish 18", reckless: "Reckless 0.10", "my-engine": "MyEngine 0.2.0（手写eval）", "my-engine-nnue": "MyEngine NNUE（增量评估）" };
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
    if (!mv) return false;
    updateStatus();
    scheduleEval();
    return true;
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

  // 渲染函数：根据最新状态重绘整个棋盘（重绘会重建格子 DOM，故重绘后重画选中/合法点高亮）
  function render() {
    board.position(game.fen(), false);
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
        render();
        return;
      }
      if (legalTargets.includes(square)) {   // 点击合法落点：执行移动，重置选中与合法落点
        doMove(selectedSq, square);
        clearSelection();
        render();
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
  function onSnapEnd() { render(); }

  let evalTimer = null;
  function scheduleEval() {
    clearTimeout(evalTimer);
    evalTimer = setTimeout(async () => {
      if (game.game_over()) return;
      const engine = document.getElementById("engine").value;
      const engineName = document.getElementById("engine").options[document.getElementById("engine").selectedIndex].textContent;
      try {
        const r = await rpc("chess", { engine, fen: game.fen(), movetime: 250, multipv: 1 });
        const c = (r.candidates && r.candidates[0]) || null;
        if (c) updateEval(c);
      } catch (e) { /* 静默：保持上一版胜率 */ }
    }, 400);
  }

  // chessboard.js 0.3.0 不支持 onSquareClick 且会拦截 click 事件；
  // 用 pointerdown 记录格子 + 移动距离判定点击（点击棋子任意位置均可选中，不依赖 up 的 target）
  let press = null;
  function boardPointer(e) {
    const sqEl = e.target.closest(".square-55d63");
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
    });
    document.getElementById("board").addEventListener("pointerdown", boardPointer);
    document.addEventListener("pointermove", boardPointer);
    document.addEventListener("pointerup", boardPointer);
    applyOrientation();
    updateStatus();
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
    const elo = +document.getElementById("level").value || null;
    const movetime = +document.getElementById("movetime").value;
    try {
      const r = await rpc("chess", { engine, fen: game.fen(), elo, movetime, multipv: 3 });
      const cands = (r.candidates || []).map(c => ({ ...c, uci: c.pv && c.pv[0] }));
      renderCands(cands, r.bestmove);
      updateEval(cands[0]);
      const mv = r.bestmove ? san(r.bestmove) : "—";
      if (r.bestmove) {
        const done = game.move({ from: r.bestmove.slice(0, 2), to: r.bestmove.slice(2, 4), promotion: "q" });
        if (done) {
          board.position(game.fen());
          updateStatus();
          const nextSide = game.turn() === "w" ? "白方" : "黑方";
          setStatus(`[${engineName}] AI 落子：${mv} · 轮到 ${nextSide}`, false);
          // 高亮 AI 刚走的一步（from→to），保证高亮位置与移动的棋子一致
          setTimeout(() => highlightBest([r.bestmove]), 150);
        }
      }
    } catch (e) {
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
      let row = 8 - +sq[1];               // 白方朝下：rank1 在底部
      if (flip) row = +sq[1] - 1;         // 黑方朝下：rank1 在顶部
      const el = document.createElement("div");
      el.style.cssText = `position:fixed;left:${r.left + f * size}px;top:${r.top + row * size}px;` +
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
      const pv = (c.pv || []).slice(0, 4).map(san).join(" ");
      return `<div class="cand"><span class="n">${i + 1}</span>
        <span style="font-size:13px">${uci ? san(uci) : "—"}</span>
        <span class="pv">${pv}</span><span class="score">${score}</span></div>`;
    }).join("") || '<div style="color:var(--faint);font-size:12px">暂无推荐</div>';
  }

  function updateEval(c) {
    const el = document.getElementById("evaltxt");
    if (!c) { if (el) el.textContent = "评估：—"; return; }
    let txt, wpct;
    if (c.mate != null) {
      txt = `强制杀王 mate${c.mate < 0 ? "-" : "+"}${Math.abs(c.mate)}`;
      wpct = c.mate > 0 ? 100 : 0;   // mate 正 = 白方杀王
    } else {
      txt = `白方 +${(c.evalCp / 100).toFixed(2)}`;
      wpct = 1 / (1 + Math.pow(10, -c.evalCp / 400)) * 100;  // logistic 换算白方胜率
    }
    wpct = Math.min(100, Math.max(0, wpct));
    if (el) el.textContent = "评估：" + txt + "（深度 " + c.depth + "）";
    // 左侧竖条 + 胜率具体数值（白方视角，统一用 logistic 胜率）
    document.getElementById("evalfill").style.height = wpct + "%";
    const pctEl = document.getElementById("evalpct");
    if (pctEl) pctEl.textContent = `白 ${wpct.toFixed(1)}%`;
    // 记录全程胜率历史并重绘折线图
    evalHistory.push(wpct);
    drawEvalChart();
  }

  // 全程胜率折线图（canvas，白方胜率 0~100%，100% 在顶部）
  function drawEvalChart() {
    const cv = document.getElementById("evalchart");
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth || 280, cssH = 120;
    if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
      cv.width = Math.round(cssW * dpr);
      cv.height = Math.round(cssH * dpr);
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    // 背景
    ctx.fillStyle = "#1a1d21";
    ctx.fillRect(0, 0, cssW, cssH);
    // 50% 中线
    ctx.strokeStyle = "#3a4048";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, cssH / 2); ctx.lineTo(cssW, cssH / 2); ctx.stroke();
    const n = evalHistory.length;
    if (!n) return;
    const pt = (i) => {
      const x = n === 1 ? cssW / 2 : (i / (n - 1)) * cssW;
      const y = ((100 - evalHistory[i]) / 100) * cssH;
      return [x, y];
    };
    // 折线
    ctx.strokeStyle = "#d7ff3f";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const [x, y] = pt(i);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    // 最新点
    const [lx, ly] = pt(n - 1);
    ctx.fillStyle = "#d7ff3f";
    ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI * 2); ctx.fill();
  }

  function resetEvalUI() {
    document.getElementById("evalfill").style.height = "50%";
    const pctEl = document.getElementById("evalpct");
    if (pctEl) pctEl.textContent = "白 50.0%";
    drawEvalChart();
  }

  function updateStatus() {
    if (game.in_checkmate()) { setStatus("将死！" + (game.turn() === "w" ? "黑方" : "白方") + " 胜", true); return; }
    if (game.in_draw()) { setStatus("和棋", true); return; }
    setStatus(`${game.turn() === "w" ? "白方" : "黑方"}行棋` + (game.in_check() ? "（将军）" : ""));
  }
  function setStatus(txt, alert) {
    const el = document.getElementById("status");
    el.textContent = txt;
    el.classList.toggle("alert", !!alert);
  }
  function setThinking(on) { document.getElementById("thinking").classList.toggle("on", on); }

  /* ---------------- 按钮 ---------------- */
  function newGame() { game.reset(); board.position("start"); lastCandidates = []; evalHistory = []; resetEvalUI(); updateStatus(); }
  function undo() { game.undo(); board.position(game.fen()); if (evalHistory.length) evalHistory.pop(); drawEvalChart(); updateStatus(); }
  function flipBoard() { board.flip(); }

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
    const noElo = ["reckless", "my-engine", "my-engine-nnue"].includes(e.target.value);
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
  initBoard();
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


