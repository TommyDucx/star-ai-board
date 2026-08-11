/* =============================================================================
   介绍页互动：迷你棋盘自动对弈演示 + 光标跟随 + 数字跑动 + 特性条填充
   ============================================================================= */
(function () {
  "use strict";

  /* ---------------- 迷你围棋盘（9 路自动演示） ---------------- */
  const GO_N = 9, GO_CELL = 34, GO_PAD = 24;
  let goBoard = Array.from({ length: GO_N }, () => Array(GO_N).fill(0));
  const GO_SEQ = [  // 9 路 GTP 序列（黑白交替）
    ["B","E5"],["W","D4"],["B","C6"],["W","G5"],["B","E3"],["W","F4"],
    ["B","C4"],["W","E6"],["B","D3"],["W","F6"],["B","C7"],["W","G4"],
  ];
  const L = "ABCDEFGHJ";
  function gtp(r, c) { return L[c] + (GO_N - r); }
  function fromGtp(s) { return { r: GO_N - +s.slice(1), c: L.indexOf(s[0]) }; }
  let goDemoIdx = 0;

  function renderGo() {
    const size = GO_CELL * (GO_N - 1) + GO_PAD * 2;
    const svg = document.getElementById("go-demo");
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    let h = `<rect class="bg" width="${size}" height="${size}" rx="6"></rect>`;
    for (let i = 0; i < GO_N; i++) {
      const p = GO_PAD + i * GO_CELL;
      h += `<line x1="${GO_PAD}" y1="${p}" x2="${size - GO_PAD}" y2="${p}"></line>`;
      h += `<line x1="${p}" y1="${GO_PAD}" x2="${p}" y2="${size - GO_PAD}"></line>`;
    }
    const stars = GO_N === 9 ? [[2,2],[2,6],[6,2],[6,6]] : [];
    stars.forEach(([r,c]) => { const x=GO_PAD+c*GO_CELL, y=GO_PAD+r*GO_CELL; h += `<circle cx="${x}" cy="${y}" r="3" fill="#5d4320"></circle>`; });
    for (let r = 0; r < GO_N; r++) for (let c = 0; c < GO_N; c++) {
      if (!goBoard[r][c]) continue;
      const x = GO_PAD + c * GO_CELL, y = GO_PAD + r * GO_CELL, col = goBoard[r][c] === 1 ? "#111" : "#f5f5f5";
      h += `<circle cx="${x}" cy="${y}" r="${GO_CELL * 0.44}" fill="${col}" stroke="#00000055" stroke-width="1">
        <animate attributeName="r" values="0;${GO_CELL * 0.44};${GO_CELL * 0.44}" dur="0.3s" fill="freeze"></animate></circle>`;
    }
    svg.innerHTML = h;
  }

  // 点击迷你围棋盘 → 下一手（演示）
  function goNextStep() {
    if (goDemoIdx >= GO_SEQ.length) { goDemoIdx = 0; goBoard = goBoard.map(r => r.slice()); goBoard = goBoard.map(() => Array(GO_N).fill(0)); }
    const [col, mv] = GO_SEQ[goDemoIdx];
    const { r, c } = fromGtp(mv);
    goBoard[r][c] = col === "B" ? 1 : 2;
    goDemoIdx++;
    renderGo();
  }

  /* ---------------- 迷你国际象棋盘（AI 自弈演示） ---------------- */
  const demoGame = new Chess();
  const CHESS_SEQ = ["e2e4","e7e5","g1f3","b8c6","f1b5","a7a6","b5a4","g8f6","o-o","f8e7"];
  let chessDemoIdx = 0;
  let demoBoard = null;

  function chessNextStep() {
    if (chessDemoIdx >= CHESS_SEQ.length) { demoGame.reset(); chessDemoIdx = 0; }
    const mv = CHESS_SEQ[chessDemoIdx++];
    if (mv === "o-o") demoGame.move({ from: demoGame.turn() === "w" ? "e1" : "e8", to: demoGame.turn() === "w" ? "g1" : "g8" });
    else demoGame.move({ from: mv.slice(0,2), to: mv.slice(2,4) });
    demoBoard.position(demoGame.fen());
  }

  /* ---------------- 独立磁吸（每个演示盘在各自范围内跟随鼠标）+ hero 网格视差 ---------------- */
  function demoMagnet() {
    const demos = document.querySelectorAll(".demo-board");
    const hero = document.querySelector(".hero");
    document.addEventListener("pointermove", e => {
      if (hero) {
        const r = hero.getBoundingClientRect();
        hero.style.setProperty("--shift-x", ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
        hero.style.setProperty("--shift-y", ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
      }
      demos.forEach(d => {
        const r = d.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const dx = e.clientX - cx, dy = e.clientY - cy;
        const dist = Math.hypot(dx, dy);
        const range = Math.max(r.width, r.height) * 2.6;   // 各自的活动范围
        if (dist < range) {
          const f = (1 - dist / range) * 0.12;
          d.style.transform = `translate(${dx * f}px, ${dy * f}px) rotateX(${dy * f * -0.1}deg)`;
        } else {
          d.style.transform = "translate(0,0) rotateX(0)";
        }
      });
    });
  }

  /* ---------------- 数字跑动 ---------------- */
  let n = 0;
  function runNum() {
    n = (n + Math.floor(Math.random() * 120 + 60)) % 997;
    const el = document.getElementById("demo-num");
    if (el) el.textContent = `# ${String(n).padStart(3, "0")} VISITS`;
  }

  /* ---------------- 特性条填充 ---------------- */
  function fillBars() {
    setTimeout(() => document.querySelectorAll(".bar[data-fill]").forEach(b => {
      b.querySelector("i").style.width = b.dataset.fill + "%";
    }), 600);
  }

  /* ---------------- 进入系统 ---------------- */
  function wireEnter() {
    document.getElementById("enter-btn").addEventListener("click", () => Motion.handoff("main.html"));
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    Motion.runBoot();
    Motion.initCursorLine();
    Motion.initMagnetic();
    Motion.initRipple();
    demoMagnet();
    wireEnter();
    fillBars();

    // 迷你围棋盘
    renderGo();
    document.getElementById("go-demo-card").addEventListener("click", goNextStep);

    // 迷你国际象棋盘
    demoBoard = Chessboard("chess-demo", {
      draggable: false, position: "start",
      pieceTheme: "img/chesspieces/wikipedia/{piece}.png",
    });
    demoBoard.resize();

    // 自动演示循环（围棋 + 国际象棋 + 数字）
    let gi = 0, ci = 0;
    setInterval(() => { if (++gi % 2 === 0) goNextStep(); }, 1500);
    setInterval(() => { if (++ci % 2 === 0) chessNextStep(); }, 1500);
    setInterval(runNum, 500);
    const roll = document.getElementById("roll");
    if (roll) roll.textContent = "三引擎已就绪 · KATAGO + STOCKFISH + RECKLESS";
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
