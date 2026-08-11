/* =============================================================================
   S.T.A.R. motion —— 与原错题系统一致：boot / 光标绿色拖尾 / 磁吸 / 涟漪 /
   slice 页面切换 / handoff 光束 / 视差
   ============================================================================= */
(function () {
  "use strict";
  const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SIGNAL = "#d7ff3f";

  /* ---------------- boot 启动 ---------------- */
  function runBoot() {
    const boot = document.querySelector(".boot");
    if (!boot || REDUCED) return;
    const exit = () => {
      if (boot.dataset.done) return;
      boot.dataset.done = "1";
      boot.classList.add("exiting");
      boot.style.pointerEvents = "none";
      setTimeout(() => boot.remove(), 700);
    };
    boot.addEventListener("click", exit);
    setTimeout(exit, 3400);
  }

  /* ---------------- 光标绿色拖尾线（canvas 全屏） ---------------- */
  function initCursorLine() {
    if (REDUCED) return;
    const canvas = document.createElement("canvas");
    const s = canvas.style;
    s.position = "fixed"; s.left = "0"; s.top = "0";
    s.width = "100vw"; s.height = "100vh";
    s.pointerEvents = "none"; s.zIndex = "9999"; s.margin = "0"; s.padding = "0"; s.border = "0"; s.display = "block";
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0;
    function resize() {
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
    }
    resize();
    window.addEventListener("resize", resize);

    const trail = [];
    const MAX = 48;
    let lastSpawn = 0;
    let tx = W / 2, ty = H / 2, mx = tx, my = ty, raf = null;
    function spawn(x, y) { trail.push({ x, y, life: 1 }); if (trail.length > MAX) trail.shift(); }
    function step(ts) {
      mx += (tx - mx) * 0.22; my += (ty - my) * 0.22;
      if (ts - lastSpawn > 16) { spawn(mx, my); lastSpawn = ts; }
      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (let i = 0; i < trail.length - 1; i++) {
        const p0 = trail[i], p1 = trail[i + 1];
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
        ctx.strokeStyle = "rgba(215,255,63," + (p0.life * 0.85).toFixed(3) + ")";
        ctx.lineWidth = 2.5; ctx.stroke();
      }
      for (const p of trail) p.life *= 0.94;
      while (trail.length && trail[0].life < 0.05) trail.shift();
      ctx.beginPath(); ctx.arc(tx, ty, 3, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(215,255,63,0.95)"; ctx.fill();
      raf = requestAnimationFrame(step);
    }
    document.addEventListener("pointermove", e => {
      tx = e.clientX; ty = e.clientY;
      if (!raf) raf = requestAnimationFrame(step);
    });
    raf = requestAnimationFrame(step);
  }

  /* ---------------- 磁吸（鼠标放在元素上才磁吸，离开即回正） ---------------- */
  function initMagnetic() {
    if (REDUCED) return;
    document.addEventListener("pointermove", e => {
      document.querySelectorAll(".magnetic").forEach(el => {
        const r = el.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        if (x >= 0 && y >= 0 && x <= r.width && y <= r.height) {
          const hx = x / r.width - 0.5, hy = y / r.height - 0.5;
          el.style.transform = `perspective(800px) rotateX(${hy * -5}deg) rotateY(${hx * 5}deg) translate(${hx * 8}px, ${hy * 8}px)`;
        } else {
          el.style.transform = "perspective(800px) rotateX(0) rotateY(0) translate(0,0)";
        }
      });
    });
  }

  /* ---------------- 点击涟漪 ---------------- */
  function initRipple() {
    document.addEventListener("pointerdown", e => {
      const hit = e.target.closest(".ripple-host");
      if (!hit) return;
      const r = hit.getBoundingClientRect();
      const sp = document.createElement("span");
      sp.className = "ripple";
      sp.style.left = (e.clientX - r.left) + "px";
      sp.style.top = (e.clientY - r.top) + "px";
      hit.appendChild(sp);
      setTimeout(() => sp.remove(), 900);
    });
  }

  /* ---------------- slice 页面切换 ---------------- */
  function sliceRoute(href) {
    const ov = document.createElement("div");
    ov.className = "route-slice";
    ov.innerHTML = '<i></i><i class="shutter"></i>';
    document.body.appendChild(ov);
    setTimeout(() => { if (href) window.location.href = href; }, 480);
    setTimeout(() => ov.remove(), 980);
  }

  /* ---------------- handoff 光束（进入页面） ---------------- */
  function handoff(href) {
    const h = document.createElement("div");
    h.className = "handoff";
    h.innerHTML = '<div class="beam"></div><div class="cover"></div>';
    document.body.appendChild(h);
    setTimeout(() => { if (href) window.location.href = href; }, 620);
    setTimeout(() => h.remove(), 1100);
  }

  /* ---------------- 视差（主页 hero） ---------------- */
  function initParallax() {
    const hero = document.querySelector("[data-parallax]");
    if (!hero) return;
    document.addEventListener("pointermove", e => {
      const r = hero.getBoundingClientRect();
      hero.style.setProperty("--shift-x", ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
      hero.style.setProperty("--shift-y", ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
    });
  }

  /* ---------------- 进场 stagger ---------------- */
  function staggerEnter() {
    document.querySelectorAll(".enter-node").forEach((el, i) => {
      el.style.animationDelay = (i * 80) + "ms";
    });
  }

  window.Motion = { runBoot, initCursorLine, initMagnetic, initRipple, sliceRoute, handoff, initParallax, staggerEnter };
})();
