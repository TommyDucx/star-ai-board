/* =============================================================================
   围棋前端：SVG 棋盘 + 落子 + KataGo 分析推荐下一步
   ============================================================================= */
(function () {
  "use strict";
  const LETTERS = "ABCDEFGHJKLMNOPQRST"; // GTP 列（不含 I）
  let N = 19;            // 棋盘大小
  let board = [];        // N x N, 0=空 1=黑 2=白
  let moveLog = [];      // [{r,c,color}]
  let flipped = false;
  let candidates = [];   // KataGo moveInfos
  let ws = null, wsReady = false, msgId = 0, pending = new Map();

  const svg = document.getElementById("board");
  const CELL = 27, PAD = 26;

  function gtp(r, c) { return LETTERS[c] + (N - r); }
  function fromGtp(s) {
    const c = LETTERS.indexOf(s[0]);
    const r = N - parseInt(s.slice(1), 10);
    return { r, c };
  }
  function colorChar(v) { return v === 1 ? "B" : v === 2 ? "W" : ""; }

  /* ---------------- WS ---------------- */
  function connect() {
    try {
      // 公网是 HTTPS：必须用 wss://，ws:// 会被浏览器拦截并抛异常
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}`);
      ws.onopen = () => { wsReady = true; };
      ws.onclose = () => { wsReady = false; setTimeout(connect, 2000); };
      ws.onmessage = e => {
        const m = JSON.parse(e.data);
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); m.err ? p.rej(new Error(m.message)) : p.res(m); }
      };
    } catch (e) {
      // ws 失败不影响棋盘渲染，稍后重试
      setTimeout(connect, 2000);
    }
  }
  function rpc(type, payload) {
    return new Promise((res, rej) => {
      const id = "c" + (++msgId);
      pending.set(id, { res, rej });
      const send = () => ws.send(JSON.stringify({ type, id, ...payload }));
      if (wsReady) send(); else ws.onopen = () => { wsReady = true; send(); };
    });
  }

  /* ---------------- 棋盘渲染 ---------------- */
  function render() {
    const size = CELL * (N - 1) + PAD * 2;
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    let html = `<rect width="${size}" height="${size}" fill="#dcb35c"></rect>
      <rect x="${PAD - 4}" y="${PAD - 4}" width="${size - PAD * 2 + 8}" height="${size - PAD * 2 + 8}" fill="none" stroke="#a5803a" stroke-width="1"></rect>`;
    // 网格
    for (let i = 0; i < N; i++) {
      const p = PAD + i * CELL;
      html += `<line x1="${PAD}" y1="${p}" x2="${size - PAD}" y2="${p}" stroke="#5d4320" stroke-width="1"></line>`;
      html += `<line x1="${p}" y1="${PAD}" x2="${p}" y2="${size - PAD}" stroke="#5d4320" stroke-width="1"></line>`;
    }
    // 星位
    const stars = N === 19 ? [[3, 3], [3, 9], [3, 15], [9, 3], [9, 9], [9, 15], [15, 3], [15, 9], [15, 15]]
      : N === 13 ? [[3, 3], [3, 9], [9, 3], [9, 9], [6, 6]]
      : [[2, 2], [2, 6], [6, 2], [6, 6]];
    stars.forEach(([r, c]) => {
      const x = PAD + c * CELL, y = PAD + r * CELL;
      html += `<circle cx="${x}" cy="${y}" r="3.5" fill="#5d4320"></circle>`;
    });
    // 坐标
    for (let i = 0; i < N; i++) {
      html += `<text x="${PAD - 10}" y="${PAD + i * CELL + 3.5}" font-size="10" fill="#6b4c26" text-anchor="middle">${N - i}</text>`;
      html += `<text x="${PAD + i * CELL}" y="${size - PAD + 18}" font-size="10" fill="#6b4c26" text-anchor="middle">${LETTERS[i]}</text>`;
    }
    // 落子
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      if (board[r][c]) {
        const x = PAD + c * CELL, y = PAD + r * CELL, col = board[r][c] === 1 ? "#111" : "#f5f5f5";
        html += `<circle cx="${x}" cy="${y}" r="${CELL * 0.46}" fill="${col}" stroke="#00000055" stroke-width="1">
          <title>${gtp(r, c)}</title></circle>`;
      }
    }
    // 推荐点（数字 + 胜率）
    candidates.forEach((cd, i) => {
      if (i >= 5) return;
      const { r, c } = fromGtp(cd.move);
      const x = PAD + c * CELL, y = PAD + r * CELL;
      html += `<circle cx="${x}" cy="${y}" r="12" fill="#d7ff3f" fill-opacity="0.92"></circle>`;
      html += `<text x="${x}" y="${y + 4}" font-size="12" font-weight="700" fill="#080a09" text-anchor="middle">${i + 1}</text>`;
      html += `<title>${cd.move} 胜率${(cd.winrate * 100).toFixed(1)}% 目差${cd.scoreLead >= 0 ? "+" : ""}${cd.scoreLead.toFixed(1)}</title>`;
    });
    // 最后一手标记
    if (moveLog.length) {
      const last = moveLog[moveLog.length - 1];
      const x = PAD + last.c * CELL, y = PAD + last.r * CELL;
      html += `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="${last.color === 1 ? "#d7ff3f" : "#ff5449"}" stroke-width="2"></circle>`;
    }
    // 点击层
    html += `<rect width="${size}" height="${size}" fill="transparent"></rect>`;
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const x = PAD + c * CELL, y = PAD + r * CELL;
      html += `<circle cx="${x}" cy="${y}" r="${CELL * 0.55}" fill="transparent" data-r="${r}" data-c="${c}" style="cursor:pointer"></circle>`;
    }
    svg.innerHTML = html;
    svg.querySelectorAll("[data-r]").forEach(el => {
      el.addEventListener("click", () => place(+el.dataset.r, +el.dataset.c));
    });
  }

  /* ---------------- 落子 ---------------- */
  function place(r, c) {
    if (board[r][c]) return;
    const color = moveLog.length % 2 === 0 ? 1 : 2; // 黑先
    board[r][c] = color;
    moveLog.push({ r, c, color });
    render();
    aiAnalyze(true); // 落子后自动分析推荐下一步
  }
  function undo() {
    const last = moveLog.pop();
    if (last) { board[last.r][last.c] = 0; }
    candidates = [];
    render();
    setStatus("已悔棋");
  }
  function clearBoard() {
    board = Array.from({ length: N }, () => Array(N).fill(0));
    moveLog = [];
    candidates = [];
    render();
    setStatus("棋盘已清空");
  }
  function flipBoard() {
    // 简单翻转：交换所有棋子颜色
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++)
      if (board[r][c]) board[r][c] = board[r][c] === 1 ? 2 : 1;
    render();
  }

  /* ---------------- KataGo 分析 ---------------- */
  async function aiAnalyze(auto) {
    const stones = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++)
      if (board[r][c]) stones.push([colorChar(board[r][c]), gtp(r, c)]);
    const side = moveLog.length % 2 === 0 ? "B" : "W";
    const visits = +document.getElementById("visits").value;
    setThinking(true);
    setStatus("KataGo 分析中…");
    try {
      const m = await rpc("go", { stones, side, boardSize: N, maxVisits: visits });
      candidates = (m.moveInfos || []).map(info => ({
        move: info.move, winrate: info.winrate, scoreLead: info.scoreLead,
        visits: info.visits, pv: (info.pv || []).join(" "),
      }));
      render();
      renderWinbar(side, m);
      renderCands();
      if (!auto) setStatus("分析完成");
    } catch (e) {
      setStatus("分析失败: " + e.message, true);
    } finally {
      setThinking(false);
    }
  }

  function renderWinbar(side, m) {
    const wr = m.rootInfo && m.rootInfo.winrate;
    const lead = m.rootInfo && m.rootInfo.scoreLead;
    if (wr != null) {
      const pct = side === "B" ? wr * 100 : (1 - wr) * 100;
      document.getElementById("winw").style.width = pct + "%";
      document.getElementById("winb").style.width = (100 - pct) + "%";
      const label = document.getElementById("winlabel");
      label.textContent = `${side === "B" ? "黑" : "白"}胜率 ${(Math.max(wr, 1 - wr) * 100).toFixed(1)}% · 目差 ${lead >= 0 ? "+" : ""}${lead.toFixed(1)}`;
    }
    // 右侧胜率条（黑左 / 白右）——KataGo winrate 为当前行棋方视角，换算成黑方
    const blackWr = side === "B" ? (wr || 0.5) : 1 - (wr || 0.5);
    const g = document.getElementById("gwrfill");
    if (g) g.style.width = (blackWr * 100).toFixed(1) + "%";
    const gl = document.getElementById("gwrlabel");
    if (gl) gl.textContent = `黑 ${(blackWr * 100).toFixed(1)}% · 白 ${((1 - blackWr) * 100).toFixed(1)}% · 目差 ${lead >= 0 ? "+" : ""}${(lead || 0).toFixed(1)}`;
  }

  function renderCands() {
    const el = document.getElementById("cands");
    el.innerHTML = candidates.slice(0, 5).map((cd, i) => `
      <div class="cand">
        <span class="n">${i + 1}</span>
        <span style="font-size:14px">${cd.move}</span>
        <span class="pv">${cd.pv}</span>
        <span class="wr">${(cd.winrate * 100).toFixed(1)}% · ${cd.scoreLead >= 0 ? "+" : ""}${cd.scoreLead.toFixed(1)}</span>
      </div>`).join("") || '<div style="color:#788179;font-size:12px">暂无推荐（先落几手）</div>';
  }

  function setStatus(txt, alert) {
    const el = document.getElementById("status");
    el.textContent = txt;
    el.classList.toggle("alert", !!alert);
  }
  function setThinking(on) {
    document.getElementById("thinking").classList.toggle("on", on);
  }

  /* ---------------- 初始化 ---------------- */
  document.getElementById("size").addEventListener("change", () => {
    N = +document.getElementById("size").value;
    clearBoard();
  });
  connect();
  board = Array.from({ length: N }, () => Array(N).fill(0));
  render();
  window.aiAnalyze = aiAnalyze;
  window.place = place;
  window.undo = undo;
  window.clearBoard = clearBoard;
  window.flipBoard = flipBoard;
})();
