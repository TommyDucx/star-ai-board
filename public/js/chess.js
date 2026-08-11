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

  /* ---------------- 棋盘 ---------------- */
  function onDragStart(source, piece) {
    if (game.game_over()) return false;
    clearHighlights();
    return true; // 用户自己操控黑白双方
  }
  function onDrop(source, target) {
    const move = game.move({ from: source, to: target, promotion: "q" });
    if (move === null) return "snapback";
    updateStatus();
  }
  function onSnapEnd() { board.position(game.fen()); }

  /* ---------------- 点击式下棋（chess.com 风格） ---------------- */
  let selectedSq = null;
  function squareEl(sq) {
    return document.querySelector(`.board-b72b1 .square-${sq}`);
  }
  function clearHighlights() {
    document.querySelectorAll(".star-hl").forEach(el => el.remove());
    selectedSq = null;
  }
  function selectSquare(sq) {
    selectedSq = sq;
    const el = squareEl(sq);
    if (el) {
      const o = document.createElement("div");
      o.className = "star-hl sel";
      el.appendChild(o);
    }
    // 高亮合法落点
    game.moves({ square: sq, verbose: true }).forEach(m => {
      const t = squareEl(m.to);
      if (t) {
        const d = document.createElement("div");
        d.className = "star-hl dot";
        t.appendChild(d);
      }
    });
  }
  function onSquareClick(square) {
    if (game.game_over()) return;
    const piece = game.get(square);
    if (!selectedSq) {
      if (piece) selectSquare(square);   // 选中棋子
      return;
    }
    if (square === selectedSq) { clearHighlights(); return; } // 再点取消
    const mv = game.move({ from: selectedSq, to: square, promotion: "q" });
    if (mv) {
      clearHighlights();
      board.position(game.fen());
      updateStatus();
      return;
    }
    // 非法落点：点到己方棋子则改选，否则取消
    if (piece && piece.color === game.turn()) { clearHighlights(); selectSquare(square); }
    else clearHighlights();
  }

  function initBoard() {
    board = Chessboard("board", {
      draggable: true,
      position: "start",
      onDragStart, onDrop, onSnapEnd, onSquareClick,
      pieceTheme: "img/chesspieces/wikipedia/{piece}.png",
    });
    applyOrientation();
    updateStatus();
  }

  /* ---------------- 引擎分析（点击「推荐下一步」→ 自动走出该步） ---------------- */
  async function engineThink() {
    if (game.game_over()) { setStatus("对局结束", true); return; }
    setThinking(true);
    const sideName = game.turn() === "w" ? "白方" : "黑方";
    setStatus(`分析中…（当前轮到 ${sideName}）`);
    const elo = +document.getElementById("level").value || null;
    const movetime = +document.getElementById("movetime").value;
    try {
      const r = await rpc("chess", { fen: game.fen(), elo, movetime, multipv: 3 });
      const cands = (r.candidates || []).map(c => ({ ...c, uci: c.pv && c.pv[0] }));
      renderCands(cands, r.bestmove);
      const mv = r.bestmove ? san(r.bestmove) : "—";
      setStatus(`${sideName}行棋 · AI 落子：${mv}`, false);
      if (r.bestmove) {
        // 高亮推荐走法后 AI 自动走出该步
        highlightBest(cands[0] && cands[0].pv);
        const done = game.move({ from: r.bestmove.slice(0, 2), to: r.bestmove.slice(2, 4), promotion: "q" });
        if (done) {
          board.position(game.fen());
          updateStatus();
        }
      } else {
        updateEval(cands[0]);
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

  function highlightBest(pv) {
    // 高亮推荐起点/终点
    if (!pv || !pv[0]) return;
    const from = pv[0].slice(0, 2), to = pv[0].slice(2, 4);
    const fromEl = document.querySelector(`[data-square="${from}"]`);
    if (fromEl) fromEl.style.background = "#d7ff3f44";
    const toEl = document.querySelector(`[data-square="${to}"]`);
    if (toEl) toEl.style.background = "#d7ff3f66";
    setTimeout(() => {
      if (fromEl) fromEl.style.background = "";
      if (toEl) toEl.style.background = "";
    }, 1200);
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
    if (!c) { el.textContent = "评估：—"; return; }
    let txt;
    if (c.mate != null) txt = `强制杀王 mate${c.mate < 0 ? "-" : "+"}${Math.abs(c.mate)}`;
    else txt = `白方 +${(c.evalCp / 100).toFixed(2)}`;
    el.textContent = "评估：" + txt + "（深度 " + c.depth + "）";
    // 评估条（相对白方）
    const pct = c.mate != null ? (c.mate > 0 ? 100 : 0) : Math.min(100, Math.max(0, 50 + (c.evalCp / 100) * 5));
    document.getElementById("evalfill").style.height = pct + "%";
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
  function newGame() { game.reset(); board.position("start"); lastCandidates = []; updateStatus(); }
  function undo() { game.undo(); board.position(game.fen()); updateStatus(); }
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
  document.getElementById("movetime").addEventListener("input", e => {
    document.getElementById("mtlbl").textContent = e.target.value;
  });

  connect();
  initBoard();
  window.engineThink = engineThink;
  window.newGame = newGame;
  window.undo = undo;
  window.flipBoard = flipBoard;
  window.__board = board;   // 调试/测试用
  window.__game = game;
  window.onSquareClick = onSquareClick;
  window.selectedSq = () => selectedSq;
})();
