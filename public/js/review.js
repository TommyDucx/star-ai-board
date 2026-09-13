/* =============================================================================
   对局复盘（chess.com 完整规则）：
   - 逐手 Stockfish 分析（MultiPV=3），按「厘兵损失」判定 9 级走法
   - 关键节点（大漏/妙手）自动停下并点评；自动播放逐手推进
   - 白黑 Accuracy、优势曲线(cp)、开局/中局/残局分段、对局教练总结、统计看板
   ============================================================================= */
(function () {
  "use strict";

  let ws = null, wsReady = false, msgId = 0, pending = new Map();
  const sendQueue = [];   // ws 未就绪时排队的请求（onopen 统一发送，重连不丢）
  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}`);
    ws.onopen = () => { wsReady = true; sendQueue.splice(0).forEach(fn => fn()); };
    ws.onclose = () => {
      wsReady = false;
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
  }
  function rpc(type, payload, opts) {
    return new Promise((res, rej) => {
      const id = "c" + (++msgId);
      pending.set(id, { res, rej, silent: !!(opts && opts.silent) });
      const send = () => ws.send(JSON.stringify({ type, id, ...payload }));
      if (wsReady) send(); else sendQueue.push(send);
    });
  }

  /* ---- 走法等级（chess.com 规则，损失单位=厘兵 cp） ---- */
  const CLASSES = {
    best:       { label: "最优",   sym: "",   color: "#3ac94e", key: "best" },
    brilliant:  { label: "精妙",   sym: "!!", color: "#3ac94e", key: "brilliant" },
    excellent:  { label: "极佳",   sym: "",   color: "#6fbf4a", key: "excellent" },
    good:       { label: "合格",   sym: "",   color: "#b3c83f", key: "good" },
    book:       { label: "开局谱着",sym: "⌂", color: "#8a9288", key: "book" },
    inaccuracy: { label: "不精确", sym: "?!", color: "#e3c91a", key: "inaccuracy" },
    mistake:    { label: "失误",   sym: "?",  color: "#e88a1a", key: "mistake" },
    miss:       { label: "战术遗漏",sym: "⚠", color: "#e8611a", key: "miss" },
    blunder:    { label: "严重错误",sym: "??", color: "#e02c1a", key: "blunder" },
  };
  // 简易开局库（SAN 前缀序列）
  const BOOK = [
    ["e4","e5","Nf3","Nc6","Bb5"], ["e4","e5","Nf3","Nc6","Bc4"], ["e4","e5","Nf3","Nc6","Bb5","a6"],
    ["e4","c5"], ["e4","e6"], ["e4","c6"], ["e4","d5"], ["e4","e5","Nf3","Nc6","Bb5","a6","Ba4"],
    ["d4","d5","c4"], ["d4","Nf6","c4","g6"], ["d4","f5"], ["Nf3","d5","g3"], ["c4","e5"],
  ];
  function inBook(moves, upto) {
    return BOOK.some(line => upto <= line.length && line.slice(0, upto).every((s, i) => moves[i] && moves[i] === s));
  }
  // 判定等级：lossCp(厘兵), isBest, isTacticalHit(实际走了吃子/将军), jumpCp(评估涨幅)
  function grade(lossCp, isBest, actualUci, bestUci, flags, jumpCp) {
    if (isBest && jumpCp > 80) return CLASSES.brilliant;      // 妙手：最佳且局面大幅上涨
    if (lossCp <= 0 && isBest) return CLASSES.best;            // 与引擎 Top-1 一致
    if (lossCp <= 5) return CLASSES.excellent;                 // 极佳 ≤5cp
    if (lossCp <= 20) return CLASSES.good;                     // 合格 5-20cp
    if (lossCp <= 50) return CLASSES.inaccuracy;               // 不精确 20-50cp
    if (lossCp <= 150) {
      // 战术遗漏：错失吃子/将军/杀棋机会（引擎最佳是战术着而实际没走）
      if (flags.attack && !flags.actualTactical) return CLASSES.miss;
      return CLASSES.mistake;                                   // 失误 50-150cp
    }
    return CLASSES.blunder;                                     // 大漏 >150cp
  }

  /* ---- 数据 ---- */
  let moves = [];          // 详细走法
  let nodes = [];          // 每局面分析 {cp(行棋方视角), turn, bestUci, cands}
  let review = null;       // 每步判定
  let board = null, cur = 0, playing = false, playTimer = null;

  const $ = s => document.getElementById(s);

  function build() {
    const g = new Chess();
    const fens = [], turns = [];
    fens.push(g.fen()); turns.push(g.turn());
    let applied = 0;
    for (const m of moves) {
      if (!g.move({ from: m.from, to: m.to, promotion: m.promotion || "q" })) break;
      applied++;
      fens.push(g.fen()); turns.push(g.turn());
    }
    // applied = 实际被合法应用的手数；若小于 moves.length 说明数据里有非法着法
    return { fens, turns, applied };
  }

  function cpOf(c) { return c && c.evalCp != null ? c.evalCp : 0; }
  // server 返回的 evalCp 为「当前行棋方视角」：+ = 行棋方优势
  // 白方视角换算：白方cp = 局面轮到白 ? cp : -cp

  async function analyze() {
    const raw = localStorage.getItem("star_review_moves");
    if (!raw) { setStatus("没有可复盘的对局", true); return; }
    try { moves = JSON.parse(raw); } catch (e) { setStatus("数据损坏", true); return; }
    if (!moves.length) { setStatus("对局为空", true); return; }

    setStatus("分析中…");
    const { fens, turns, applied } = build();
    // 数据里可能混入非法着法（引擎/存储异常）：截断到实际合法应用的手数，
    // 保证后续 nodes[i+1] 与 moves[i] 一一对应，不越界
    const truncated = applied < moves.length;
    if (truncated) moves = moves.slice(0, applied);
    const start = Date.now();
    nodes = [];
    try {
      for (let i = 0; i < fens.length; i++) {
        // 进度反馈：长对局分析可达数十秒，让用户知道还要等多久
        setStatus(`分析中 ${i + 1}/${fens.length}…`);
        // 静默：匿名访客打开复盘不应跳转登录
        const r = await rpc("chess", { engine: "stockfish", fen: fens[i], movetime: 300, multipv: 3 }, { silent: true });
        const cands = (r.candidates || []).slice(0, 3);
        nodes.push({
          cp: cpOf(cands[0]),
          turn: turns[i],                                   // 该局面行棋方
          bestUci: (cands[0] && cands[0].pv && cands[0].pv[0]) || null,
          cands,
        });
      }
    } catch (e) {
      setStatus("复盘失败: " + e.message + "（请先登录账号）", true);
      return;
    }
    // 逐手判定（损失 = 走前行棋方优势 - 走后行棋方优势(转回)）
    review = [];
    try {
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        const before = nodes[i].cp;                 // 局面 i：轮到该步行棋方，cp 即其视角优势
        const after = -nodes[i + 1].cp;             // 局面 i+1：轮到对方，取负转为该步行棋方视角
        const lossCp = Math.max(0, before - after);
        const jumpCp = after - before;
        const actualUci = m.from + m.to + (m.promotion ? m.promotion : "");
        const bestUci = nodes[i].bestUci;
        const isBest = bestUci && actualUci.slice(0, 4) === bestUci.slice(0, 4);
        const flags = {
          attack: /c|t|q/i.test(m.flags || ""),
          actualTactical: !!m.captured || /[+#]$/.test(m.san || ""),
        };
        const book = inBook(moves.map(x => x.san), i + 1) && i < 15;
        let cls;
        if (book && lossCp <= 20) cls = CLASSES.book;
        else cls = grade(lossCp, isBest, actualUci, bestUci, flags, jumpCp);
        review.push({
          n: i + 1, san: m.san, p: m.color, color: m.color, piece: m.piece, captured: m.captured,
          before, after, lossCp, jumpCp, isBest, bestUci,
          actualUci, flags, cls, key: cls.key, book,
        });
      }
    } catch (e) {
      // 防御：分析节点与走法不匹配时（历史脏数据）不抛 TypeError，给出可恢复提示
      setStatus("复盘数据异常，已停止分析", true);
      return;
    }
    setStatus(`分析完成 · ${((Date.now() - start) / 1000).toFixed(1)}s` + (truncated ? "（部分非法着法已忽略）" : ""));
    window.__review = review;   // 调试
    window.__nodes = nodes;
    renderAll();
  }

  /* ---- 渲染 ---- */
  function renderAll() {
    // 白黑准确率
    accPerColor("w", $("acc-w"));
    accPerColor("b", $("acc-b"));
    // 分段
    const seg = segmentAcc();
    $("phases").textContent = `开局 ${seg.opening.toFixed(0)} · 中局 ${seg.mid.toFixed(0)} · 残局 ${seg.end.toFixed(0)}`;
    // 教练总结
    $("coach-text").textContent = coach();
    // 统计看板
    $("summary").innerHTML = renderBoard();
    // 棋盘
    board = Chessboard("board", { draggable: false, position: build().fens[cur], pieceTheme: "img/chesspieces/wikipedia/{piece}.png" });
    // 曲线（首次渲染带描边生长动画）
    drawCurve(true);
    renderStep();
    renderMoveList();
  }

  // 走法列表：全部着法成对填充 #movelist，点击任意一步直接跳到该局面
  function renderMoveList() {
    const el = $("movelist");
    if (!el || !moves.length) return;
    el.innerHTML = moves.map((m, i) =>
      `<span class="rmv${i + 1 === cur ? " on" : ""}" data-n="${i + 1}">${i + 1}. ${m.san}</span>`
    ).join("");
    el.querySelectorAll(".rmv").forEach(s => s.addEventListener("click", () => {
      stopPlay();
      cur = +s.dataset.n;
      if (board) (window.StarChessMotion ? StarChessMotion.sync(board, build().fens[cur], true) : board.position(build().fens[cur]));
      renderStep();
      drawCurve();
      el.querySelectorAll(".rmv").forEach(x => x.classList.toggle("on", x === s));
    }));
  }

  function accPerColor(color, el) {
    const mine = review.filter(r => r.color === color);
    if (!mine.length) { el.textContent = "—"; return; }
    const acc = mine.reduce((s, r) => s + accOf(r), 0) / mine.length;
    el.textContent = acc.toFixed(1);
  }
  function accOf(r) {
    if (r.key === "book" || r.key === "best" || r.key === "brilliant") return 100;
    return Math.max(0, 100 * Math.exp(-r.lossCp / 55));
  }
  function segmentAcc() {
    let seg = { opening: [], mid: [], end: [] };
    review.forEach(r => {
      const bucket = r.n <= 10 ? "opening" : r.n <= 40 ? "mid" : "end";
      seg[bucket].push(accOf(r));
    });
    const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    return { opening: avg(seg.opening), mid: avg(seg.mid), end: avg(seg.end) };
  }
  function phaseName(n) { return n <= 10 ? "开局" : n <= 40 ? "中局" : "残局"; }

  function coach() {
    const parts = [];
    const blunder = review.find(r => r.key === "blunder");
    const mistake = review.find(r => r.key === "mistake");
    const brilliant = review.find(r => r.key === "brilliant");
    const missed = review.filter(r => r.key === "miss").length;
    const side = c => (c === "w" ? "白方" : "黑方");
    if (review.slice(0, 10).every(r => r.key === "book")) parts.push("开局完全符合理论谱着，双方平稳。");
    else {
      const bad = review.find(r => r.key === "inaccuracy" && r.n <= 10);
      if (bad) parts.push(`开局 ${side(bad.color)} 第 ${bad.n} 步走得不精确（${bad.san}）。`);
      else parts.push("开局双方应对平稳。");
    }
    if (blunder) parts.push(`对局在第 ${blunder.n} 步出现转折——${side(blunder.color)} 走出${blunder.cls.label}（${blunder.san}，损失约 ${blunder.lossCp.toFixed(0)}cp），${side(blunder.color === "w" ? "b" : "w")} 就此掌控局势。`);
    else if (mistake) parts.push(`中后盘 ${side(mistake.color)} 在第 ${mistake.n} 步出现失误（${mistake.san}）。`);
    if (missed) parts.push(`全盘共错过 ${missed} 次战术机会。`);
    if (brilliant) parts.push(`${side(brilliant.color)} 第 ${brilliant.n} 步 ${brilliant.cls.label}（${brilliant.san}）堪称妙手。`);
    if (!parts.length) parts.push("对局平稳进行。");
    return parts.join("");
  }

  function renderBoard() {
    const order = ["brilliant", "best", "excellent", "good", "book", "inaccuracy", "miss", "mistake", "blunder"];
    const cnt = (c, key) => review.filter(r => r.key === key && r.color === c).length;
    const cell = key => `<td style="padding:6px 10px;border-bottom:1px solid var(--line)"><span style="color:${CLASSES[key].color}">${CLASSES[key].label}</span></td>
      <td style="text-align:center;font-family:monospace">${cnt("w", key)}</td><td style="text-align:center;font-family:monospace">${cnt("b", key)}</td>`;
    const head = `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr style="font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--faint);letter-spacing:.1em">
        <td>等级</td><td style="text-align:center">白</td><td style="text-align:center">黑</td></tr>
      ${order.map(cell).join("")}</table>`;
    const maxCp = Math.max(...nodes.map(n => Math.abs(n.cp)), 0.1);
    const turnIdx = review.findIndex(r => r.key === "blunder");
    return head + `<div style="margin-top:10px;font-size:11px;color:var(--muted);font-family:monospace">
      最大优势 ${maxCp.toFixed(0)}cp · ${turnIdx >= 0 ? `转折点 第${turnIdx + 1}步` : "无重大转折"} · 平均损失 ${(review.reduce((s, r) => s + r.lossCp, 0) / review.length).toFixed(0)}cp</div>`;
  }

  function drawCurve(animate) {
    const svg = $("curve"), W = 600, H = 150;
    // 白方 cp 曲线（每步后）
    // 白方视角 cp（局面轮到白则取本身，轮到黑则取负）
    const pts = nodes.map((n, i) => (n.turn === "w" ? n.cp : -n.cp));   // 长度 = moves+1
    const maxCp = Math.max(...pts.map(Math.abs), 1);
    const xOf = i => (i / Math.max(1, pts.length - 1)) * W;
    const yOf = cp => H / 2 - (cp / maxCp) * (H / 2 - 6);
    let d = "";
    pts.forEach((cp, i) => d += (i === 0 ? "M" : "L") + xOf(i).toFixed(1) + "," + yOf(cp).toFixed(1));
    svg.innerHTML = `
      <line x1="0" y1="${H/2}" x2="${W}" y2="${H/2}" stroke="#eff2e824" stroke-width="1" stroke-dasharray="4,4"></line>
      <path d="${d}" fill="none" stroke="#d7ff3f" stroke-width="2"></path>
      ${review.map((r, i) => {
        if (r.key === "blunder") return `<circle cx="${xOf(i + 1)}" cy="${yOf(pts[i + 1])}" r="5" fill="#e02c1a" stroke="#000" stroke-width="1"><title>第${r.n}步 大漏 ${r.san}</title></circle>`;
        if (r.key === "brilliant") return `<circle cx="${xOf(i + 1)}" cy="${yOf(pts[i + 1])}" r="5" fill="#3ac94e" stroke="#000" stroke-width="1"><title>第${r.n}步 妙手 ${r.san}</title></circle>`;
        return "";
      }).join("")}
      <line x1="${xOf(cur)}" y1="0" x2="${xOf(cur)}" y2="${H}" stroke="#2ed3ff" stroke-width="1"></line>`;
    // 首次渲染：优势曲线从左向右描边生长（导航重绘时不重复播放）
    if (animate) {
      const path = svg.querySelector("path");
      if (path && !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) {
        const L = path.getTotalLength();
        if (L > 0 && isFinite(L)) {
          path.style.strokeDasharray = L;
          path.style.strokeDashoffset = L;
          void svg.getBoundingClientRect();
          path.style.transition = "stroke-dashoffset 1.2s cubic-bezier(.55,0,.3,1)";
          requestAnimationFrame(() => { path.style.strokeDashoffset = "0"; });
        }
      }
    }
  }

  function renderStep() {
    $("pos").textContent = `${cur} / ${moves.length}`;
    // 详情
    const el = $("detail");
    if (cur === 0) { el.innerHTML = `<div style="color:var(--muted)">开局局面 · 使用 ←/→ 或「自动播放」逐手复盘</div>`; renderRecs(null); return; }
    const r = review[cur - 1];
    const c = CLASSES[r.key];
    const issue = issueText(r);
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <span style="font-family:ui-monospace,Menlo,monospace;font-size:10px;border:1px solid ${c.color}66;color:${c.color};padding:3px 10px">${c.label} ${c.sym}</span>
        <span style="font-size:15px;font-weight:600">${r.n}. ${r.san}</span>
        <span style="font-size:12px;color:var(--muted)">${r.p === "w" ? "白方" : "黑方"} · ${phaseName(r.n)}</span>
      </div>
      <div style="font-size:12.5px;color:var(--muted);line-height:1.8">
        ${r.p === "w" ? "白方" : "黑方"}评估 ${r.before >= 0 ? "+" : ""}${r.before.toFixed(0)} → ${r.after >= 0 ? "+" : ""}${r.after.toFixed(0)} cp
        （损失 <b style="color:${c.color}">${r.lossCp.toFixed(0)}cp</b>）<br>
        ${r.bestUci ? `更优着法：<b style="color:var(--signal)">${bestSan(r.bestUci)}</b>` : ""}
        ${r.key === "book" ? "· 开局理论谱着" : ""}
      </div>
      <div style="margin-top:10px;font-size:13px;color:var(--paper)">${r.key === "book" ? "这步符合公认开局理论，稳妥可靠。" : descFor(r)}</div>
      ${issue ? `<div style="margin-top:8px;font-size:12px;color:var(--amber)">问题：${issue}</div>` : ""}`;
    renderRecs(nodes[cur - 1].cands);
  }
  function issueText(r) {
    if (r.key === "book" || r.lossCp <= 20) return "";
    const out = [];
    if (r.captured && r.flags.attack) out.push(`吃子/将军机会：本可${bestSan(r.bestUci)}`);
    if (r.lossCp > 50) out.push("子力活动性或局面主动性受损");
    if (r.jumpCp < -50) out.push("国王安全 / 兵型可能受到威胁");
    return out.join("；") || (r.key === "miss" ? "错失战术：吃子 / 将军 / 得子机会" : "");
  }
  function descFor(r) {
    const map = {
      brilliant: "精妙妙手！你走出了引擎最优着法，且局面评估显著上升，堪称战术佳作。",
      best: "与引擎 Top-1 完全一致，这是当前局面的最优选择。",
      excellent: "极佳走法，损失 ≤5cp，几乎等同于最优解。",
      good: "合格好棋，损失 5-20cp，局面优势未被破坏。",
      inaccuracy: "轻微偏差，损失 20-50cp，微弱丢掉优势。",
      mistake: "失误，损失 50-150cp，优势明显下滑、局面陷入被动。",
      miss: "战术遗漏：错过了当前局面存在的将军 / 捉子 / 得子 / 杀棋机会。",
      blunder: "严重错误！损失 >150cp，直接送子或送掉优势，甚至可能直接输掉对局。",
    };
    return map[r.key] || "";
  }
  function bestSan(uci) {
    try {
      const g = new Chess(build().fens[cur - 1]);
      const m = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || "q" });
      return m ? m.san : uci;
    } catch (e) { return uci; }
  }
  function renderRecs(cands) {
    const el = $("recs");
    if (!cands || !cands.length) { el.innerHTML = '<label>引擎推荐走法（Top 3）</label><div style="color:var(--faint);font-size:12px">—</div>'; return; }
    el.innerHTML = '<label>引擎推荐走法（Top 3）</label>' + cands.map((c, i) => {
      const uci = c.pv && c.pv[0];
      const score = c.mate != null ? `mate${c.mate < 0 ? "-" : "+"}${Math.abs(c.mate)}`
        : `${c.evalCp >= 0 ? "+" : ""}${(c.evalCp / 100).toFixed(2)}`;
      return `<div class="rec"><span style="color:var(--faint)">${i + 1}</span><span>${uci ? bestSan(uci) : "—"}</span><span style="flex:1"></span><span style="color:var(--muted)">${score}</span></div>`;
    }).join("");
  }

  /* ---- 导航 & 自动播放（走到关键节点停下） ---- */
  window.nav = function (d) {
    const next = Math.max(0, Math.min(moves.length, cur + d));
    if (d > 0 && next > cur && window.Motion && Motion.sfx) Motion.sfx.tick();   // 步进微咔
    cur = next;
    if (board) (window.StarChessMotion ? StarChessMotion.sync(board, build().fens[cur], true) : board.position(build().fens[cur]));
    renderStep();
    drawCurve();
    renderMoveList();
  };
  window.jumpStart = function () { cur = 0; if (board) (window.StarChessMotion ? StarChessMotion.sync(board, build().fens[0], true) : board.position(build().fens[0])); renderStep(); drawCurve(); renderMoveList(); };

  function isKeyNode(r) { return ["blunder", "miss", "brilliant", "great", "mistake"].includes(r.key); }
  window.autoPlay = function () {
    if (playing) { stopPlay(); return; }
    playing = true; $("play-btn").textContent = "⏸ 暂停";
    const step = () => {
      if (cur >= moves.length) { stopPlay(); return; }
      nav(1);
      const r = review[cur - 1];
      if (r && isKeyNode(r)) {
        // 关键节点：停下并高亮点评
        stopPlay();
        $("status").textContent = `⛔ 关键节点：${r.cls.label}（第${r.n}步）`;
        document.getElementById("detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
    };
    step();
    playTimer = setInterval(step, 1200);
  };
  function stopPlay() {
    playing = false; clearInterval(playTimer);
    $("play-btn").textContent = "▶ 自动播放";
  }

  function setStatus(txt, alert) {
    const el = $("status"); if (!el) return;
    el.textContent = txt;
    el.style.color = alert ? "var(--coral)" : "var(--signal)";
  }

  connect();
  Motion.initCursorLine();
  Motion.initRipple();
  Motion.staggerEnter();
  // data-nav 导航由 motion.js 的 wireNav() 集中委托（含修饰键放行/防叠层）
  analyze();
})();
