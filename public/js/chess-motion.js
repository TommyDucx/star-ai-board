/* 统一棋子移动层 —— 动效完全对齐 Project Kylin 的 _boardPieceReposition：
   棋子从旧位置半透明（opacity .22）+ 1px 模糊滑入，72% 处抵达并泛一下绿光，
   总时长 .46s、曲线 cubic-bezier(.16, 1, .3, 1)；多子重排（易位 / 归位 / 悔棋）按距离错峰。

   原理（FLIP）：chessboard.js 改位置是瞬时的，所以我们在更新前后做 First-Last-Invert-Play：
   记录旧坐标 → 瞬时更新 → 给每个「位移过的棋子」注入 --rp-x/--rp-y 并播放关键帧。
   绝不改变棋盘容器的位置或尺寸（棋盘不再随走子晃动）。 */
(function () {
  "use strict";

  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const DURATION = 460;                 // Kylin: .46s
  const STAGGER_STEP = 18;              // 多子错峰（Kylin 用 --reposition-delay 暴露该能力）
  const STAGGER_MAX = 90;
  const PIECE_SEL = "img.piece-417db";

  function boardOptions() {
    // 保留 chessboard 自身的速度参数（它的 position() 默认走动画路径，把速度归零会让放置失效），
    // 但 sync() 一律以 useAnimation=false 调用，位移与落点动画由本文件的 FLIP 关键帧接管。
    return {
      appearSpeed: reduced ? 0 : 160,
      moveSpeed: reduced ? 0 : 220,
      snapSpeed: reduced ? 0 : 140,
      snapbackSpeed: reduced ? 0 : 140,
    };
  }

  function boardRoot(explicit) {
    return explicit || document.querySelector(".board-b72b1") || document.getElementById("board");
  }

  /* 快照：每枚棋子的「所在格子 + 类型 + 屏幕坐标」。
     注意 chessboard 的棋子是**格子的子元素**（position:static），走子时节点会被重建，
     所以不能按元素同一性匹配，必须按「格子 + 类型」找来源。 */
  function snapshot(root) {
    const list = [];
    root.querySelectorAll(PIECE_SEL).forEach(img => {
      const sq = ((img.parentElement && img.parentElement.className) || "").match(/square-([a-h][1-8])/);
      const type = (img.getAttribute("src") || "").match(/\/([wb][KQRBNP])\.png$/);
      const r = img.getBoundingClientRect();
      list.push({ sq: sq ? sq[1] : "", type: type ? type[1] : "", el: img, x: r.x, y: r.y });
    });
    return list;
  }

  let clearTimer = 0;

  function play(root, before) {
    const after = snapshot(root);
    const afterSquares = new Set(after.map(a => a.sq));
    const used = new Set();
    const moved = [];
    after.forEach(a => {
      if (before.some(b => b.sq === a.sq && b.type === a.type)) return;   // 原位同子：没动
      // 来源候选：同类型、其旧格子已不在新局面上、尚未被别的棋子认领
      const cands = before.filter(b => b.type === a.type && b.sq && !afterSquares.has(b.sq) && !used.has(b));
      if (!cands.length) return;                                          // 真·新棋子（兵升变等）不动画
      cands.sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y));
      const src = cands[0];
      used.add(src);
      const dx = Math.round(src.x - a.x), dy = Math.round(src.y - a.y);
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;                    // 拖动落子后只是对表
      moved.push({ el: a.el, dx, dy, d: Math.hypot(dx, dy) });
    });
    if (!moved.length) return;
    moved.sort((a, b) => b.d - a.d);                                      // 位移大的先走，视觉更自然
    const stagger = moved.length > 1;
    moved.forEach((m, i) => {
      const img = m.el;
      img.style.setProperty("--rp-x", m.dx + "px");
      img.style.setProperty("--rp-y", m.dy + "px");
      img.style.setProperty("--rp-delay", (stagger ? Math.min(i * STAGGER_STEP, STAGGER_MAX) : 0) + "ms");
      img.classList.remove("piece-reposition");
      void img.offsetWidth;                                               // 强制回流，保证动画从头重放
      img.classList.add("piece-reposition");
    });
    window.clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => {
      moved.forEach(m => {
        m.el.classList.remove("piece-reposition");
        ["--rp-x", "--rp-y", "--rp-delay"].forEach(v => m.el.style.removeProperty(v));
      });
    }, DURATION + STAGGER_MAX + 120);
  }

  /* 同步棋盘到指定局面。animate=true 时走 FLIP 位移动画（reduced-motion 下自动退化为瞬时）。
     一律以 useAnimation=false 放置——瞬时落位后由关键帧把它「变成」从旧位置滑过来。 */
  function sync(board, fen, animate) {
    if (!board) return;
    const root = boardRoot();
    if (!animate || reduced || !root) { board.position(fen, false); return; }
    const prev = snapshot(root);
    board.position(fen, false);
    play(root, prev);
  }

  /* 落点提示：在 from/to 两格打标记（沿用站点既有 .star-move-mark 样式） */
  function pulse(root, move) {
    if (!root || !move) return;
    window.clearTimeout(pulse._timer);
    root.querySelectorAll(".star-move-mark").forEach(el => el.remove());
    ["from", "to"].forEach(key => {
      const sq = move[key];
      if (!sq) return;
      const host = root.querySelector(".square-" + sq);
      if (!host) return;
      const mark = document.createElement("i");
      mark.className = "star-move-mark " + key;
      mark.setAttribute("aria-hidden", "true");
      host.appendChild(mark);
    });
    pulse._timer = window.setTimeout(() => {
      root.querySelectorAll(".star-move-mark").forEach(el => el.remove());
    }, reduced ? 0 : 620);
  }

  window.StarChessMotion = { boardOptions, sync, pulse };
})();
