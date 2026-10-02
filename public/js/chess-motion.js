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

  /* 解析「棋盘根节点」。入参可能是：
     ① DOM 元素（外层容器 #board / #lib-board …）
     ② chessboard 实例对象（sync() 传的是实例；实例只有 .container，没有 querySelector，
        早期直接调用 el.querySelector 会抛 "el.querySelector is not a function"）
     ③ null / undefined
     统一归一化到内层 .board-b72b1（position:relative，格子的真正挂载点）：
     格子在内层，若把轨迹层挂到外层 static 容器，absolute 的定位基准会落到 .board-zone 之类
     外层相对容器上 → 拖尾整体偏移（平板上直接出屏）。 */
  function boardRoot(explicit) {
    let el = explicit;
    if (el && typeof el.querySelector !== "function") {      // 实例对象 / jQuery 包装 → 取容器
      const c = el.container;
      el = (c && typeof c.querySelector === "function") ? c : ((c && c[0]) || null);
    }
    if (!el || typeof el.querySelector !== "function") el = document.querySelector(".board-b72b1") || document.getElementById("board");
    if (!el || typeof el.querySelector !== "function") return null;   // 页面尚未建棋盘 → 安全退出
    if (!el.querySelector(":scope > .star-trace-layer")) {
      const inner = el.querySelector(".board-b72b1");
      if (inner) el = inner;
    }
    return el;
  }

  /* 快照：每枚棋子的「所在格子 + 类型 + 屏幕坐标」。
     注意 chessboard 的棋子是**格子的子元素**（position:static），走子时节点会被重建，
     所以不能按元素同一性匹配，必须按「格子 + 类型」找来源。 */
  function snapshot(root) {
    const list = [];
    root.querySelectorAll(PIECE_SEL).forEach(img => {
      const parent = img.parentElement;
      const sq = ((parent && parent.className) || "").match(/square-([a-h][1-8])/);
      const type = (img.getAttribute("src") || "").match(/\/([wb][KQRBNP])\.png$/);
      /* 棋子若挂在格子里（本项目两套棋盘都是这种结构），位置取「格子的矩形」——
         这样即使棋子本身带 transform（拖拽跟随/上一次动画未结束），也不会把坐标搞错。 */
      const box = (sq && parent ? parent : img).getBoundingClientRect();
      list.push({ sq: sq ? sq[1] : "", type: type ? type[1] : "", el: img, x: box.x, y: box.y });
    });
    return list;
  }

  let clearTimer = 0;
  let lastMover = null;          // 最近一次位移的棋子（供拖尾跟随）
  /* 拖拽判定：按下时标记 dragging，抬起后保持 450ms 的"落子余波"窗口。
     拖拽落子时棋子是被指针带着走的（常带 transform），若此时按 FLIP 播放位移，
     会把它当成一次真实走子 → 棋子从光标处（可能在棋盘外）飞回、拖尾也跟着跑偏。 */
  let dragging = false, dragUntil = 0, downPt = null;
  const DRAG_TAIL_MS = 450;      // 抬起后仍视为"拖拽落子"的余波窗口
  const DRAG_MIN_PX = 6;         // 位移阈值：小于它算点击式走子（必须保留动画）
  if (typeof document !== "undefined") {
    document.addEventListener("pointerdown", function (e) {
      const root = boardRoot();
      if (root && root.contains(e.target)) { downPt = { x: e.clientX, y: e.clientY }; dragging = false; }
      else downPt = null;
    }, true);
    document.addEventListener("pointermove", function (e) {
      if (downPt && !dragging && Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y) > DRAG_MIN_PX) dragging = true;
    }, true);
    const endDrag = function () {
      if (dragging) { dragUntil = Date.now() + DRAG_TAIL_MS; }
      dragging = false; downPt = null;
    };
    document.addEventListener("pointerup", endDrag, true);
    document.addEventListener("pointercancel", endDrag, true);
  }
  function isDragSettling() { return dragging || Date.now() < dragUntil; }

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
    // 拖拽落子：棋子已随指针落到目标格，这里不再补位移动画（否则会从光标处飞回来）
    if (isDragSettling()) { lastMover = null; return; }
    moved.sort((a, b) => b.d - a.d);                     // 位移大的先走，视觉更自然
    // 单子移动 = 走子（Kylin 用 .22s 干净的街机式位移）；
    // 多子重排（易位 / 悔棋 / 载入局面）= .46s 半透明模糊滑入 + 错峰。
    const arcade = moved.length === 1;
    const stagger = moved.length > 1;
    lastMover = arcade ? moved[0].el : null;   // 拖尾只跟单子（走子）
    moved.forEach((m, i) => {
      const el = m.el;
      if (arcade) {
        // Kylin 用百分比位移（相对自身格子尺寸），这里按格子边长折算成同样的百分比
        const cell = el.getBoundingClientRect().width || 1;
        el.style.setProperty("--piece-dx", (m.dx / cell * 100).toFixed(2) + "%");
        el.style.setProperty("--piece-dy", (m.dy / cell * 100).toFixed(2) + "%");
        el.classList.remove("piece-arcade-move");
        void el.offsetWidth;
        el.classList.add("piece-arcade-move");
        return;
      }
      el.style.setProperty("--rp-x", m.dx + "px");
      el.style.setProperty("--rp-y", m.dy + "px");
      el.style.setProperty("--rp-delay", (stagger ? Math.min(i * STAGGER_STEP, STAGGER_MAX) : 0) + "ms");
      el.classList.remove("piece-reposition");
      void el.offsetWidth;                               // 强制回流，保证动画从头重放
      el.classList.add("piece-reposition");
    });
    window.clearTimeout(clearTimer);
    clearTimer = window.setTimeout(() => {
      moved.forEach(m => {
        m.el.classList.remove("piece-reposition", "piece-arcade-move");
        ["--rp-x", "--rp-y", "--rp-delay", "--piece-dx", "--piece-dy"].forEach(v => m.el.style.removeProperty(v));
      });
    }, DURATION + STAGGER_MAX + 120);
  }

  /* 同步棋盘到指定局面。animate=true 时走 FLIP 位移动画（reduced-motion 下自动退化为瞬时）。
     一律以 useAnimation=false 放置——瞬时落位后由关键帧把它「变成」从旧位置滑过来。 */
  /* 容器尺寸变化后必须让棋盘重算：chessboard 会按「初始化时的容器宽度」写死内部像素，
     窗口/设备方向变化后若不调用 resize()，内层棋盘会保持旧尺寸 → 在窄屏上横向溢出。 */
  const knownBoards = new Set();
  let resizeTimer = 0;
  function rememberBoard(b) { if (b && typeof b.resize === "function") knownBoards.add(b); }
  /* 页面创建棋盘后立刻调用：登记实例，并在容器比初始化时更窄时补一次 resize() */
  function register(b) {
    rememberBoard(b);
    if (!b || typeof b.resize !== "function") return;
    window.requestAnimationFrame(function () { window.requestAnimationFrame(function () { try { b.resize(); } catch (e) {} }); });
  }
  if (typeof window !== "undefined") {
    window.addEventListener("resize", function () {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        knownBoards.forEach(function (b) { try { b.resize(); } catch (e) {} });
      }, 150);
    });
    window.addEventListener("orientationchange", function () {
      window.setTimeout(function () { knownBoards.forEach(function (b) { try { b.resize(); } catch (e) {} }); }, 260);
    });
  }

  function sync(board, fen, animate) {
    if (!board) return;
    rememberBoard(board);
    const root = boardRoot(board);
    if (!animate || reduced || !root) { board.position(fen, false); return; }
    const prev = snapshot(root);
    board.position(fen, false);
    play(root, prev);
  }

  /* 落点反馈三件套（Kylin：_lastMoveSquare 残留高亮 + _moveTrace 轨迹 + _arcadeTrace 淡出）：
     ① 起止格加淡绿底残留（保留到下一手）；② 画一条绿虚线轨迹，0.44s 内先亮起再流动淡出。 */
  function ensureLayer(root) {
    let layer = root.querySelector(":scope > .star-trace-layer");
    if (!layer) {
      layer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      layer.setAttribute("class", "star-trace-layer");
      root.appendChild(layer);
    }
    const w = root.clientWidth, h = root.clientHeight;
    layer.setAttribute("width", w);
    layer.setAttribute("height", h);
    layer.setAttribute("viewBox", "0 0 " + w + " " + h);
    return layer;
  }
  function centerOf(root, square) {
    const sq = root.querySelector(".square-" + square);
    if (!sq) return null;
    const rb = root.getBoundingClientRect(), r = sq.getBoundingClientRect();
    return { x: r.left - rb.left + r.width / 2, y: r.top - rb.top + r.height / 2 };
  }
  function pulse(root, move) {
    if (!root || !move) return;
    root = boardRoot(root);              // 页面可能传外层容器 → 归一化到内层棋盘，坐标与定位基准才一致
    const layer = ensureLayer(root);
    // 清掉上一手的残留（Kylin 只留当前这一手）
    root.querySelectorAll(":scope > .star-trace-layer .star-move-trace").forEach(el => el.remove());
    root.querySelectorAll(".square-55d63.star-last-move").forEach(el => el.classList.remove("star-last-move"));
    ["from", "to"].forEach(key => {
      const sq = root.querySelector(".square-" + move[key]);
      if (sq) sq.classList.add("star-last-move");
    });
    const a = centerOf(root, move.from), b = centerOf(root, move.to);
    if (a && b && layer) {
      const NS = "http://www.w3.org/2000/svg";
      const sqEl = root.querySelector(".square-" + (move.from || "e2"));
      const cell = sqEl ? sqEl.getBoundingClientRect().width : 0;
      const lw = Math.max(3, Math.min(8, cell / 11)).toFixed(1) + "px";
      /* 渐变彗尾：userSpaceOnUse 梯度（尾端透明 → 头端亮），坐标随头部实时更新 */
      const gid = "star-trail-g" + (++pulse._gid);
      const defs = document.createElementNS(NS, "defs");
      const grad = document.createElementNS(NS, "linearGradient");
      grad.setAttribute("id", gid);
      grad.setAttribute("gradientUnits", "userSpaceOnUse");
      grad.setAttribute("x1", a.x); grad.setAttribute("y1", a.y);
      grad.setAttribute("x2", a.x); grad.setAttribute("y2", a.y);
      [["0", "rgba(215,255,63,0)"], ["0.55", "rgba(215,255,63,.4)"], ["1", "rgba(232,255,140,.95)"]].forEach(([o, c]) => {
        const st = document.createElementNS(NS, "stop");
        st.setAttribute("offset", o); st.setAttribute("stop-color", c);
        grad.appendChild(st);
      });
      defs.appendChild(grad);
      layer.appendChild(defs);
      const line = document.createElementNS(NS, "line");
      line.setAttribute("x1", a.x); line.setAttribute("y1", a.y);
      line.setAttribute("x2", a.x); line.setAttribute("y2", a.y);
      line.setAttribute("class", "star-move-trace");
      line.setAttribute("stroke", "url(#" + gid + ")");
      line.style.setProperty("--trace-w", lw);
      line.style.strokeDasharray = "none";            // 彗尾是连续光带，不用虚线
      layer.appendChild(line);
      /* 头部光点：贴着棋子，落地后随整条彗尾一起淡出 */
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("r", Math.max(2.5, cell / 22).toFixed(1));
      dot.setAttribute("fill", "#e8ff8c");
      dot.setAttribute("cx", a.x); dot.setAttribute("cy", a.y);
      dot.setAttribute("class", "star-trace-head");
      layer.appendChild(dot);
      /* 彗星式拖尾：线从起点格向「棋子的当前位置」生长——尾巴始终在棋子身后，
         棋子落地时终点自然等于落点格中心，随后整条路径就地淡出，全程与棋子严格对应。
         注意：pulse() 可能先于 sync() 被页面调用，所以棋子元素在 rAF 里延迟解析。 */
      const t0 = performance.now();
      const FLY = 240;                     // 略大于棋子位移时长（.22s），确保落地瞬间仍贴合
      let raf = 0, mover = isDragSettling() ? null : root.querySelector("img.piece-arcade-move");
      const head = (x, y) => {
        line.setAttribute("x2", x); line.setAttribute("y2", y);
        grad.setAttribute("x2", x); grad.setAttribute("y2", y);
        dot.setAttribute("cx", x); dot.setAttribute("cy", y);
      };
      if (!reduced && !mover) head(b.x, b.y);
      if (!reduced) {
        const step = () => {
          if (!mover) mover = root.querySelector("img.piece-arcade-move");
          const head = (x, y) => {
            line.setAttribute("x2", x); line.setAttribute("y2", y);
            grad.setAttribute("x2", x); grad.setAttribute("y2", y);
            dot.setAttribute("cx", x); dot.setAttribute("cy", y);
          };
          if (mover && mover.isConnected) {
            const rb = root.getBoundingClientRect(), r = mover.getBoundingClientRect();
            head((r.left - rb.left + r.width / 2).toFixed(1), (r.top - rb.top + r.height / 2).toFixed(1));
          }
          if (performance.now() - t0 < FLY) raf = requestAnimationFrame(step);
          else head(b.x, b.y);                                            // 归位到落点格中心
        };
        raf = requestAnimationFrame(step);
      } else {
        line.setAttribute("x2", b.x); line.setAttribute("y2", b.y);
      }
      window.setTimeout(() => {
        window.cancelAnimationFrame(raf);
        line.remove(); dot.remove(); defs.remove();      // 光点与梯度一并回收
      }, reduced ? 0 : 520);
    }
    // 站点既有的落点标记（描边脉冲）保留：与残留高亮叠加成"落点 + 残影"两层反馈
    root.querySelectorAll(".star-move-mark").forEach(el => el.remove());
    ["from", "to"].forEach(key => {
      const sq = root.querySelector(".square-" + move[key]);
      if (!sq) return;
      const mark = document.createElement("i");
      mark.className = "star-move-mark " + key;
      mark.setAttribute("aria-hidden", "true");
      sq.appendChild(mark);
    });
    window.clearTimeout(pulse._timer);
    pulse._timer = window.setTimeout(() => {
      root.querySelectorAll(".star-move-mark").forEach(el => el.remove());
    }, reduced ? 0 : 620);
  }

  window.StarChessMotion = { boardOptions, sync, pulse, register };
})();
