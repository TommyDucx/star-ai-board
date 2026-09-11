(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? "" : value).replace(/[&<>'"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[c]));
  const fmt = value => value ? new Date(value).toLocaleString("zh-CN", { dateStyle:"medium", timeStyle:"short" }) : "暂无记录";
  const levelNames = ["新星", "开局员", "战术员", "星轨骑士", "中局舰长", "残局观测者", "棋盘领航员", "恒星大师", "银河宗师"];
  let me, tactics, rating, sessions, engagement, league = [];

  async function api(url, opts) {
    const res = await fetch(url, opts);
    let data = {};
    try { data = await res.json(); } catch (_) {}
    return { res, data };
  }
  function note(id, text, error) { const el = $(id); el.textContent = text || ""; el.classList.toggle("error", !!error); }
  function setBusy(button, busy, label) {
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = busy; button.textContent = busy ? label : button.dataset.label;
  }
  function levelName(n) { return levelNames[Math.min(levelNames.length - 1, Math.max(0, n - 1))]; }
  function renderMission() {
    const p = engagement.profile || {}, level = p.level || { level:1, current:0, needed:100, percent:0 };
    $("level-mark").textContent = level.level;
    $("level-name").textContent = `等级 ${level.level} · ${levelName(level.level)}`;
    $("xp-label").textContent = `${level.current} / ${level.needed} XP`;
    $("xp-bar").style.width = `${level.percent || 0}%`;
    $("orbit-days").textContent = p.activeStreak || 0;
    $("mission-title").textContent = p.activeStreak > 1 ? `连续活跃 ${p.activeStreak} 天，航线稳定` : "今日航线已开启";
    $("mission-copy").textContent = engagement.report ? engagement.report.headline : "让一次有意识的训练，为明天留下一颗星。";
  }
  function renderQuests() {
    const quests = engagement.quests || [], complete = quests.filter(q => q.complete).length;
    $("quest-count").textContent = `${complete} / ${quests.length} 完成`;
    $("quest-list").innerHTML = quests.map((q, index) => {
      const icon = ["◉", "♞", "⚡", "♛"][index] || "✦", pct = q.target ? Math.round(q.progress / q.target * 100) : 0;
      const state = q.claimed ? "已领取" : q.complete ? "领取奖励" : `${q.progress} / ${q.target}`;
      return `<article class="quest ${q.complete ? "done" : ""} ${q.claimed ? "claimed" : ""}"><span class="q-icon">${icon}</span><b>${esc(q.label)}</b><p>${esc(q.desc)}</p><div class="meter"><i style="width:${pct}%"></i></div><div class="q-meta">+${q.rewardXp} XP · +${q.rewardCoins} 星币</div><button class="btn ${q.complete && !q.claimed ? "primary" : ""}" data-claim="${esc(q.id)}" ${q.claimed || !q.complete ? "disabled" : ""}>${state}</button></article>`;
    }).join("");
    document.querySelectorAll("[data-claim]").forEach(button => button.addEventListener("click", claimQuest));
  }
  function renderReport() {
    const r = engagement.report || {};
    $("report-day").textContent = `${r.day || "今日"} · 活跃报告`;
    $("report-headline").textContent = r.headline || "今天的训练数据正在汇总。";
    $("report-solved").textContent = r.solved || 0;
    $("report-games").textContent = r.assessments || 0;
    $("report-streak").textContent = r.activeStreak || 0;
  }
  function renderHonors() {
    const honors = engagement.honors || [], unlocked = honors.filter(h => h.unlocked).length;
    $("honor-count").textContent = `${unlocked} / ${honors.length} 解锁`;
    $("honor-list").innerHTML = honors.map(h => `<article class="honor ${h.unlocked ? "" : "locked"}"><span class="h-icon">${esc(h.icon)}</span><b>${esc(h.name)}</b><p>${esc(h.desc)}</p><small>${h.progress}/${h.target}</small></article>`).join("");
  }
  function renderTactics() {
    const prog = tactics.progress || {}, stats = prog.stats || {}, tiers = prog.tiers || {};
    $("tactic-total").textContent = stats.totalPassedAllTiers || 0;
    $("tactics-summary").textContent = `已完成 ${stats.totalPassedAllTiers || 0} 关；当前连胜 ${stats.currentStreakAllTiers || 0}，最佳连胜 ${stats.bestStreakAllTiers || 0}。`;
    const labels = { beginner:"入门", elementary:"初级", intermediate:"中级", advanced:"高级" };
    $("tier-progress").innerHTML = Object.keys(labels).map(key => {
      const tier = tiers[key] || {}, done = Math.min(50, tier.totalPassed || 0);
      return `<div class="progress-row"><span>${labels[key]}</span><div class="bar"><i style="width:${done * 2}%"></i></div><span>${done}/50</span></div>`;
    }).join("");
  }
  function renderLeague() {
    $("engagement-leaderboard").innerHTML = league.length ? league.map((p, i) => `<div class="leader"><span class="rank">${i + 1}</span><span>${esc(p.username)} <small style="color:var(--soft)">Lv.${p.level}</small></span><span class="score">${p.xp} XP</span></div>`).join("") : '<p class="hint">第一批航行者正在集结。</p>';
  }
  function renderRecentGames() {
    const labels = { win:"胜", draw:"和", loss:"负" }, recent = rating.recent || [];
    $("recent-games").innerHTML = recent.length ? recent.map((game, index) => {
      const delta = Number(game.delta || 0), sign = delta > 0 ? "+" : "";
      return `<div class="leader"><span class="rank">${index + 1}</span><span>${labels[game.result] || "—"} · Stockfish ${game.engineElo || "—"}<small style="display:block;color:var(--soft)">${fmt(game.playedAt)}</small></span><span class="score">${sign}${delta} · ${game.after || "—"}</span></div>`;
    }).join("") : '<p class="hint">完成第一局正式测评后，这里会留下你的棋力轨迹。</p>';
  }
  function renderSessions() {
    $("sessions").textContent = sessions.length;
    $("session-list").innerHTML = sessions.map(s => `<div class="session"><div><b>${esc(s.ua || "未知设备")}</b><small>${esc(s.ip || "未知网络")} · 登录 ${fmt(s.createdAt)} · 到期 ${fmt(s.exp)}</small></div>${s.current ? '<span class="current">当前设备</span>' : '<span class="current" style="color:var(--soft)">已登录</span>'}</div>`).join("") || '<p class="hint" style="margin-top:12px">没有活跃会话。</p>';
  }
  function renderProfile() {
    const p = engagement.profile || {};
    $("avatar").textContent = (me.username || "?").slice(0, 1).toUpperCase();
    $("username").textContent = me.username || "—";
    $("name-input").value = me.username || "";
    $("role").textContent = String(me.role || "member").toUpperCase();
    $("joined").textContent = `加入于 ${fmt(me.createdAt)}`;
    $("rating").textContent = rating.rating ?? "—";
    $("best-rating").textContent = rating.bestRating ?? "—";
    $("coins").textContent = p.coins || 0;
    $("rating-streak").textContent = `${rating.currentStreak || 0} 连胜`;
    $("active-days").textContent = p.activeDays || 0;
    const canManage = me.role === "admin" || me.role === "editor";
    $("admin-link").classList.toggle("hidden", !canManage);
    $("admin-switch").classList.toggle("hidden", !canManage);
    if (me.mustChange) $("password-hint").textContent = "这是管理员创建的初始密码，请先在此设置新的个人密码。";
  }
  function renderAll() { renderMission(); renderQuests(); renderReport(); renderHonors(); renderTactics(); renderLeague(); renderRecentGames(); renderSessions(); renderProfile(); }
  async function claimQuest(event) {
    const button = event.currentTarget, questId = button.dataset.claim;
    setBusy(button, true, "领取中…"); note("quest-notice", "");
    const { res, data } = await api("/api/engagement/claim", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ questId }) });
    if (!res.ok) { setBusy(button, false); return note("quest-notice", data.error || "奖励领取失败", true); }
    engagement = data.engagement; renderAll(); note("quest-notice", `补给已入舱：+${data.reward.xp} XP，+${data.reward.coins} 星币。`);
  }
  async function load() {
    const profile = await api("/api/me");
    $("loading").classList.add("hidden");
    if (!profile.res.ok) { $("guest").classList.remove("hidden"); return; }
    me = profile.data;
    const [t, r, s, e, board] = await Promise.all([
      api("/api/tactics/progress"), api("/api/chess-rating/me"), api("/api/me/sessions"), api("/api/engagement/me"), api("/api/engagement/leaderboard?limit=5"),
    ]);
    tactics = t.res.ok ? t.data : { progress:{} }; rating = r.data.progress || {}; sessions = s.res.ok ? (s.data.sessions || []) : [];
    engagement = e.res.ok ? e.data : { profile:{ level:{ level:1, current:0, needed:100, percent:0 } }, quests:[], honors:[], report:{} };
    league = board.data.leaderboard || [];
    $("app").classList.remove("hidden"); renderAll();
  }
  $("profile-form").addEventListener("submit", async event => {
    event.preventDefault(); const button = event.submitter; setBusy(button, true, "保存中…"); note("profile-notice", "");
    const username = $("name-input").value.trim(); const { res, data } = await api("/api/me", { method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ username }) });
    setBusy(button, false); if (!res.ok) return note("profile-notice", data.error || "保存失败", true);
    me.username = data.username || username; renderProfile(); note("profile-notice", "资料已同步到全部已登录设备。");
  });
  $("password-form").addEventListener("submit", async event => {
    event.preventDefault(); const button = event.submitter; setBusy(button, true, "更新中…"); note("password-notice", "");
    const { res, data } = await api("/api/me", { method:"PUT", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ currentPassword:$("current-password").value, password:$("new-password").value }) });
    setBusy(button, false); if (!res.ok) return note("password-notice", data.error || "更新失败", true);
    $("password-form").reset(); me.mustChange = false; $("password-hint").textContent = "新密码须含大写、小写字母和数字，长度 8–128 位。"; note("password-notice", "密码已更新。");
  });
  $("logout-others").addEventListener("click", async event => {
    setBusy(event.currentTarget, true, "处理中…"); note("session-notice", ""); const { res, data } = await api("/api/me/sessions", { method:"DELETE" }); setBusy(event.currentTarget, false);
    if (!res.ok) return note("session-notice", data.error || "操作失败", true); sessions = sessions.filter(s => s.current); renderSessions(); note("session-notice", `已退出 ${data.removed || 0} 台其他设备。`);
  });
  $("logout").addEventListener("click", async () => { await api("/api/logout", { method:"POST" }); location.href = "index.html"; });
  load().catch(() => { $("loading").classList.add("hidden"); $("guest").classList.remove("hidden"); });
})();
