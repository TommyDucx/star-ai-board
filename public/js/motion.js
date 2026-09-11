/* =============================================================================
   S.T.A.R. motion —— 与原错题系统一致：boot / 光标绿色拖尾 / 磁吸 / 涟漪 /
   slice 页面切换 / handoff 光束 / 视差
   ============================================================================= */
(function () {
  "use strict";
  const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SIGNAL = "#d7ff3f";
  // 一次性绑定守卫：SPA/slice 切换或页面重复调用 init 时不重复挂监听（否则监听器泄漏）
  let rippleBound = false, magneticBound = false, parallaxBound = false;

  /* ---------------- boot 启动：一次引擎 UCI 握手的启动序列 ---------------- */
  function runBoot() {
    const boot = document.querySelector(".boot");
    if (!boot || REDUCED) return;
    const timers = [];
    const later = (fn, ms) => timers.push(setTimeout(fn, ms));

    // 1. 背景棋盘格闪烁（引擎扫描棋盘）
    const grid = document.createElement("div");
    grid.className = "boot-grid";
    for (let i = 0; i < 18; i++) {
      const c = document.createElement("span");
      c.className = "boot-cell";
      c.style.cssText = `left:${(5 + Math.random() * 86).toFixed(1)}%;top:${(6 + Math.random() * 82).toFixed(1)}%;` +
        `animation-delay:-${(Math.random() * 3.4).toFixed(2)}s;` +
        `animation-duration:${(2.8 + Math.random() * 2.2).toFixed(2)}s;`;
      grid.appendChild(c);
    }
    boot.prepend(grid);

    // 2. S.T.A.R. 解码锁定：从棋子 Unicode + hex 乱码逐位收敛（签名动效）
    const star = boot.querySelector(".w-s");
    let cancelScramble = null;
    if (star) {
      star.classList.add("decoding");
      const FINAL = "S.T.A.R.";
      const GLYPHS = "♔♕♖♗♘♙♚♛♜♝♞♟01<>/#$%&";
      const t0 = performance.now();
      const DUR = 900;
      let raf;
      const tick = now => {
        if (!star.isConnected) return;
        const p = Math.min(1, (now - t0) / DUR);
        const lockN = Math.floor(p * FINAL.length);
        let out = "";
        for (let i = 0; i < FINAL.length; i++) {
          out += i < lockN || FINAL[i] === "." ? FINAL[i]
            : GLYPHS[(Math.random() * GLYPHS.length) | 0];
        }
        star.textContent = out;
        if (p < 1) raf = requestAnimationFrame(tick);
        else { star.textContent = FINAL; star.classList.remove("decoding"); star.classList.add("locked"); }
      };
      raf = requestAnimationFrame(tick);
      later(() => raf && cancelAnimationFrame(raf), DUR + 300);
      cancelScramble = () => cancelAnimationFrame(raf);
    }

    // 3. UCI 握手日志（真实协议流程的启动叙事）
    const log = document.createElement("div");
    log.className = "boot-log";
    boot.appendChild(log);
    const LINES = [
      ["cmd", "> uci", ""],
      ["rsp", "< id name S.T.A.R. ENGINE", ""],
      ["rsp", "< uciok", "OK"],
      ["cmd", "> isready", ""],
      ["rsp", "< readyok", "OK"],
      ["cmd", "> go boot sequence", ""],
    ];
    let li = 0;
    const logTimer = setInterval(() => {
      if (li >= LINES.length || !log.isConnected) { clearInterval(logTimer); return; }
      const [cls, txt, ok] = LINES[li++];
      const d = document.createElement("div");
      d.className = "ln " + cls;
      d.innerHTML = `<span>${txt}</span>${ok ? `<span class="okk">${ok}</span>` : ""}`;
      log.appendChild(d);
    }, 185);
    timers.push(logTimer);

    // 4. 阶段 + 三段进度条 INIT → HANDSHAKE → READY
    const stage = document.createElement("div");
    stage.className = "boot-stage";
    stage.innerHTML = `<b>INIT</b><div class="boot-prog"><i></i></div>`;
    const inner = boot.querySelector(".boot-inner");
    if (inner) inner.appendChild(stage);
    const bar = stage.querySelector(".boot-prog i");
    const label = stage.querySelector("b");
    later(() => { bar.style.transform = "scaleX(.34)"; label.textContent = "HANDSHAKE"; }, 420);
    later(() => { bar.style.transform = "scaleX(.78)"; }, 1050);
    later(() => { bar.style.transform = "scaleX(1)"; label.textContent = "READY"; }, 2050);

    const exit = () => {
      if (boot.dataset.done) return;
      boot.dataset.done = "1";
      boot.classList.add("exiting");
      boot.style.pointerEvents = "none";
      timers.forEach(t => { clearTimeout(t); clearInterval(t); });
      if (cancelScramble) cancelScramble();
      // 内容升腾淡出 .34s → 幕布拉开 .62s(延迟.16s) ≈ 1.12s，留余量后移除
      setTimeout(() => boot.remove(), 950);
    };
    boot.addEventListener("click", exit);
    later(exit, 3400);
  }

  /* ---------------- 全站极光氛围层 ---------------- */
  function initAmbient() {
    if (REDUCED || document.querySelector(".aurora")) return;
    const a = document.createElement("div");
    a.className = "aurora";
    a.setAttribute("aria-hidden", "true");
    document.body.prepend(a);   // 置于内容流最前：z-index:0 垫底，screen 混合只提亮背景
    const v = document.createElement("div");   // CRT 暗角收边
    v.className = "vignette";
    v.setAttribute("aria-hidden", "true");
    document.body.appendChild(v);
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
      raf = null;
      const dx = tx - mx, dy = ty - my;
      mx += dx * 0.22; my += dy * 0.22;
      // 只在指针真的移动时才生成拖尾点——否则静止时拖尾永不消散，rAF 也永远停不下来
      if (ts - lastSpawn > 16 && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) { spawn(mx, my); lastSpawn = ts; }
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
      // 空闲收敛判定：拖尾散尽且平滑点已追上真实光标 → 停帧省电（下次 pointermove 唤醒）
      if (trail.length > 0 || Math.abs(tx - mx) > 0.6 || Math.abs(ty - my) > 0.6) {
        raf = requestAnimationFrame(step);
      }
    }
    document.addEventListener("pointermove", e => {
      tx = e.clientX; ty = e.clientY;
      if (!raf) raf = requestAnimationFrame(step);
    });
    raf = requestAnimationFrame(step);
  }

  /* ---------------- 磁吸（rAF 弹性插值：靠近渐吸、离开缓回，不再瞬跳） ----------------
     旧实现的问题：pointermove 里直接写 transform，出界瞬间归零——配合 0.12s CSS 过渡
     表现为「离开猛弹回、再进入猛吸过去」。现在改为目标值+每帧插值：
     激活半径内外都是连续函数，进入/离开全程丝滑；数值收敛后自动停帧省电。 */
  function initMagnetic() {
    if (REDUCED) return;
    if (window.matchMedia && !window.matchMedia("(hover: hover)").matches) return;   // 触屏无 hover 不启用
    if (magneticBound) { window.dispatchEvent(new Event("resize")); return; }   // 已绑定：仅触发重扫
    magneticBound = true;
    const MAX_TILT = 6, MAX_SHIFT = 10, LERP = 0.16, EPS = 0.002, EDGE = 48;
    let items = [];
    let raf = null;
    const scan = () => {
      items = [...document.querySelectorAll(".magnetic")].map(el => ({ el, nx: 0, ny: 0, tnx: 0, tny: 0 }));
    };
    scan();
    window.addEventListener("resize", scan);

    function frame() {
      raf = null;
      let dirty = false;
      for (const it of items) {
        if (!it.el.isConnected) { dirty = true; continue; }   // 元素被移除：本帧后重扫
        const dx = it.tnx - it.nx, dy = it.tny - it.ny;
        if (Math.abs(dx) > EPS || Math.abs(dy) > EPS) {
          it.nx += dx * LERP; it.ny += dy * LERP;
          dirty = true;
        } else if (it.nx !== it.tnx || it.ny !== it.tny) {
          it.nx = it.tnx; it.ny = it.tny; dirty = true;
        }
        const rx = (-it.ny * 2 * MAX_TILT).toFixed(3);
        const ry = (it.nx * 2 * MAX_TILT).toFixed(3);
        const tx = (it.nx * 2 * MAX_SHIFT).toFixed(2);
        const ty = (it.ny * 2 * MAX_SHIFT).toFixed(2);
        it.el.style.transform =
          `perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg) translate(${tx}px, ${ty}px)`;
      }
      if (dirty) {
        if (items.some(i => !i.el.isConnected)) scan();
        raf = requestAnimationFrame(frame);
      }
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

    document.addEventListener("pointermove", e => {
      for (const it of items) {
        if (!it.el.isConnected) continue;
        const r = it.el.getBoundingClientRect();
        const cx = e.clientX - (r.left + r.width / 2);
        const cy = e.clientY - (r.top + r.height / 2);
        const R = Math.hypot(r.width, r.height) / 2 + EDGE;   // 激活半径=元素外接圆+缓冲带
        const dist = Math.hypot(cx, cy);
        if (dist < R) {
          // 钟形衰减：元素中心附近最强，到激活边界平滑归零——进出都没有突变点
          const fall = 1 - dist / R;
          it.tnx = (cx / (r.width / 2)) * 0.5 * fall;
          it.tny = (cy / (r.height / 2)) * 0.5 * fall;
        } else {
          it.tnx = 0; it.tny = 0;
        }
      }
      kick();
    });
    // 鼠标离开窗口/切标签页：全部目标归零，卡片缓缓回正
    document.documentElement.addEventListener("pointerleave", () => {
      for (const it of items) { it.tnx = 0; it.tny = 0; }
      kick();
    });
    window.addEventListener("blur", () => {
      for (const it of items) { it.tnx = 0; it.tny = 0; }
      kick();
    });
  }

  /* ---------------- 进场 stagger ---------------- */
  function staggerEnter() {
    document.querySelectorAll(".enter-node").forEach((el, i) => {
      el.style.animationDelay = (i * 80) + "ms";
    });
  }

  /* ---------------- data-nav 导航委托（集中绑定，替代各页内联循环） ----------------
     修饰键点击（Cmd/Ctrl/Shift/Alt）与非左键放行给浏览器默认行为——保住"新标签页打开"；
     连点叠层与减动效直跳由 sliceRoute 内部处理。 */
  function wireNav() {
    document.addEventListener("click", e => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target && e.target.closest ? e.target.closest("[data-nav]") : null;
      if (!a) return;
      e.preventDefault();
      sliceRoute(a.getAttribute("href"));
    });
  }

  /* ---------------- 点击涟漪 ---------------- */
  function initRipple() {
    if (REDUCED || rippleBound) return;   // 减动效下动画被禁用，涟漪只剩一个不消失的小圈
    rippleBound = true;
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
  let routing = false;
  function sliceRoute(href) {
    if (routing) return;                 // 切换动画进行中忽略后续触发：防叠层、防中途改道
    routing = true;
    // 减动效偏好下 CSS 动画被禁用，覆盖层会变成静态全屏色块挡脸——直接跳转
    if (REDUCED) { if (href) window.location.href = href; return; }
    const ov = document.createElement("div");
    ov.className = "route-slice";
    ov.innerHTML = '<i></i><i class="shutter"></i>';
    document.body.appendChild(ov);
    setTimeout(() => { if (href) window.location.href = href; }, 480);
    // 导航失败(离线等)也要复位，允许重试
    setTimeout(() => { ov.remove(); routing = false; }, 980);
  }

  /* ---------------- handoff 光束（进入页面） ---------------- */
  let handingOff = false;
  function handoff(href) {
    if (handingOff) return;
    handingOff = true;
    if (REDUCED) { if (href) window.location.href = href; return; }
    const h = document.createElement("div");
    h.className = "handoff";
    h.innerHTML = '<div class="beam"></div><div class="beam echo"></div><div class="cover"></div>';
    document.body.appendChild(h);
    setTimeout(() => { if (href) window.location.href = href; }, 620);
    setTimeout(() => { h.remove(); handingOff = false; }, 1100);
  }

  /* ---------------- 视差（主页 hero） ---------------- */
  function initParallax() {
    if (parallaxBound) return;
    parallaxBound = true;
    document.addEventListener("pointermove", e => {
      // hero 可能被 main.html 动态重建：每次事件都重新查询，缺席则跳过（勿缓存旧节点）
      const hero = document.querySelector("[data-parallax]");
      if (!hero) return;
      const r = hero.getBoundingClientRect();
      hero.style.setProperty("--shift-x", ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
      hero.style.setProperty("--shift-y", ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
    });
  }

  /* ---------------- FX 粒子层：吃子碎裂等棋盘特效 ---------------- */
  function initFx() {
    if (REDUCED) return;
    const cv = document.createElement("canvas");
    cv.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:88;margin:0;padding:0;border:0;display:block";
    document.body.appendChild(cv);
    const ctx = cv.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0, H = 0;
    const resize = () => {
      W = window.innerWidth; H = window.innerHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    let parts = [], raf = null;
    function step() {
      raf = null;
      ctx.clearRect(0, 0, W, H);
      parts = parts.filter(p => p.life > 0);
      for (const p of parts) {
        p.vy += 0.16;                       // 重力
        p.x += p.vx; p.y += p.vy;
        p.rot += p.vr; p.life -= 0.021;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }
      if (parts.length) raf = requestAnimationFrame(step);
      else ctx.clearRect(0, 0, W, H);       // 收尾清屏后停帧
    }
    window.Motion.fx = {
      burst(x, y, colors) {
        for (let i = 0; i < 16; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 1.6 + Math.random() * 3.6;
          parts.push({
            x, y,
            vx: Math.cos(a) * sp,
            vy: Math.sin(a) * sp - 1.9,     // 初始略向上抛更有爆发感
            size: 3 + Math.random() * 5,
            rot: Math.random() * Math.PI,
            vr: (Math.random() - .5) * .32,
            life: 1,
            color: colors[(Math.random() * colors.length) | 0],
          });
        }
        if (!raf) raf = requestAnimationFrame(step);
      },
    };
  }

  /* ---------------- 全站导航壳 ----------------
     左上角品牌始终回首页；非首页额外给出“返回上一页”，直接打开时退回首页。
     这样棋盘、成长中心与后台不会各自长出不一致的返回逻辑。 */
  function initSiteShell() {
    const path = window.location.pathname;
    const inAdmin = path.startsWith("/admin/");
    // 只有站点根首页才不显示返回按钮；/admin/index.html 仍属于后台页。
    const isHome = path === "/" || path === "/index.html";
    const home = inAdmin ? "../index.html" : "index.html";
    const sameOriginReferrer = () => {
      try { return !!document.referrer && new URL(document.referrer).origin === location.origin; }
      catch (_) { return false; }
    };
    const makeBack = () => {
      const back = document.createElement("a");
      back.className = "site-back";
      back.href = home;
      back.dataset.nav = "";
      back.textContent = "← 返回";
      back.setAttribute("aria-label", "返回上一页");
      back.addEventListener("click", event => {
        if (sameOriginReferrer() && history.length > 1) { event.preventDefault(); history.back(); }
      });
      return back;
    };

    document.querySelectorAll(".topbar .logo").forEach(logo => {
      if (logo.tagName === "A") { logo.href = home; logo.dataset.nav = ""; }
    });
    document.querySelectorAll(".sb-logo").forEach(logo => {
      if (logo.tagName === "A") { logo.href = home; logo.dataset.nav = ""; }
    });

    if (!isHome) {
      const bar = document.querySelector(".topbar");
      if (bar && !bar.querySelector(".site-back")) {
        const anchor = bar.querySelector(".crumb") || bar.firstElementChild;
        bar.insertBefore(makeBack(), anchor || null);
      } else if (!bar && !document.querySelector(".site-corner-nav")) {
        const nav = document.createElement("nav");
        nav.className = "site-corner-nav";
        nav.setAttribute("aria-label", "页面导航");
        const homeLink = document.createElement("a");
        homeLink.href = home; homeLink.dataset.nav = ""; homeLink.textContent = "⌂ 主页";
        nav.append(homeLink, makeBack());
        document.body.prepend(nav);
      }
    }
  }

  window.Motion = { runBoot, initCursorLine, initMagnetic, initRipple, sliceRoute, handoff, initParallax, staggerEnter, wireNav, initSiteShell };
  // 初始化放导出之后：initFx 要往 window.Motion 上挂 fx 接口
  /* ---------------- SFX 音效引擎：Web Audio 程序化合成，零音频资源 ---------------- */
  function initSfx() {
    const KEY = "star_sfx";
    let enabled = localStorage.getItem(KEY) !== "off";
    let ctx = null, nb = null;
    const ac = () => {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      return ctx.state === "running" ? ctx : null;
    };
    // 浏览器策略：首次用户手势解锁 AudioContext
    document.addEventListener("pointerdown", () => ac(), { passive: true });
    const noise = c => {
      if (!nb) {
        nb = c.createBuffer(1, Math.floor(c.sampleRate * 0.2), c.sampleRate);
        const d = nb.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      return nb;
    };
    const play = fn => {
      if (!enabled) return;
      const c = ac();
      if (!c) return;
      try { fn(c, c.currentTime); } catch (e) {}
    };
    // 单音：振荡器 + 指数衰减包络
    const blip = (c, t, { type = "sine", f0 = 600, f1 = f0, dur = .08, vol = .2 }) => {
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(.0001, t + dur);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + dur + .02);
    };
    // 敲击：白噪声过滤波器
    const knock = (c, t, { dur = .06, vol = .22, freq = 900 }) => {
      const src = c.createBufferSource(); src.buffer = noise(c);
      const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = freq;
      const g = c.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(.0001, t + dur);
      src.connect(f).connect(g).connect(c.destination);
      src.start(t); src.stop(t + dur + .02);
    };

    window.Motion.sfx = {
      get enabled() { return enabled; },
      setEnabled(v) { enabled = !!v; localStorage.setItem(KEY, v ? "on" : "off"); },
      // 国际象棋：木质落子
      move() { play((c, t) => { knock(c, t, { dur: .05, vol: .17, freq: 750 }); blip(c, t, { type: "triangle", f0: 175, f1: 92, dur: .07, vol: .14 }); }); },
      // 吃子：更重更脆的双层
      capture() { play((c, t) => { knock(c, t, { dur: .07, vol: .3, freq: 1400 }); blip(c, t, { type: "square", f0: 330, f1: 135, dur: .09, vol: .15 }); knock(c, t + .035, { dur: .05, vol: .18, freq: 700 }); }); },
      // 王车易位：两声错开的落子
      castle() { play((c, t) => { knock(c, t, { dur: .05, vol: .15, freq: 750 }); knock(c, t + .09, { dur: .05, vol: .17, freq: 800 }); }); },
      // 围棋：标志性「啪嗒」石子声（高频瞬态 + 体腔共鸣）
      stone() { play((c, t) => { knock(c, t, { dur: .018, vol: .2, freq: 3200 }); blip(c, t, { type: "sine", f0: 1860, f1: 1480, dur: .07, vol: .2 }); knock(c, t + .004, { dur: .055, vol: .22, freq: 280 }); }); },
      // 将军：两声短促警示
      check() { play((c, t) => { blip(c, t, { type: "square", f0: 715, dur: .055, vol: .1 }); blip(c, t + .115, { type: "square", f0: 715, dur: .055, vol: .1 }); }); },
      // 将杀：三连下行
      mate() { play((c, t) => { [520, 392, 261].forEach((f, i) => blip(c, t + i * .17, { type: "sawtooth", f0: f, dur: .28, vol: .12 })); }); },
      // UI 微咔（复盘步进等）
      tick() { play((c, t) => knock(c, t, { dur: .018, vol: .07, freq: 2000 })); },
    };

    // 顶栏音效开关（自动注入，状态持久化）
    const bar = document.querySelector(".topbar");
    if (!document.getElementById("sfxBtn")) {
      const b = document.createElement("button");
      b.id = "sfxBtn";
      b.className = "btn";
      b.style.cssText = bar ? "min-width:46px;text-align:center;flex:none"
        : "position:fixed;right:16px;bottom:16px;z-index:70;min-width:46px;text-align:center;border-radius:20px;padding:8px 12px;box-shadow:0 4px 18px rgba(0,0,0,.45)";
      const paint = () => { b.textContent = enabled ? "🔊" : "🔇"; b.title = "音效开关"; };
      b.addEventListener("click", e => {
        e.stopPropagation();
        Motion.sfx.setEnabled(!Motion.sfx.enabled);
        paint();
        if (Motion.sfx.enabled) Motion.sfx.tick();
      });
      paint();
      (bar || document.body).appendChild(b);
    }
  }

  wireNav();   // 委托绑定：脚本加载即生效，无需各页重复内联
  initSiteShell();
  initAmbient();
  initFx();
  initSfx();
})();
