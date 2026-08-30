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
  let gen = 0;           // 棋局代次：落子/悔棋/清盘/切尺寸时自增，作废迟到的分析结果（防污染新棋局）
  let analyzingGen = null;  // AI 代开局进行中的代次标记（防重复触发）
  let lastPlaced = null;    // 最近一手 {r,c}，渲染时叠加涟漪
  let ws = null, wsReady = false, msgId = 0, pending = new Map();
  const sendQueue = [];   // ws 未就绪时排队的请求（onopen 统一发送，重连不丢）

  const svg = document.getElementById("board");
  let CELL = 27, PAD = 26;   // 棋盘固定 538px（用户确认的最佳尺寸）

  function gtp(r, c) { return LETTERS[c] + (N - r); }
  function fromGtp(s) {
    const c = LETTERS.indexOf(s[0]);
    const r = N - parseInt(s.slice(1), 10);
    return { r, c };
  }
  function colorChar(v) { return v === 1 ? "B" : v === 2 ? "W" : ""; }

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ---------------- WS ---------------- */
  function connect() {
    try {
      // 公网是 HTTPS：必须用 wss://，ws:// 会被浏览器拦截并抛异常
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}`);
      ws.onopen = () => { wsReady = true; sendQueue.splice(0).forEach(fn => fn()); loadGoEngines(); };
      ws.onclose = () => {
        wsReady = false;
        for (const [, pr] of pending) pr.rej(new Error("连接中断"));
        pending.clear();
        setTimeout(connect, 2000);
      };
      ws.onmessage = e => {
        const m = JSON.parse(e.data);
        // 鉴权失败/强制改密：服务端拒绝引擎调用，统一跳登录页（登录后会被改密页引导）
        if (m && m.code === "AUTH_REQUIRED") {
          location.href = "/admin/login.html";
          return;
        }
        if (m && m.code === "MUST_CHANGE") {
          location.href = "/admin/login.html";
          return;
        }
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
      if (wsReady) send(); else sendQueue.push(send);
    });
  }

  /* ---------------- 引擎下拉 ---------------- */
  let goEngines = [];
  async function loadGoEngines() {
    try {
      const m = await rpc("goengines", {});
      goEngines = (m && m.engines) || [];
      const sel = document.getElementById("goengine");
      if (!sel) return;
      sel.innerHTML = goEngines.length
        ? goEngines.map(e => `<option value="${e.key}">${e.label}</option>`).join("")
        : `<option value="">未部署引擎</option>`;
      if (goEngines.length) sel.selectedIndex = 0;
    } catch (e) { /* ws 未就绪，稍后重试 */ }
  }

  /* ---------------- 棋盘渲染 ---------------- */
  function render() {
    const size = CELL * (N - 1) + PAD * 2;
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    let html = `<defs>
      <linearGradient id="wgd" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#e6bd6f"></stop><stop offset=".55" stop-color="#dcb35c"></stop><stop offset="1" stop-color="#c89a4c"></stop>
      </linearGradient>
      <pattern id="wgr" width="140" height="9" patternUnits="userSpaceOnUse">
        <path d="M0 3 Q35 0 70 3 T140 3" stroke="rgba(90,60,20,.10)" fill="none"></path>
        <path d="M0 7 Q35 10 70 7 T140 7" stroke="rgba(255,235,190,.10)" fill="none"></path>
      </pattern>
    </defs>
    <rect width="${size}" height="${size}" rx="6" fill="url(#wgd)"></rect>
    <rect width="${size}" height="${size}" rx="6" fill="url(#wgr)"></rect>
    <rect x="${PAD - 4}" y="${PAD - 4}" width="${size - PAD * 2 + 8}" height="${size - PAD * 2 + 8}" fill="none" stroke="#a5803a" stroke-width="1"></rect>
    <rect x="1.5" y="1.5" width="${size - 3}" height="${size - 3}" rx="5" fill="none" stroke="rgba(60,38,10,.4)" stroke-width="2"></rect>`;
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
        // 最近一手：信号绿涟漪扩散（SMIL，随 innerHTML 重建自然重播）
        if (lastPlaced && lastPlaced.r === r && lastPlaced.c === c) {
          html += `<circle cx="${x}" cy="${y}" r="${CELL * 0.46}" fill="none" stroke="#d7ff3f" opacity="0.85">
            <animate attributeName="r" from="${CELL * 0.5}" to="${CELL * 1.2}" dur="0.6s" fill="freeze"></animate>
            <animate attributeName="opacity" from="0.85" to="0" dur="0.6s" fill="freeze"></animate></circle>`;
        }
      }
    }
    // 推荐点（高亮 + 序号标注推荐程度：第1名带光晕，全部带粗体数字）
    candidates.forEach((cd, i) => {
      if (i >= 5) return;
      const { r, c } = fromGtp(cd.move);
      const x = PAD + c * CELL, y = PAD + r * CELL;
      const isTop = i === 0;
      // 第一名外发光圈（更醒目）
      if (isTop) {
        html += `<circle cx="${x}" cy="${y}" r="20" fill="none" stroke="#d7ff3f" stroke-opacity="0.45" stroke-width="3"></circle>`;
      }
      // 实心圆底（黄绿信号色，深色描边提高对比）
      html += `<circle cx="${x}" cy="${y}" r="${isTop ? 15 : 12}" fill="#d7ff3f" fill-opacity="0.95"
        stroke="${isTop ? "#e6c200" : "#9db314"}" stroke-width="${isTop ? 2.5 : 1.5}"></circle>`;
      // 序号（第1名更大）
      html += `<text x="${x}" y="${y + (isTop ? 6 : 4.5)}" font-size="${isTop ? 16 : 13}" font-weight="800"
        fill="#080a09" text-anchor="middle" style="pointer-events:none">${i + 1}</text>`;
      const wrTxt = cd.winrate != null ? (cd.winrate * 100).toFixed(1) + "%" : "--";
      const ldTxt = cd.scoreLead != null ? (cd.scoreLead >= 0 ? "+" : "") + cd.scoreLead.toFixed(1) : "--";
      html += `<title>第${i + 1}推荐 ${cd.move} · 胜率${wrTxt} · 目差${ldTxt}</title>`;
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
      el.addEventListener("click", () => {
        let r = +el.dataset.r, c = +el.dataset.c;
        // 视图翻转后，点击坐标要映射回真实棋盘坐标
        if (flipped) { r = N - 1 - r; c = N - 1 - c; }
        place(r, c);
      });
    });
  }

  /* ---------------- 落子 ---------------- */
  function place(r, c) {
    if (board[r][c]) return;
    const color = moveLog.length % 2 === 0 ? 1 : 2; // 黑先
    board[r][c] = color;
    moveLog.push({ r, c, color });
    lastPlaced = { r, c };
    gen++;          // 新局面：作废进行中的旧分析
    render();
    if (window.Motion && Motion.sfx) Motion.sfx.stone();   // 石子啪嗒
    aiAnalyze(true); // 落子后自动分析推荐下一步
  }
  function undo() {
    const last = moveLog.pop();
    if (last) { board[last.r][last.c] = 0; }
    const top = moveLog[moveLog.length - 1];
    lastPlaced = top ? { r: top.r, c: top.c } : null;   // 涟漪跟随新最后一手
    candidates = [];
    gen++;
    render();
    sweepBoard();
    setStatus("已悔棋");
  }
  function clearBoard() {
    board = Array.from({ length: N }, () => Array(N).fill(0));
    moveLog = [];
    candidates = [];
    lastPlaced = null;
    gen++;
    render();
    sweepBoard();
    setStatus("棋盘已清空");
  }
  function flipBoard() {
    // 视图翻转（rotate 180°），不交换棋子颜色——旧实现直接改 board 颜色会破坏
    // moveLog 与局面的对应关系（下一手颜色判断错乱），属于状态污染
    flipped = !flipped;
    svg.style.transform = flipped ? "rotate(180deg)" : "";
  }

  /* ---------------- 引擎分析 ---------------- */
  async function aiAnalyze(auto) {
    const stones = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++)
      if (board[r][c]) stones.push([colorChar(board[r][c]), gtp(r, c)]);
    const side = moveLog.length % 2 === 0 ? "B" : "W";
    const visits = +document.getElementById("visits").value;
    const engine = document.getElementById("goengine").value;
    const engLabel = document.getElementById("goengine").selectedOptions[0]?.textContent || engine;
    setThinking(true);
    setStatus(`${engLabel} 分析中…`);
    const myGen = gen;   // 记住发起时的棋局代次
    try {
      const m = await rpc("go", { engine, stones, side, boardSize: N, maxVisits: visits });
      if (myGen !== gen) return;   // 期间落子/悔棋/清盘/切尺寸：丢弃迟到结果，不渲染不写状态
      candidates = (m.moveInfos || []).map(info => ({
        move: info.move, winrate: info.winrate, scoreLead: info.scoreLead,
        visits: info.visits, pv: (info.pv || []).join(" "),
      }));
      render();
      renderWinbar(side, m);
      renderCands();
      // auto（落子后自动分析）也要解除「分析中…」状态，否则状态栏永远卡在分析中
      setStatus(auto ? `${engLabel} 分析完成 · 轮到 ${side === "B" ? "黑方" : "白方"}` : "分析完成");
    } catch (e) {
      setStatus("分析失败: " + e.message, true);
    } finally {
      setThinking(false);
    }
  }

  function renderWinbar(side, m) {
    const wr = m.rootInfo && m.rootInfo.winrate;
    const lead = m.rootInfo && m.rootInfo.scoreLead;
    const leadTxt = lead != null ? (lead >= 0 ? "+" : "") + lead.toFixed(1) : "--";
    if (wr != null) {
      const pct = side === "B" ? wr * 100 : (1 - wr) * 100;
      document.getElementById("winw").style.width = pct + "%";
      document.getElementById("winb").style.width = (100 - pct) + "%";
      const label = document.getElementById("winlabel");
      label.textContent = `${side === "B" ? "黑" : "白"}胜率 ${(Math.max(wr, 1 - wr) * 100).toFixed(1)}% · 目差 ${leadTxt}`;
    }
    // 右侧胜率条（黑左 / 白右）——KataGo winrate 为当前行棋方视角，换算成黑方
    const blackWr = side === "B" ? (wr || 0.5) : 1 - (wr || 0.5);
    const g = document.getElementById("gwrfill");
    if (g) g.style.width = (blackWr * 100).toFixed(1) + "%";
    const gl = document.getElementById("gwrlabel");
    if (gl) gl.textContent = `黑 ${(blackWr * 100).toFixed(1)}% · 白 ${((1 - blackWr) * 100).toFixed(1)}% · 目差 ${leadTxt}`;
  }

  function renderCands() {
    const el = document.getElementById("cands");
    el.innerHTML = candidates.slice(0, 5).map((cd, i) => {
      const wrTxt = cd.winrate != null ? (cd.winrate * 100).toFixed(1) + "%" : "--";
      const ldTxt = cd.scoreLead != null ? (cd.scoreLead >= 0 ? "+" : "") + cd.scoreLead.toFixed(1) : "--";
      return `
      <div class="cand">
        <span class="n">${i + 1}</span>
        <span style="font-size:14px">${escHtml(cd.move)}</span>
        <span class="pv">${escHtml(cd.pv)}</span>
        <span class="wr">${wrTxt} · ${ldTxt}</span>
      </div>`;
    }).join("") || '<div style="color:#788179;font-size:12px">暂无推荐（先落几手）</div>';
  }

  function setStatus(txt, alert) {
    const el = document.getElementById("status");
    el.textContent = txt;
    el.classList.toggle("alert", !!alert);
  }
  function setThinking(on) {
    document.getElementById("thinking").classList.toggle("on", on);
    const card = document.querySelector(".board-card");
    if (card) card.classList.toggle("thinking-glow", !!on);
  }
  function sweepBoard() {
    const card = document.querySelector(".board-card");
    if (!card) return;
    card.querySelectorAll(".reset-sweep").forEach(e => e.remove());
    const d = document.createElement("div");
    d.className = "reset-sweep";
    d.style.borderRadius = "10px";
    card.appendChild(d);
    setTimeout(() => d.remove(), 600);
  }

  /* ---------------- 初始化 ---------------- */
  document.getElementById("size").addEventListener("change", () => {
    N = +document.getElementById("size").value;
    gen++;   // 尺寸变了，旧坐标全部失效
    clearBoard(); render();
  });
  // 我方执子选择：此前是未接线的死控件。现定义语义：
  //   执黑(默认)=现状；执白(后手)=空盘时由 AI 代黑开局一手，用户从白方应对开始
  document.getElementById("myside").addEventListener("change", async e => {
    const mine = e.target.value;
    document.getElementById("winlabel").textContent =
      mine === "W"
        ? "你执白 · 黑方第一手由 AI 开局 · 之后点击棋盘落子"
        : "当前执黑 · 点击棋盘落子 · 落子后自动分析推荐";
    if (mine !== "W" || moveLog.length || analyzingGen === gen) return;
    analyzingGen = gen;                       // 防连点重复开局
    try {
      setStatus("AI 代黑方开局…");
      await aiAnalyze(true);                  // 渲染黑方首选（gen 保护下若用户清盘则丢弃）
      const top = candidates[0];
      if (top && top.move && top.move !== "pass" && !moveLog.length) {
        const pos = fromGtp(top.move);
        if (pos.r >= 0 && pos.c >= 0 && pos.r < N && pos.c < N) place(pos.r, pos.c);
      }
    } finally { analyzingGen = null; }
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
