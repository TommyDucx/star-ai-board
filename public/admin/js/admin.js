// admin.js — 后台前端逻辑（vanilla JS，无框架依赖）
(function () {
  "use strict";
  const state = { role: null, username: null, view: "dashboard", timer: null };

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
  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {}));
    let data = {};
    try { data = await r.json(); } catch (e) {}
    if (r.status === 401) { location.href = "login.html"; throw new Error("unauthorized"); }
    return { ok: r.ok, status: r.status, data };
  }
  function fmtUptime(s) {
    s = Math.floor(s);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60);
    return (d ? d + "天 " : "") + h + "时" + (d ? "" : m + "分");
  }

  // ---------- 视图路由 ----------
  const TITLES = { dashboard: "数据看板", accounts: "账号管理", engines: "引擎管理", announce: "公告管理" };
  function switchView(v) {
    if (v === "accounts" || v === "engines" || v === "announce") {
      if (state.role !== "admin") { toast("需要管理员权限"); return; }
    }
    state.view = v;
    titleEl.textContent = TITLES[v] || "";
    document.querySelectorAll(".sb-item").forEach(b => b.classList.toggle("active", b.dataset.view === v));
    $("#sidebar").classList.remove("open");
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (v === "dashboard") renderDashboard();
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
        <div class="card metric"><div class="m-label">CPU 占用</div>
          <div class="m-val">${m.cpu != null ? m.cpu : "—"}<small>%</small></div>
          <div class="bar-track"><i class="${cpuCls}"></i></div></div>
        <div class="card metric"><div class="m-label">内存</div>
          <div class="m-val">${memPct}<small>%</small></div>
          <div class="bar-track"><i class="${memCls}"></i></div>
          <div class="muted" style="font-size:11px;margin-top:6px">${fmtBytes(m.mem && m.mem.used)} / ${fmtBytes(m.mem && m.mem.total)}</div></div>
        <div class="card metric"><div class="m-label">磁盘 /</div>
          <div class="m-val">${diskPct}<small>%</small></div>
          <div class="bar-track"><i class="${diskPct > 85 ? "danger" : diskPct > 60 ? "warn" : "cyan"}"></i></div>
          <div class="muted" style="font-size:11px;margin-top:6px">${fmtBytes(m.disk && m.disk.used)} / ${fmtBytes(m.disk && m.disk.total)}</div></div>
        <div class="card metric"><div class="m-label">运行时间</div>
          <div class="m-val" style="font-size:22px">${fmtUptime(m.uptime || 0)}</div>
          <div class="muted" style="font-size:11px;margin-top:6px">${esc(m.hostname || "")}</div></div>
        <div class="card metric"><div class="m-label">在线引擎</div>
          <div class="m-val">${online}<small>/ ${(m.engines || []).length}</small></div>
          <div class="muted" style="font-size:11px;margin-top:6px">load ${((m.loadavg || [])[0] || 0).toFixed(2)}</div></div>
        <div class="card metric"><div class="m-label">累计分析</div>
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
  async function renderAccounts() {
    let r;
    try { r = await api("/api/admin/accounts"); } catch (e) { return; }
    const list = r.data.accounts || [];
    view.innerHTML = `
      <div class="panel" style="margin-bottom:16px">
        <h3>新建账号</h3>
        <div class="form-row">
          <div class="field"><label>账号</label><input id="nu" placeholder="用户名（2-32 位）"></div>
          <div class="field"><label>密码</label><input id="np" type="password" placeholder="至少 6 位"></div>
          <div class="field"><label>角色</label>
            <select id="nr"><option value="viewer">viewer（只读看板）</option><option value="admin">admin（全权限）</option></select></div>
          <div class="field" style="flex:0"><label>&nbsp;</label><button class="btn primary" id="create-btn">＋ 创建</button></div>
        </div>
        <div id="acc-err" class="login-err"></div>
      </div>
      <div class="panel"><table>
        <thead><tr><th>账号</th><th>角色</th><th>创建时间</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${list.map(a => `<tr>
          <td>${esc(a.username)}</td>
          <td><span class="tag ${a.role}">${a.role}</span></td>
          <td class="muted">${new Date(a.createdAt).toLocaleString("zh-CN")}</td>
          <td>${a.mustChange ? '<span class="tag warn">需改密</span>' : '<span class="tag on">正常</span>'}</td>
          <td><div class="row-actions">
            <select class="btn sm role-sel" data-u="${esc(a.username)}" ${a.username === state.username ? "disabled" : ""}>
              <option value="viewer" ${a.role === "viewer" ? "selected" : ""}>viewer</option>
              <option value="admin" ${a.role === "admin" ? "selected" : ""}>admin</option>
            </select>
            <button class="btn sm pw-btn" data-u="${esc(a.username)}">改密</button>
            <button class="btn sm danger del-btn" data-u="${esc(a.username)}" ${a.username === state.username ? "disabled" : ""}>删除</button>
          </div></td>
        </tr>`).join("")}</tbody>
      </table></div>`;
    $("#create-btn").onclick = createAccount;
    view.querySelectorAll(".role-sel").forEach(s => s.onchange = () => changeRole(s.dataset.u, s.value));
    view.querySelectorAll(".pw-btn").forEach(b => b.onclick = () => changePw(b.dataset.u));
    view.querySelectorAll(".del-btn").forEach(b => b.onclick = () => delAccount(b.dataset.u));
  }
  async function createAccount() {
    const username = $("#nu").value.trim(), password = $("#np").value, role = $("#nr").value;
    const err = $("#acc-err"); err.textContent = "";
    const r = await api("/api/admin/accounts", { method: "POST", body: JSON.stringify({ username, password, role }) });
    if (!r.ok) { err.textContent = r.data.error || "创建失败"; return; }
    toast("已创建 " + username); renderAccounts();
  }
  async function changeRole(u, role) {
    const r = await api("/api/admin/accounts/" + encodeURIComponent(u), { method: "PUT", body: JSON.stringify({ role }) });
    if (!r.ok) { toast(r.data.error || "失败"); renderAccounts(); return; }
    toast(u + " → " + role);
  }
  async function changePw(u) {
    const pw = prompt("为 " + u + " 设置新密码（至少 6 位）：");
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
      <div style="margin-top:16px"><button class="btn primary" id="ann-save">保存</button></div>
      <div id="ann-err" class="login-err"></div>
    </div>`;
    $("#ann-save").onclick = async () => {
      const r = await api("/api/admin/announcement", {
        method: "PUT",
        body: JSON.stringify({ text: $("#ann-text").value, enabled: $("#ann-en").checked }),
      });
      toast(r.ok ? "已保存" : (r.data.error || "失败"));
    };
  }

  // ---------- 初始化 ----------
  async function init() {
    let me;
    try { me = await api("/api/me"); } catch (e) { return; }
    state.role = me.data.role; state.username = me.data.username;
    roleBadge.textContent = me.data.role === "admin" ? "ADMIN" : "VIEWER";
    roleBadge.className = "role-badge " + (me.data.role === "admin" ? "admin" : "");
    sbUser.innerHTML = "当前：<b>" + esc(me.data.username) + "</b>";
    // 隐藏非 admin 的菜单
    document.querySelectorAll(".sb-item[data-admin]").forEach(b => {
      b.style.display = me.data.role === "admin" ? "" : "none";
    });
    // 绑定
    document.querySelectorAll(".sb-item").forEach(b => b.onclick = () => switchView(b.dataset.view));
    $("#logout-btn").onclick = async () => { await api("/api/logout", { method: "POST" }); location.href = "login.html"; };
    $("#menu-toggle").onclick = () => $("#sidebar").classList.toggle("open");
    // 强制改密
    if (new URLSearchParams(location.search).get("change") === "1") showPwModal();
    switchView("dashboard");
  }
  function showPwModal() {
    const mask = $("#pw-modal"); mask.style.display = "flex";
    $("#pw-save").onclick = async () => {
      const pw = $("#new-pw").value;
      if (pw.length < 6) { $("#pw-err").textContent = "密码至少 6 位"; return; }
      const r = await api("/api/me", { method: "PUT", body: JSON.stringify({ password: pw }) });
      if (!r.ok) { $("#pw-err").textContent = r.data.error || "失败"; return; }
      mask.style.display = "none";
      toast("密码已更新");
    };
  }
  init();
})();
