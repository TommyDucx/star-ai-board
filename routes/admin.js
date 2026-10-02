"use strict";
/* S.T.A.R. 路由模块：后台管理（RBAC + 指标 / 对局 / 引擎 / 账号 / 公告）
 * 由 admin.js 的 handleApi 原样拆出（未改语义）。调用约定：
 *   - 由 handleApi 传入 ctx（req/res/p/m + 依赖超集；登录后的阶段还带 s）
 *   - 命中路由时直接用 json(res, ...) 写响应；调用方通过 res.headersSent / writableEnded
 *     判断「是否已被处理」，未处理则继续交给下一个模块。
 *   - 返回 false 仅表示「本模块没有匹配到路由」。 */

module.exports.authed = async function (ctx) {
  const { req, res, p, m, u, json, readBody, s, ALL_ROLES, CHESS_RATING_MAX, CHESS_RATING_MIN, CHESS_RATING_START, CHESS_RATING_TIERS, CHESS_TIER_KEYS, RE_USERNAME, TACTICS_LEVELS_PER_TIER, TACTICS_TIERS, TACTICS_TIER_DEFS, TACTICS_TITLES, addLibraryComment, applyTacticsAttempt, chessLeaderboard, chinaDay, claimDailyQuest, clearLoginFail, clientIp, collectLibraryEntry, controlEngine, cookieFlags, createLibraryEntry, createSession, currentTacticsPuzzle, deleteLibraryComment, deleteLibraryEntry, engagementLeaderboard, engineStatus, findLibraryEntry, findUser, finishChessRatingGame, getAccounts, getChessRating, getConfig, getCurrentToken, getGamesStats, getMetrics, getSession, getTactics, hasPerm, hashPassword, libraryList, libraryMine, libraryPublicEntry, listSessionsFor, litAccess, litComment, litDecideAccess, litDeleteComment, litGatedMeta, litKnown, litNotifications, litPublic, litRequestAccess, litToggleLike, loadLibrary, loadLit, loadLitContent, loadSessions, loginAllowed, logoutAllFor, logoutOthers, normalizeDayFlags, normalizeUser, noteLoginFail, publicChessRating, publicEngagement, publicPuzzle, publicTactics, rateCheck, registerLibraryView, saveAccounts, saveConfig, saveSessions, saveUserTactics, startChessRatingGame, startTacticsAttempt, toggleLibraryStar, trainerImport, trainerLines, trainerRemove, trainerSession, validPassword, verifyPassword } = ctx;
  
    // ===================== RBAC 受保护资源 =====================
    function need(perm) {
      if (!hasPerm(s.role, perm)) { json(res, 403, { error: "权限不足（需要 " + perm + "）" }); return false; }
      return true;
    }
  
    // 看板数据
    if (p === "/api/admin/metrics" && m === "GET") { if (!need("metrics:read")) return; return json(res, 200, await getMetrics()); }
    if (p === "/api/admin/games" && m === "GET") { if (!need("games:read")) return; return json(res, 200, getGamesStats()); }
    if (p === "/api/admin/engines" && m === "GET") { if (!need("engines:read")) return; return json(res, 200, { engines: engineStatus() }); }
  
    // 账号管理（读）
    if (p === "/api/admin/accounts" && m === "GET") {
      if (!need("account:read")) return;
      return json(res, 200, { accounts: getAccounts().map(publicAccount) });
    }
    // 账号管理（建）
    if (p === "/api/admin/accounts" && m === "POST") {
      if (!need("account:write")) return;
      const body = await readBody(req);
      const uname = String(body.username || "").trim();
      const pw = body.password, role = body.role;
      if (!RE_USERNAME.test(uname)) return json(res, 400, { error: "用户名 2-32 位字母数字/._-" });
      if (!validPassword(pw)) return json(res, 400, { error: "密码需 8-128 位，且含大写、小写、数字" });
      if (!ALL_ROLES.includes(role)) return json(res, 400, { error: "角色无效" });
      if (role === "admin" && s.role !== "admin") return json(res, 403, { error: "仅管理员可授予 admin 角色" });
      const accounts = getAccounts();
      if (accounts.find(a => a.username.toLowerCase() === uname.toLowerCase())) return json(res, 409, { error: "用户名已存在" });
      accounts.push(normalizeUser({ username: uname, role, pw: hashPassword(pw), createdAt: Date.now(), updatedAt: Date.now() }));
      saveAccounts(accounts);
      return json(res, 200, { ok: true });
    }
    // 账号管理（改 / 删）
    const acctMatch = p.match(/^\/api\/admin\/accounts\/(.+)$/);
    if (acctMatch && (m === "PUT" || m === "DELETE")) {
      if (!need("account:write")) return;
      let uname;
      try { uname = decodeURIComponent(acctMatch[1]); }
      catch { return json(res, 400, { error: "非法路径参数" }); }
      const accounts = getAccounts();
      const idx = accounts.findIndex(a => a.username === uname);
      if (idx < 0) return json(res, 404, { error: "账号不存在" });
      if (m === "DELETE") {
        if (uname === s.username) return json(res, 400, { error: "不能删除自己" });
        if (accounts[idx].role === "admin") return json(res, 400, { error: "不能删除管理员账号" });
        const targetId = accounts[idx].id;
        accounts.splice(idx, 1);
        saveAccounts(accounts);
        logoutAllFor(targetId);
        return json(res, 200, { ok: true });
      }
      const body = await readBody(req);
      const acc = accounts[idx];
      // 仅管理员可修改管理员账号（覆盖改密/停用/角色），防止 editor 越权锁死管理员
      if (acc.role === "admin" && s.role !== "admin")
        return json(res, 403, { error: "仅管理员可修改管理员账号" });
      if (uname === s.username && body.role && body.role !== acc.role)
        return json(res, 403, { error: "不能修改自己的角色" });
      let revoke = false;   // 状态停用 / 角色变更 / 密码重置后，作废该账号所有在线会话
      if (body.status && ["active", "suspended"].includes(body.status)) {
        if (body.status === "suspended" && acc.status !== "suspended") revoke = true;
        acc.status = body.status;
      }
      if (body.password && validPassword(body.password)) {
        acc.pw = hashPassword(body.password); acc.mustChange = false; revoke = true;
      }
      if (body.role && ALL_ROLES.includes(body.role)) {
        // 防止把自己/唯一管理员降级导致锁死：editor 不能把别人改成 admin 除非自己也是 admin
        if (body.role === "admin" && s.role !== "admin")
          return json(res, 403, { error: "仅管理员可授予 admin 角色" });
        if (acc.role === "admin" && body.role !== "admin" && !accounts.some(a => a !== acc && a.role === "admin"))
          return json(res, 400, { error: "至少保留一个管理员" });
        if (body.role !== acc.role) revoke = true;
        acc.role = body.role;
      }
      acc.updatedAt = Date.now();
      saveAccounts(accounts);
      if (revoke) logoutAllFor(acc.id);
      return json(res, 200, { ok: true });
    }
  
    // 公告
    if (p === "/api/admin/announcement" && m === "PUT") {
      if (!need("announcement:write")) return;
      const body = await readBody(req);
      const cfg = getConfig();
      cfg.announcement = { text: String(body.text || "").slice(0, 500), enabled: !!body.enabled };
      saveConfig(cfg);
      return json(res, 200, { ok: true });
    }
  
    // 引擎启停
    const engMatch = p.match(/^\/api\/admin\/engine\/([^/]+)\/(stop|start)$/);
    if (engMatch && m === "POST") {
      if (!need("engine:control")) return;
      let key;
      try { key = decodeURIComponent(engMatch[1]); }
      catch { return json(res, 400, { error: "非法路径参数" }); }
      const ok = controlEngine(key, engMatch[2]);
      return json(res, ok ? 200 : 404, { ok });
    }
  
    return json(res, 404, { error: "not found" });

  return false;   // 未匹配到本模块的路由
};
