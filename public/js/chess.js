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
      setStatus(`[${engineName}] ${sideName}行棋 · AI 落子：${mv}`, false);
      if (r.bestmove) {
        // 高亮推荐走法后 AI 自动走出该步
        highlightBest(cands[0] && cands[0].pv);
        const done = game.move({ from: r.bestmove.slice(0, 2), to: r.bestmove.slice(2, 4), promotion: "q" });
        if (done) {
          board.position(game.fen());
          updateStatus();
          const nextSide = game.turn() === "w" ? "白方" : "黑方";
          setStatus(`[${engineName}] AI 落子：${mv} · 轮到 ${nextSide}`, false);
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
    if (!c) { if (el) el.textContent = "评估：—"; return; }
    let txt, wpct;
    if (c.mate != null) {
      txt = `强制杀王 mate${c.mate < 0 ? "-" : "+"}${Math.abs(c.mate)}`;
      wpct = c.mate > 0 ? 100 : 0;   // mate 正 = 白方杀王
    } else {
      txt = `白方 +${(c.evalCp / 100).toFixed(2)}`;
      wpct = 1 / (1 + Math.pow(10, -c.evalCp / 400)) * 100;  // logistic 换算白方胜率
    }
    if (el) el.textContent = "评估：" + txt + "（深度 " + c.depth + "）";
    // 左侧竖条（相对白方）
    const pct = c.mate != null ? wpct : Math.min(100, Math.max(0, 50 + (c.evalCp / 100) * 5));
    document.getElementById("evalfill").style.height = pct + "%";
    // 右侧胜率条（白左 / 黑右）
    const wf = document.getElementById("wrfill");
    if (wf) wf.style.width = wpct.toFixed(1) + "%";
    const wl = document.getElementById("wrlabel");
    if (wl) wl.textContent = `白 ${wpct.toFixed(1)}% · 黑 ${(100 - wpct).toFixed(1)}% · ${c.mate != null ? "mate" : (c.evalCp / 100 >= 0 ? "+" : "") + (c.evalCp / 100).toFixed(2)}`;
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
  document.getElementById("engine").addEventListener("change", e => {
    // Reckless 不支持 Elo 分级：切换时提示
    const levelSel = document.getElementById("level");
    levelSel.disabled = e.target.value === "reckless";
    document.getElementById("level").parentElement.querySelector("label").textContent =
      e.target.value === "reckless" ? "难度（Reckless 自带棋力，忽略此设置）" : "难度（引擎棋力）";
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

let reviewData = null;
  let reviewBoard = null;

  function winrate(cp) { return 1 / (1 + Math.pow(10, -cp / 400)); }

  const CLASSES = {
    best:       { label: "最佳",     color: "#3ac94e", txt: "这是当前局面下的最佳走法，完全保持了优势。" },
    excellent:  { label: "很好",     color: "#9bc44b", txt: "很好的走法，几乎与最佳相当。" },
    good:       { label: "好",       color: "#e3c91a", txt: "不错的走法，略有改进空间。" },
    inaccuracy: { label: "不精确",   color: "#e88a1a", txt: "不够精确，错过了更优的选择。" },
    mistake:    { label: "失误",     color: "#e8611a", txt: "这是一步失误，明显损失了优势。" },
    blunder:    { label: "严重错误", color: "#e02c1a", txt: "严重错误！这步棋让局面急剧恶化。" },
  };
  function classify(loss) {
    if (loss < 0.02) return CLASSES.best;
    if (loss < 0.06) return CLASSES.excellent;
    if (loss < 0.12) return CLASSES.good;
    if (loss < 0.22) return CLASSES.inaccuracy;
    if (loss < 0.45) return CLASSES.mistake;
    return CLASSES.blunder;
  }

  function replayFens() {
    const fens = [];
    const g = new Chess();
    fens.push(g.fen());
    // 用当前对局的走法重放，生成每个局面的 FEN
    for (const mv of game.history({ verbose: true })) {
      g.move({ from: mv.from, to: mv.to, promotion: mv.promotion || "q" });
      fens.push(g.fen());
    }
    return fens;
  }

  window.reviewGame = async function () {
    const hist = game.history({ verbose: true });
    if (!hist.length) { setStatus("对局为空，先走几步再复盘", true); return; }
    setStatus("复盘分析中…（逐手调用 Stockfish）", false);
    setThinking(true);
    try {
      const fens = replayFens();
      const analysis = [];
      for (let i = 1; i < fens.length; i++) {
        const r = await rpc("chess", { engine: "stockfish", fen: fens[i], movetime: 250, multipv: 1 });
        const c = (r.candidates && r.candidates[0]) || null;
        analysis.push({
          evalCp: c && c.evalCp != null ? c.evalCp : null,
          mate: c && c.mate != null ? c.mate : null,
          best: (c && c.pv && c.pv[0]) || null,
        });
      }
      const moves = [];
      for (let i = 0; i < hist.length; i++) {
        const p = i % 2 === 0 ? "w" : "b";
        const before = i === 0 ? 0.5
          : (analysis[i - 1].mate != null
              ? (analysis[i - 1].mate > 0 === (p === "w") ? 1 : 0)
              : winrate(p === "w" ? analysis[i - 1].evalCp : -analysis[i - 1].evalCp));
        const a = analysis[i];
        const after = a.mate != null
          ? (a.mate > 0 === (p === "w") ? 1 : 0)
          : (a.evalCp == null ? before : winrate(p === "w" ? a.evalCp : -a.evalCp));
        const loss = Math.max(0, before - after);
        const cls = classify(loss);
        moves.push({
          n: i + 1, san: hist[i].san, p, before, after, loss, cls,
          best: i >= 1 ? analysis[i - 1].best : null,
        });
      }
      reviewData = { fens, moves, cur: moves.length };
      openReview();
    } catch (e) {
      setStatus("复盘失败: " + e.message, true);
    } finally {
      setThinking(false);
    }
  };

  function openReview() {
    document.getElementById("review-modal").classList.remove("hidden");
    reviewBoard = Chessboard("review-board", {
      draggable: false,
      position: reviewData.fens[reviewData.cur],
      pieceTheme: "img/chesspieces/wikipedia/{piece}.png",
    });
    renderReview();
  }

  window.closeReview = function () {
    document.getElementById("review-modal").classList.add("hidden");
    if (reviewBoard && reviewBoard.destroy) reviewBoard.destroy();
    reviewBoard = null;
    setStatus("复盘已关闭");
  };

  window.reviewNav = function (d) {
    reviewData.cur = Math.max(0, Math.min(reviewData.moves.length, reviewData.cur + d));
    if (reviewBoard) reviewBoard.position(reviewData.fens[reviewData.cur]);
    renderReview();
  };

  function renderReview() {
    // 总评统计
    const cnt = {};
    reviewData.moves.forEach(m => { cnt[m.cls.label] = (cnt[m.cls.label] || 0) + 1; });
    const sum = document.getElementById("review-summary");
    sum.innerHTML = Object.entries(CLASSES)
      .map(([id, c]) => `<span style="font-family:ui-monospace,Menlo,monospace;font-size:11px;border:1px solid ${c.color}66;color:${c.color};padding:4px 10px">${c.label} ${cnt[c.label] || 0}</span>`)
      .join("");
    drawCurve();
    document.getElementById("review-pos").textContent = `${reviewData.cur} / ${reviewData.moves.length}`;
    renderDetail();
    renderMoveList();
  }

  function drawCurve() {
    const svg = document.getElementById("review-curve");
    const W = 600, H = 120;
    // 白方胜率点：起点 0.5，每步后（换算成白方）
    const pts = [0.5];
    reviewData.moves.forEach(m => {
      pts.push(m.p === "w" ? m.after : 1 - m.after);
    });
    let d = "";
    pts.forEach((v, i) => {
      const x = (i / Math.max(1, pts.length - 1)) * W;
      const y = H - v * H;
      d += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
    });
    svg.innerHTML = `
      <line x1="0" y1="${H/2}" x2="${W}" y2="${H/2}" stroke="#eff2e824" stroke-width="1" stroke-dasharray="4,4"></line>
      <path d="${d}" fill="none" stroke="#d7ff3f" stroke-width="2"></path>
      <line x1="${(reviewData.cur / Math.max(1, pts.length - 1)) * W}" y1="0" x2="${(reviewData.cur / Math.max(1, pts.length - 1)) * W}" y2="${H}" stroke="#2ed3ff" stroke-width="1"></line>`;
  }

  function renderDetail() {
    const el = document.getElementById("review-detail");
    const c = reviewData.cur;
    if (c === 0) { el.innerHTML = `<div style="color:var(--muted)">开局局面 · 使用 ←/→ 浏览每一步的点评</div>`; return; }
    const m = reviewData.moves[c - 1];
    const sideName = m.p === "w" ? "白方" : "黑方";
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <span style="font-family:ui-monospace,Menlo,monospace;font-size:10px;border:1px solid ${m.cls.color}66;color:${m.cls.color};padding:3px 10px">${m.cls.label}</span>
        <span style="font-size:15px;font-weight:600">${m.n}. ${m.san}</span>
        <span style="font-size:12px;color:var(--muted)">${sideName}</span>
      </div>
      <div style="font-size:12.5px;color:var(--muted);line-height:1.8">
        ${m.p === "w" ? "白方" : "黑方"}胜率 <b style="color:var(--paper)">${(m.before * 100).toFixed(1)}%</b> → <b style="color:var(--paper)">${(m.after * 100).toFixed(1)}%</b>
        （损失 <b style="color:${m.cls.color}">${(m.loss * 100).toFixed(1)}%</b>）<br>
        ${m.best ? `更优着法：<b style="color:var(--signal)">${m.best}</b>` : ""}
      </div>
      <div style="margin-top:10px;font-size:13px;color:var(--paper)">${m.cls.txt}</div>`;
  }

  function renderMoveList() {
    const el = document.getElementById("review-movelist");
    el.innerHTML = reviewData.moves.map((m, i) => `
      <div onclick="reviewNav(${i + 1 - reviewData.cur})"
        style="cursor:pointer;display:flex;gap:8px;align-items:center;padding:6px 10px;border:1px solid ${reviewData.cur === i + 1 ? "var(--signal)" : "var(--line)"};background:${reviewData.cur === i + 1 ? "#d7ff3f14" : "var(--surface)"}"
        title="${m.cls.label}">
        <span style="font-family:monospace;font-size:10px;color:var(--faint)">${m.n}.</span>
        <span style="font-family:monospace;font-size:13px">${m.san}</span>
        <span style="flex:1"></span>
        <span style="width:8px;height:8px;border-radius:50%;background:${m.cls.color}"></span>
      </div>`).join("");
  }

  window.selectedSq = () => selectedSq;
})();


