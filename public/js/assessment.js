/* =============================================================================
   棋力评估：账号绑定的人机测评模式
   ============================================================================= */
(function () {
  "use strict";

  const game = new Chess();
  let board = null;
  let ws = null, wsReady = false, msgId = 0, pending = new Map();
  const sendQueue = [];
  let active = null;
  let userColor = "white";
  let selectedSq = null;
  let legalTargets = [];
  let thinking = false;
  let finished = false;
  const userLosses = [];
  let mistakes = 0;
  let blunders = 0;
  let gen = 0;   // 测评代次：重新开始/重开对局即自增，用于丢弃迟到的引擎应手与结算结果
  let thinkingGen = -1;   // 当前有应手在途的代次；同代次重复触发直接忽略（防连点重开时并发应手互撞）

  const PIECE_CP = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

  const $ = (id) => document.getElementById(id);
  function setStatus(txt, alert) {
    $("status").textContent = txt;
    $("status").classList.toggle("alert", !!alert);
  }
  function setThinking(on) {
    thinking = !!on;
    $("thinking").classList.toggle("on", thinking);
  }
  function api(path, opts) {
    return fetch(path, Object.assign({
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    }, opts || {})).then(async r => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "请求失败");
      return d;
    });
  }
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}`);
    ws.onopen = () => { wsReady = true; sendQueue.splice(0).forEach(fn => fn()); };
    ws.onclose = () => {
      wsReady = false;
      for (const [, p] of pending) p.rej(new Error("连接中断"));
      pending.clear();
      setTimeout(connect, 2000);
    };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.err || m.type === "error") p.rej(new Error(m.message || "引擎错误"));
      else p.res(m);
    };
  }
  function rpc(type, payload) {
    return new Promise((res, rej) => {
      const id = "a" + (++msgId);
      pending.set(id, { res, rej });
      const send = () => ws.send(JSON.stringify(Object.assign({ type, id }, payload)));
      if (wsReady) send(); else sendQueue.push(send);
    });
  }

  function materialCp() {
    let cp = 0;
    const b = game.board();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const pc = b[r][c];
      if (!pc) continue;
      cp += (pc.color === "w" ? 1 : -1) * (PIECE_CP[pc.type] || 0);
    }
    return cp;
  }
  function userAdvantage() {
    const sign = userColor === "white" ? 1 : -1;
    return sign * materialCp();
  }
  function trackUserMove(beforeAdv, afterAdv) {
    const loss = Math.max(0, beforeAdv - afterAdv);
    userLosses.push(loss);
    if (loss >= 300) blunders += 1;
    else if (loss >= 120) mistakes += 1;
  }
  function metrics() {
    const avg = userLosses.length ? userLosses.reduce((a, b) => a + b, 0) / userLosses.length : 0;
    const accuracy = Math.max(0, Math.min(100, Math.round(100 - avg / 6 - blunders * 6 - mistakes * 2)));
    return { acpl: Math.round(avg), accuracy, mistakes, blunders };
  }

  function updateProfile(progress) {
    if (!progress) return;
    $("rating-now").textContent = progress.rating;
    $("rating-best").textContent = progress.bestRating;
    $("games-now").textContent = progress.games;
    $("streak-now").textContent = progress.currentStreak;
  }
  async function loadProfile() {
    try {
      const d = await api("/api/chess-rating/me");
      if (!d.authenticated || !d.progress) {
        $("login-state").textContent = d.mustChange ? "账号需要先修改密码。" : "未登录：请先进入管理后台登录账号。";
        $("start-btn").disabled = true;
        setStatus(d.mustChange ? "请先修改密码后再开始测评。" : "未登录账号，不能记录棋力。", true);
        return;
      }
      updateProfile(d.progress);
      $("login-state").textContent = "账号已绑定，测评结果会跨设备同步。";
      $("start-btn").disabled = false;
    } catch (e) {
      $("login-state").textContent = "未登录：请先进入管理后台登录账号。";
      $("start-btn").disabled = true;
      setStatus("未登录账号，不能记录棋力。", true);
    }
  }

  function clearMarks() {
    document.querySelectorAll(".star-hl").forEach(el => el.remove());
  }
  function squareEl(sq) { return document.querySelector(`.board-b72b1 .square-${sq}`); }
  function render() {
    board.position(game.fen(), false);
    clearMarks();
    if (!selectedSq) return;
    const sel = squareEl(selectedSq);
    if (sel) {
      const o = document.createElement("div");
      o.className = "star-hl sel";
      sel.appendChild(o);
    }
    legalTargets.forEach(sq => {
      const el = squareEl(sq);
      if (!el) return;
      const o = document.createElement("div");
      o.className = "star-hl dot";
      el.appendChild(o);
    });
  }
  function clearSelection() {
    selectedSq = null;
    legalTargets = [];
  }
  function updateMoveList() {
    const tb = document.querySelector("#movelist tbody");
    const h = game.history();
    tb.innerHTML = h.length
      ? Array.from({ length: Math.ceil(h.length / 2) }, (_, i) =>
          `<tr><td class="num">${i + 1}.</td><td class="mv">${h[2 * i] || ""}</td><td class="mv">${h[2 * i + 1] || ""}</td></tr>`
        ).join("")
      : "";
    const box = tb.closest(".moves");
    if (box) box.scrollTop = box.scrollHeight;
  }
  function turnIsUser() {
    return active && !finished && ((game.turn() === "w") === (userColor === "white"));
  }
  function describeTurn() {
    if (!active) return "请开始测评。";
    if (game.in_checkmate()) return "将死，对局结束。";
    if (game.in_draw()) return "和棋，对局结束。";
    return turnIsUser() ? "轮到你走棋。" : "轮到 Stockfish。";
  }
  function updateStatus() {
    updateMoveList();
    setStatus(describeTurn(), game.in_check() || game.game_over());
  }

  function resultForUser(forcedLoss) {
    if (forcedLoss) return "loss";
    if (game.in_draw()) return "draw";
    if (!game.in_checkmate()) return null;
    const loser = game.turn() === "w" ? "white" : "black";
    return loser === userColor ? "loss" : "win";
  }
  async function finishGame(forcedLoss) {
    if (!active || finished) return;
    const result = resultForUser(forcedLoss);
    if (!result) return;
    finished = true;
    setThinking(false);
    $("resign-btn").disabled = true;
    const m = metrics();
    const myGen = gen;
    try {
      const d = await api("/api/chess-rating/game/finish", {
        method: "POST",
        body: JSON.stringify({ gameId: active.gameId, result, moves: game.history().length, metrics: m }),
      });
      if (myGen !== gen) return;   // 已重开：丢弃旧局结算结果，避免污染新局报告
      updateProfile(d.progress);
      showReport(d.record);
      unlockSettings();
      setStatus("测评已结算。", false);
    } catch (e) {
      if (myGen !== gen) return;
      setStatus("结算失败：" + e.message, true);
    }
  }
  function showReport(rec) {
    const resultText = rec.result === "win" ? "胜利" : (rec.result === "draw" ? "和棋" : "失败");
    const sign = rec.delta > 0 ? "+" : "";
    const advice = rec.blunders >= 2 ? "本局明显失误偏多，优先减少送子和漏吃。"
      : rec.acpl <= 80 ? "本局发挥稳定，可以尝试更高难度档。"
      : "本局中段波动较大，建议复盘关键交换。";
    $("report").innerHTML = `<h2>本局报告</h2>
      <div class="report-line"><span>结果</span><b>${resultText}</b></div>
      <div class="report-line"><span>棋力变化</span><b>${sign}${rec.delta}</b></div>
      <div class="report-line"><span>当前棋力</span><b>${rec.after}</b></div>
      <div class="report-line"><span>准确率</span><b>${rec.accuracy}%</b></div>
      <div class="report-line"><span>ACPL</span><b>${rec.acpl}</b></div>
      <div class="report-line"><span>明显失误</span><b>${rec.blunders}</b></div>
      <div class="report-line"><span>建议</span><b>${advice}</b></div>`;
    $("report").classList.add("show");
  }

  async function engineMove() {
    if (!active || finished || game.game_over()) { await finishGame(false); return; }
    if (turnIsUser()) { updateStatus(); return; }
    if (thinkingGen === gen) return;   // 本代次已有应手在途，忽略重复触发
    thinkingGen = gen;
    const myGen = gen;
    setThinking(true);
    setStatus("Stockfish 思考中...");
    try {
      const r = await rpc("chess", {
        engine: "stockfish",
        fen: game.fen(),
        elo: active.engineElo,
        movetime: active.movetime,
        multipv: 1,
      });
      if (myGen !== gen) return;   // 已重开：迟到的应手不再落到新棋盘
      const uci = r.bestmove;
      if (!uci || uci === "(none)") throw new Error("引擎没有返回走法");
      const mv = game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: "q" });
      if (!mv) throw new Error("引擎返回非法走法");
      render();
      updateStatus();
      if (game.game_over()) await finishGame(false);
    } catch (e) {
      if (myGen !== gen) return;
      setStatus("引擎应手失败：" + e.message, true);
    } finally {
      // 仅当在途代次仍是我时才收尾；旧代次不干扰新局的思考指示
      if (thinkingGen === myGen) { thinkingGen = -1; setThinking(false); }
    }
  }
  function userMove(from, to) {
    if (!turnIsUser() || thinking) return false;
    const before = userAdvantage();
    const mv = game.move({ from, to, promotion: "q" });
    if (!mv) return false;
    trackUserMove(before, userAdvantage());
    clearSelection();
    render();
    updateStatus();
    if (game.game_over()) finishGame(false);
    else setTimeout(engineMove, 180);
    return true;
  }

  function onSquareClick(square) {
    if (!turnIsUser() || thinking) return;
    const piece = game.get(square);
    if (selectedSq) {
      if (square === selectedSq) {
        clearSelection();
        render();
        return;
      }
      if (legalTargets.includes(square)) {
        userMove(selectedSq, square);
        return;
      }
    }
    if (piece && piece.color === game.turn()) {
      selectedSq = square;
      legalTargets = game.moves({ square, verbose: true }).map(m => m.to);
    } else {
      clearSelection();
    }
    render();
  }
  function onDragStart(source, piece) {
    if (!turnIsUser() || thinking || !piece) return false;
    const isWhitePiece = piece[0] === "w";
    return isWhitePiece === (userColor === "white");
  }
  function onDrop(source, target) {
    if (!userMove(source, target)) return "snapback";
  }
  function onSnapEnd() { render(); }

  let press = null;
  function boardPointer(e) {
    const sqEl = e.target && e.target.closest ? e.target.closest(".square-55d63") : null;
    const sq = sqEl ? ((sqEl.className.match(/square-([a-h][1-8])/) || [])[1] || null) : null;
    if (e.type === "pointerdown") press = { sq, x: e.clientX, y: e.clientY, moved: false };
    else if (e.type === "pointermove" && press) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.moved = true;
    } else if (e.type === "pointerup" && press) {
      if (!press.moved && press.sq) onSquareClick(press.sq);
      press = null;
    }
  }

  async function startAssessment() {
    gen++;   // 作废上一局所有在途请求（引擎应手/结算）
    const myGen = gen;
    $("report").classList.remove("show");
    setStatus("正在创建测评对局...");
    try {
      const d = await api("/api/chess-rating/game/start", {
        method: "POST",
        body: JSON.stringify({ tier: $("tier").value, color: $("color").value }),
      });
      if (myGen !== gen) return;   // 连点重开：只采用最后一次创建的测评
      active = d;
      userColor = d.color;
      finished = false;
      userLosses.length = 0;
      mistakes = 0;
      blunders = 0;
      clearSelection();
      game.reset();
      board.orientation(userColor);
      render();
      updateProfile(d.progress);
      $("tier").disabled = true;
      $("color").disabled = true;
      $("start-btn").textContent = "重新开始测评";
      $("resign-btn").disabled = false;
      setStatus(`测评开始：你执${userColor === "white" ? "白" : "黑"}，对手 Stockfish ${d.engineElo}。`);
      if (!turnIsUser()) setTimeout(engineMove, 250);
    } catch (e) {
      setStatus("开始失败：" + e.message, true);
    }
  }
  function unlockSettings() {
    $("tier").disabled = false;
    $("color").disabled = false;
  }
  function initBoard() {
    board = Chessboard("board", {
      draggable: true,
      position: "start",
      onDragStart, onDrop, onSnapEnd,
      pieceTheme: "img/chesspieces/wikipedia/{piece}.png",
    });
    $("board").addEventListener("pointerdown", boardPointer);
    document.addEventListener("pointermove", boardPointer);
    document.addEventListener("pointerup", boardPointer);
    updateStatus();
  }

  $("start-btn").addEventListener("click", () => {
    if (active && !finished && !confirm("当前测评尚未结算，重新开始会放弃这盘棋。继续？")) return;
    unlockSettings();
    startAssessment();
  });
  $("resign-btn").addEventListener("click", () => finishGame(true));
  $("flip-btn").addEventListener("click", () => { if (board) { board.flip(); render(); } });

  connect();
  loadProfile();
  if (document.readyState === "complete") initBoard();
  else window.addEventListener("load", initBoard, { once: true });

  window.__assessmentGame = game;
})();
