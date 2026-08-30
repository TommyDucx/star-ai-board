// admin.js — 后台前端逻辑（vanilla JS，无框架依赖）
(function () {
  "use strict";
  const state = { role: null, username: null, view: "dashboard", timer: null, switching: false };

  const $ = (s, r) => (r || document).querySelector(s);
  const view = $("#view");
  const titleEl = $("#view-title");
  const roleBadge = $("#role-badge");
  const sbUser = $("#sb-user");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toast(msg) {
    let t = $(".toast");
    if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2200);
  }
  // 与服务端一致的口令策略：8-128 位，且含大写、小写、数字
  function validPassword(pw) {
    return typeof pw === "string" && pw.length >= 8 && pw.length <= 128 &&
      /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /\d/.test(pw);
  }
  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {}));
    let data = {};
    try { data = await r.json(); } catch (e) {}
    if (r.status === 401) { location.href = "login.html"; throw new Error("unauthorized"); }
    // 服务端强制改密硬拦截（403 mustChange）：直接弹窗引导，而不是静默失败
    if (r.status === 403 && data.mustChange) { showPwModal(); throw new Error("mustChange"); }
    return { ok: r.ok, status: r.status, data };
  }
  function fmtUptime(s) {
    s = Math.floor(s);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60);
    return (d ? d + "天 " : "") + h + "时" + (d ? "" : m + "分");
  }

  // 每次渲染后的公共钩子：磁吸重扫 + 延迟修正（无动画重放；动画仅在视图切换时重放）
  function rescanFx() {
    if (!window.Motion) return;
    Motion.staggerEnter();
    window.dispatchEvent(new Event("resize"));   // initMagnetic 靠 resize 重扫 .magnetic（含新渲染元素）
  }
  // 视图切换时重放进场动画（clip-path 展开）
  function animView() {
    if (!window.Motion) return;
    const v = $("#view");
    v.classList.remove("enter-node"); void v.offsetWidth; v.classList.add("enter-node");
    Motion.staggerEnter();
  }
  function afterRender() {
    rescanFx();
    if (state.switching) { state.switching = false; animView(); }
  }

  // ---------- 视图路由 ----------
  const TITLES = { dashboard: "数据看板", profile: "个人资料", accounts: "账号管理", engines: "引擎管理", announce: "公告管理" };
  // 视图可见性（前端 UX；服务端仍按 RBAC 强制）
  function canView(v) {
    if (v === "dashboard") return state.role !== "member";        // member 默认进入个人资料
    if (v === "accounts" || v === "engines" || v === "announce") return state.role === "admin" || state.role === "editor";
    return true; // profile 所有人可见
  }
  function switchView(v) {
    if (!canView(v)) { toast("无访问权限"); return; }
    state.view = v;
    titleEl.textContent = TITLES[v] || "";
    document.querySelectorAll(".sb-item").forEach(b => b.classList.toggle("active", b.dataset.view === v));
    $("#sidebar").classList.remove("open");
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.switching = true;   // 本次渲染完成后重放进场动画（自动刷新不会触发）
    if (v === "dashboard") renderDashboard();
    else if (v === "profile") renderProfile();
    else if (v === "accounts") renderAccounts();
    else if (v === "engines") renderEngines();
    else if (v === "announce") renderAnnounce();
  }

  // ---------- 看板 ----------
  async function renderDashboard() {
    let m = {}, g = { total: 0, byEngine: {}, byType: {}, last24h: [] };
    try {
      const [rm, rg] = await Promise.all([api("/api/admin/metrics"), api("/api/admin/games")]);
      m = rm.data; g = rg.data;
    } catch (e) { return; }
    const online = (m.engines || []).filter(e => e.alive).length;
    const memPct = m.mem ? m.mem.percent : 0;
    const diskPct = m.disk ? m.disk.percent : 0;
    const cpuCls = m.cpu > 85 ? "danger" : m.cpu > 60 ? "warn" : "";
    const memCls = memPct > 85 ? "danger" : memPct > 60 ? "warn" : "";
    view.innerHTML = `
      <div class="grid metrics">
        <div class="card metric magnetic"><div class="m-label">CPU 占用</div>
          <div class="m-val">${m.cpu != null ? m.cpu : "—"}<small>%</small></div>
          <div class="bar-track"><i class="${cpuCls}"></i></div></div>
        <div class="card metric magnetic"><div class="m-label">内存</div>
          <div class="m-val">${memPct}<small>%</small></div>
          <div class="bar-track"><i class="${memCls}"></i></div>
          <div class="muted" style="font-size:11px;margin-top:6px">${fmtBytes(m.mem && m.mem.used)} / ${fmtBytes(m.mem && m.mem.total)}</div></div>
        <div class="card metric magnetic"><div class="m-label">磁盘 /</div>
          <div class="m-val">${diskPct}<small>%</small></div>
          <div class="bar-track"><i class="${diskPct > 85 ? "danger" : diskPct > 60 ? "warn" : "cyan"}"></i></div>
          <div class="muted" style="font-size:11px;margin-top:6px">${fmtBytes(m.disk && m.disk.used)} / ${fmtBytes(m.disk && m.disk.total)}</div></div>
        <div class="card metric magnetic"><div class="m-label">运行时间</div>
          <div class="m-val" style="font-size:22px">${fmtUptime(m.uptime || 0)}</div>
          <div class="muted" style="font-size:11px;margin-top:6px">${esc(m.hostname || "")}</div></div>
        <div class="card metric magnetic"><div class="m-label">在线引擎</div>
          <div class="m-val">${online}<small>/ ${(m.engines || []).length}</small></div>
          <div class="muted" style="font-size:11px;margin-top:6px">load ${((m.loadavg || [])[0] || 0).toFixed(2)}</div></div>
        <div class="card metric magnetic"><div class="m-label">累计分析</div>
          <div class="m-val">${g.total}</div>
          <div class="muted" style="font-size:11px;margin-top:6px">近24h ${g.last24h ? g.last24h.reduce((a, b) => a + b, 0) : 0} 次</div></div>
      </div>

      <div class="section-title">近 24 小时分析量</div>
      <div class="panel chart">${lineChart(g.last24h || [])}
        <div class="legend"><span><i style="background:var(--cyan)"></i>每小时分析次数</span></div></div>

      <div class="grid" style="grid-template-columns:1fr 1fr; margin-top:14px">
        <div class="panel"><h3>按引擎分布</h3>${barChart(g.byEngine || {})}</div>
        <div class="panel"><h3>按类型分布</h3>${barChart(g.byType || {})}</div>
      </div>

      <div class="section-title">引擎状态</div>
      <div class="panel"><table>
        <thead><tr><th>引擎</th><th>类型</th><th>可用</th><th>存活</th></tr></thead>
        <tbody>${(m.engines || []).map(e => `<tr>
          <td>${esc(e.key)}</td><td>${esc(e.kind)}</td>
          <td>${e.available ? '<span class="tag on">可用</span>' : '<span class="tag off">不可用</span>'}</td>
          <td>${e.alive ? '<span class="tag on">运行中</span>' : '<span class="tag off">空闲</span>'}</td>
        </tr>`).join("")}</tbody>
      </table></div>`;
    // 进度条宽度
    setBarWidth(view, ".metric:nth-child(1) .bar-track i", m.cpu);
    setBarWidth(view, ".metric:nth-child(2) .bar-track i", memPct);
    setBarWidth(view, ".metric:nth-child(3) .bar-track i", diskPct);
    afterRender();
    state.timer = setInterval(renderDashboard, 5000);
  }
  function setBarWidth(root, sel, pct) { const el = $(sel, root); if (el) el.style.width = Math.max(0, Math.min(100, pct || 0)) + "%"; }
  function fmtBytes(b) {
    if (!b) return "0 B";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return b.toFixed(i ? 1 : 0) + " " + u[i];
  }
  function lineChart(arr) {
    const w = 680, h = 180, pad = 28;
    const max = Math.max(1, ...arr);
    const n = arr.length || 1;
    const pts = arr.map((v, i) => {
      const x = pad + (w - 2 * pad) * (i / (n - 1 || 1));
      const y = h - pad - (h - 2 * pad) * (v / max);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="height:180px">
      <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="#26301f"/>
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="#26301f"/>
      <polyline points="${pts}" fill="none" stroke="#2ed3ff" stroke-width="2.5"/>
      ${arr.map((v, i) => { const x = pad + (w - 2 * pad) * (i / (n - 1 || 1)); const y = h - pad - (h - 2 * pad) * (v / max); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="#2ed3ff"/>`; }).join("")}
    </svg>`;
  }
  function barChart(obj) {
    const entries = Object.entries(obj).filter(([, v]) => v > 0);
    if (!entries.length) return '<div class="empty">暂无数据</div>';
    const max = Math.max(...entries.map(([, v]) => v));
    return `<div style="display:flex;flex-direction:column;gap:10px">${entries.map(([k, v]) =>
      `<div><div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px">
        <span>${esc(k)}</span><span class="muted">${v}</span></div>
        <div class="bar-track" style="margin:0"><i class="cyan" style="width:${(v / max * 100).toFixed(1)}%"></i></div></div>`
    ).join("")}</div>`;
  }

  // ---------- 账号管理 ----------
  const ROLE_OPTS = ["member", "viewer", "editor", "admin"];
  async function renderAccounts() {
    let r;
    try { r = await api("/api/admin/accounts"); } catch (e) { return; }
    const list = r.data.accounts || [];
    view.innerHTML = `
      <div class="panel" style="margin-bottom:16px">
        <h3>新建账号</h3>
        <div class="form-row">
          <div class="field"><label>账号</label><input id="nu" placeholder="用户名（2-32 位）"></div>
          <div class="field"><label>密码</label><input id="np" type="password" placeholder="8+ 位，含大小写与数字"></div>
          <div class="field"><label>角色</label>
            <select id="nr">${ROLE_OPTS.map(r => `<option value="${r}">${r}</option>`).join("")}</select></div>
          <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn primary ripple-host" id="create-btn">＋ 创建</button></div>
        </div>
        <div id="acc-err" class="login-err"></div>
      </div>
      <div class="panel"><table>
        <thead><tr><th>账号</th><th>角色</th><th>邮箱/手机</th><th>创建时间</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${list.map(a => `<tr>
          <td>${esc(a.username)}</td>
          <td><span class="tag ${a.role}">${a.role}</span></td>
          <td class="muted">${esc(a.email || a.phone || "—")}${a.isVerified ? ' <span class="tag on" style="font-size:10px">已验证</span>' : ' <span class="tag warn" style="font-size:10px">未验证</span>'}</td>
          <td class="muted">${new Date(a.createdAt).toLocaleString("zh-CN")}</td>
          <td>${a.status === "suspended" ? '<span class="tag off">已停用</span>' : a.mustChange ? '<span class="tag warn">需改密</span>' : '<span class="tag on">正常</span>'}</td>
          <td><div class="row-actions">
            <select class="btn sm role-sel" data-u="${esc(a.username)}" ${a.username === state.username ? "disabled" : ""}>
              ${ROLE_OPTS.map(r => `<option value="${r}" ${a.role === r ? "selected" : ""}>${r}</option>`).join("")}</select>
            <select class="btn sm status-sel" data-u="${esc(a.username)}" ${a.username === state.username ? "disabled" : ""}>
              <option value="active" ${a.status === "active" ? "selected" : ""}>正常</option>
              <option value="suspended" ${a.status === "suspended" ? "selected" : ""}>停用</option>
              <option value="unverified" ${a.status === "unverified" ? "selected" : ""}>未验证</option>
            </select>
            <button class="btn sm pw-btn" data-u="${esc(a.username)}">改密</button>
            <button class="btn sm danger del-btn" data-u="${esc(a.username)}" ${a.username === state.username ? "disabled" : ""}>删除</button>
          </div></td>
        </tr>`).join("")}</tbody>
      </table></div>`;
    $("#create-btn").onclick = createAccount;
    view.querySelectorAll(".role-sel").forEach(s => s.onchange = () => changeRole(s.dataset.u, s.value));
    view.querySelectorAll(".status-sel").forEach(s => s.onchange = () => changeStatus(s.dataset.u, s.value));
    view.querySelectorAll(".pw-btn").forEach(b => b.onclick = () => changePw(b.dataset.u));
    view.querySelectorAll(".del-btn").forEach(b => b.onclick = () => delAccount(b.dataset.u));
    afterRender();
  }
  async function createAccount() {
    const username = $("#nu").value.trim(), password = $("#np").value, role = $("#nr").value;
    const err = $("#acc-err"); err.textContent = "";
    if (!validPassword(password)) { err.textContent = "密码需 8-128 位，且含大写、小写与数字"; return; }
    const r = await api("/api/admin/accounts", { method: "POST", body: JSON.stringify({ username, password, role }) });
    if (!r.ok) { err.textContent = r.data.error || "创建失败"; return; }
    toast("已创建 " + username); renderAccounts();
  }
  async function changeRole(u, role) {
    const r = await api("/api/admin/accounts/" + encodeURIComponent(u), { method: "PUT", body: JSON.stringify({ role }) });
    if (!r.ok) { toast(r.data.error || "失败"); renderAccounts(); return; }
    toast(u + " → " + role);
  }
  async function changeStatus(u, status) {
    const r = await api("/api/admin/accounts/" + encodeURIComponent(u), { method: "PUT", body: JSON.stringify({ status }) });
    if (!r.ok) { toast(r.data.error || "失败"); renderAccounts(); return; }
    toast(u + " · " + status);
  }
  async function changePw(u) {
    const pw = prompt("为 " + u + " 设置新密码（8+ 位，含大小写与数字）：");
    if (!pw) return;
    const r = await api("/api/admin/accounts/" + encodeURIComponent(u), { method: "PUT", body: JSON.stringify({ password: pw }) });
    toast(r.ok ? "密码已更新" : (r.data.error || "失败"));
  }
  async function delAccount(u) {
    if (!confirm("确定删除账号 " + u + "？")) return;
    const r = await api("/api/admin/accounts/" + encodeURIComponent(u), { method: "DELETE" });
    if (!r.ok) { toast(r.data.error || "失败"); return; }
    toast("已删除 " + u); renderAccounts();
  }

  // ---------- 引擎管理 ----------
  async function renderEngines() {
    let r;
    try { r = await api("/api/admin/engines"); } catch (e) { return; }
    const list = r.data.engines || [];
    view.innerHTML = `<div class="panel"><table>
      <thead><tr><th>引擎</th><th>类型</th><th>可用</th><th>存活</th><th>操作</th></tr></thead>
      <tbody>${list.map(e => `<tr>
        <td>${esc(e.key)}</td><td>${esc(e.kind)}</td>
        <td>${e.available ? '<span class="tag on">可用</span>' : '<span class="tag off">不可用</span>'}</td>
        <td>${e.alive ? '<span class="tag on">运行中</span>' : '<span class="tag off">空闲</span>'}</td>
        <td><div class="row-actions">
          <button class="btn sm" data-act="start" data-k="${esc(e.key)}">启动</button>
          <button class="btn sm danger" data-act="stop" data-k="${esc(e.key)}">停止</button>
        </div></td>
      </tr>`).join("")}</tbody>
    </table>
    <div class="muted" style="font-size:11.5px;margin-top:12px">说明：引擎为懒启动，空闲数分钟自动回收。停止后下次分析会重新拉起。</div></div>`;
    view.querySelectorAll("button[data-act]").forEach(b => b.onclick = async () => {
      const k = b.dataset.k, act = b.dataset.act;
      b.disabled = true;
      const r2 = await api("/api/admin/engine/" + encodeURIComponent(k) + "/" + act, { method: "POST" });
      toast(r2.ok ? (act === "stop" ? "已停止 " : "已启动 ") + k : (r2.data.error || "失败"));
      renderEngines();
    });
    afterRender();
  }

  // ---------- 公告管理 ----------
  async function renderAnnounce() {
    let cur = { text: "", enabled: false };
    try { const r = await api("/api/announcement"); cur = r.data; } catch (e) {}
    view.innerHTML = `<div class="panel" style="max-width:640px">
      <h3>站点公告</h3>
      <p class="muted" style="font-size:12.5px">启用后会在公开首页顶部显示（仅启用且内容非空时显示）。</p>
      <div class="field"><label>公告内容（最多 500 字）</label>
        <textarea id="ann-text" placeholder="例如：系统将于今晚 23:00 维护…">${esc(cur.text || "")}</textarea></div>
      <label class="switch"><input type="checkbox" id="ann-en" ${cur.enabled ? "checked" : ""}> 启用公告</label>
      <div style="margin-top:16px"><button class="btn primary ripple-host" id="ann-save">保存</button></div>
      <div id="ann-err" class="login-err"></div>
    </div>`;
    afterRender();
    $("#ann-save").onclick = async () => {
      const r = await api("/api/admin/announcement", {
        method: "PUT",
        body: JSON.stringify({ text: $("#ann-text").value, enabled: $("#ann-en").checked }),
      });
      toast(r.ok ? "已保存" : (r.data.error || "失败"));
    };
  }

  // ---------- 个人资料 / 会话管理 ----------
  async function renderProfile() {
    let me = {}, ses = { sessions: [] };
    try {
      const [rm, rs] = await Promise.all([api("/api/me"), api("/api/me/sessions")]);
      me = rm.data; ses = rs.data;
    } catch (e) { return; }
    const verifiedTag = me.isVerified
      ? '<span class="tag on">已验证</span>' : '<span class="tag warn">未验证</span>';
    const statusTag = me.status === "suspended" ? '<span class="tag off">已停用</span>'
      : me.mustChange ? '<span class="tag warn">需改密</span>' : '<span class="tag on">正常</span>';
    view.innerHTML = `
      <div class="grid" style="grid-template-columns:1fr 1fr; gap:16px; align-items:start">
        <div class="panel">
          <h3>账号信息</h3>
          <table style="border:none">
            <tbody>
              <tr><td class="muted" style="border:none;width:96px">用户名</td><td style="border:none"><b>${esc(me.username)}</b></td></tr>
              <tr><td class="muted" style="border:none">角色</td><td style="border:none"><span class="tag ${me.role}">${me.role}</span></td></tr>
              <tr><td class="muted" style="border:none">邮箱</td><td style="border:none">${esc(me.email || "—")}</td></tr>
              <tr><td class="muted" style="border:none">手机</td><td style="border:none">${esc(me.phone || "—")}</td></tr>
              <tr><td class="muted" style="border:none">验证状态</td><td style="border:none">${verifiedTag}</td></tr>
              <tr><td class="muted" style="border:none">账号状态</td><td style="border:none">${statusTag}</td></tr>
              <tr><td class="muted" style="border:none">注册时间</td><td style="border:none">${me.createdAt ? new Date(me.createdAt).toLocaleString("zh-CN") : "—"}</td></tr>
              <tr><td class="muted" style="border:none">上次登录</td><td style="border:none">${me.lastLoginAt ? new Date(me.lastLoginAt).toLocaleString("zh-CN") : "—"}</td></tr>
            </tbody>
          </table>
        </div>

        <div class="panel">
          <h3>修改密码</h3>
          <div class="field"><label>当前/新密码（8+ 位，含大小写与数字）</label>
            <input type="password" id="npw" placeholder="新密码"></div>
          <div class="field"><label>确认新密码</label>
            <input type="password" id="npw2" placeholder="再次输入"></div>
          <div id="pw2-err" class="login-err"></div>
          <button class="btn primary ripple-host" id="save-pw">保存新密码</button>
        </div>

        <div class="panel">
          <h3>验证联系方式</h3>
          <p class="muted" style="font-size:12px;margin:0 0 12px">绑定并验证邮箱/手机，可用于找回密码。</p>
          <div class="form-row">
            <div class="field"><label>类型</label>
              <select id="vtype"><option value="email">邮箱</option><option value="phone">手机</option></select></div>
            <div class="field"><label>联系方式</label>
              <input type="text" id="vcontact" placeholder="邮箱或手机号"></div>
          </div>
          <div class="form-row">
            <div class="field"><label>验证码</label>
              <input type="text" id="vcode" placeholder="6 位" maxlength="6"></div>
            <div class="field" style="flex:0"><label>&nbsp;</label>
              <button class="btn ripple-host" id="vsend" style="white-space:nowrap">获取验证码</button></div>
          </div>
          <div id="v-err" class="login-err"></div>
          <div id="v-hint"></div>
          <button class="btn primary ripple-host" id="vverify">验证并绑定</button>
        </div>

        <div class="panel">
          <h3>登录设备（会话）</h3>
          <p class="muted" style="font-size:12px;margin:0 0 12px">当前账号的所有登录设备。可一键退出其他设备。</p>
          <div id="sess-list"></div>
          <div style="margin-top:12px"><button class="btn danger ripple-host" id="logout-others">退出所有其他设备</button></div>
        </div>
      </div>`;
    renderSessList(ses.sessions || []);

    $("#save-pw").onclick = async () => {
      const pw = $("#npw").value, pw2 = $("#npw2").value, err = $("#pw2-err");
      err.textContent = "";
      if (pw !== pw2) { err.textContent = "两次输入不一致"; return; }
      if (!validPassword(pw)) { err.textContent = "密码需 8-128 位，且含大写、小写与数字"; return; }
      const r = await api("/api/me", { method: "PUT", body: JSON.stringify({ password: pw }) });
      if (!r.ok) { err.textContent = r.data.error || "失败"; return; }
      toast("密码已更新"); $("#npw").value = ""; $("#npw2").value = "";
    };

    let vCool = 0, vTimer = null;
    $("#vsend").onclick = async () => {
      const err = $("#v-err"), hint = $("#v-hint"); err.textContent = ""; hint.innerHTML = "";
      const contactType = $("#vtype").value, contact = $("#vcontact").value.trim();
      if (!contact) { err.textContent = "请填写联系方式"; return; }
      $("#vsend").disabled = true;
      const r = await api("/api/auth/send-code", { method: "POST", body: JSON.stringify({ type: "verify", contactType, contact }) });
      const d = await r.data;
      if (!r.ok) { err.textContent = d.error || "发送失败"; $("#vsend").disabled = false; return; }
      if (d.dev && d.code) hint.innerHTML = '<div class="code-hint">本地模式验证码：<b>' + d.code + '</b></div>';
      else hint.innerHTML = '<div class="code-hint">验证码已发送</div>';
      vCool = 60; $("#vsend").textContent = vCool + " 秒后重发";
      vTimer = setInterval(() => { vCool--; if (vCool <= 0) { clearInterval(vTimer); $("#vsend").disabled = false; $("#vsend").textContent = "获取验证码"; } else $("#vsend").textContent = vCool + " 秒后重发"; }, 1000);
    };
    $("#vverify").onclick = async () => {
      const err = $("#v-err"); err.textContent = "";
      const contactType = $("#vtype").value, contact = $("#vcontact").value.trim(), code = $("#vcode").value.trim();
      const r = await api("/api/me/verify", { method: "POST", body: JSON.stringify({ contactType, contact, code }) });
      if (!r.ok) { err.textContent = r.data.error || "验证失败"; return; }
      toast("已验证并绑定"); renderProfile();
    };
    $("#logout-others").onclick = async () => {
      const r = await api("/api/me/sessions", { method: "DELETE" });
      toast(r.ok ? ("已退出 " + (r.data.removed || 0) + " 台其他设备") : (r.data.error || "失败"));
      renderProfile();
    };
    afterRender();
  }
  function renderSessList(list) {
    const el = $("#sess-list"); if (!el) return;
    if (!list.length) { el.innerHTML = '<div class="empty">暂无会话</div>'; return; }
    el.innerHTML = `<table style="border:none"><tbody>${list.map(s => `<tr>
      <td style="border:none; padding:8px 6px">
        <div style="font-size:13px">${s.current ? '<b style="color:var(--signal)">● 当前设备</b>' : '其他设备'}</div>
        <div class="muted" style="font-size:11.5px">${esc(s.ip)} · ${esc(s.ua || "").slice(0, 60) || "未知UA"}</div>
        <div class="muted" style="font-size:11px">登录 ${new Date(s.createdAt).toLocaleString("zh-CN")} · 过期 ${new Date(s.exp).toLocaleString("zh-CN")}</div>
      </td></tr>`).join("")}</tbody></table>`;
  }

  // ---------- 初始化 ----------
  async function init() {
    // 站点动效（与 main.html / chess.html 一致；initRipple 为事件委托，动态按钮无需重绑）
    if (window.Motion) {
      Motion.initCursorLine();
      Motion.initMagnetic();
      Motion.initRipple();
    }
    let me;
    try { me = await api("/api/me"); } catch (e) { return; }
    state.role = me.data.role; state.username = me.data.username;
    roleBadge.textContent = (me.data.role || "").toUpperCase();
    roleBadge.className = "role-badge " + (me.data.role === "admin" ? "admin" : "");
    sbUser.innerHTML = "当前：<b>" + esc(me.data.username) + "</b>";
    // 按 data-roles 控制菜单可见性（含 admin 的角色可见，无 data-roles 永久可见）
    document.querySelectorAll(".sb-item").forEach(b => {
      const roles = b.dataset.roles;
      if (roles) b.style.display = roles.split(",").includes(me.data.role) ? "" : "none";
    });
    // 绑定
    document.querySelectorAll(".sb-item").forEach(b => b.onclick = () => switchView(b.dataset.view));
    $("#logout-btn").onclick = async () => { await api("/api/logout", { method: "POST" }); location.href = "login.html"; };
    $("#menu-toggle").onclick = () => $("#sidebar").classList.toggle("open");
    // 强制改密
    if (new URLSearchParams(location.search).get("change") === "1") showPwModal();
    switchView(me.data.role === "member" ? "profile" : "dashboard");
  }
  function showPwModal() {
    const mask = $("#pw-modal"); mask.style.display = "flex";
    $("#new-pw").value = ""; $("#pw-err").textContent = "";
    $("#new-pw").focus();
    $("#pw-save").onclick = async () => {
      const pw = $("#new-pw").value;
      if (!validPassword(pw)) { $("#pw-err").textContent = "密码需 8-128 位，且含大写、小写与数字"; return; }
      const r = await api("/api/me", { method: "PUT", body: JSON.stringify({ password: pw }) });
      if (!r.ok) { $("#pw-err").textContent = r.data.error || "失败"; return; }
      mask.style.display = "none";
      toast("密码已更新");
      afterRender();
    };
  }
  init();
})();
