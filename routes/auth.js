"use strict";
/* S.T.A.R. 路由模块：账号与会话（登录 / 登出 / 注册 / 我的资料 / 会话管理）
 * 由 admin.js 的 handleApi 原样拆出（未改语义）。调用约定：
 *   - 由 handleApi 传入 ctx（req/res/p/m + 依赖超集；登录后的阶段还带 s）
 *   - 命中路由时直接用 json(res, ...) 写响应；调用方通过 res.headersSent / writableEnded
 *     判断「是否已被处理」，未处理则继续交给下一个模块。
 *   - 返回 false 仅表示「本模块没有匹配到路由」。 */

module.exports.public = async function (ctx) {
  const { req, res, p, m, u, json, readBody, ALL_ROLES, CHESS_RATING_MAX, CHESS_RATING_MIN, CHESS_RATING_START, CHESS_RATING_TIERS, CHESS_TIER_KEYS, RE_USERNAME, TACTICS_LEVELS_PER_TIER, TACTICS_TIERS, TACTICS_TIER_DEFS, TACTICS_TITLES, addLibraryComment, applyTacticsAttempt, chessLeaderboard, chinaDay, claimDailyQuest, clearLoginFail, clientIp, collectLibraryEntry, controlEngine, cookieFlags, createLibraryEntry, createSession, currentTacticsPuzzle, deleteLibraryComment, deleteLibraryEntry, engagementLeaderboard, engineStatus, findLibraryEntry, findUser, finishChessRatingGame, getAccounts, getChessRating, getConfig, getCurrentToken, getGamesStats, getMetrics, getSession, getTactics, hasPerm, hashPassword, libraryList, libraryMine, libraryPublicEntry, listSessionsFor, litAccess, litComment, litDecideAccess, litDeleteComment, litGatedMeta, litKnown, litNotifications, litPublic, litRequestAccess, litToggleLike, loadLibrary, loadLit, loadLitContent, loadSessions, loginAllowed, logoutAllFor, logoutOthers, normalizeDayFlags, normalizeUser, noteLoginFail, publicChessRating, publicEngagement, publicPuzzle, publicTactics, rateCheck, registerLibraryView, saveAccounts, saveConfig, saveSessions, saveUserTactics, startChessRatingGame, startTacticsAttempt, toggleLibraryStar, trainerImport, trainerLines, trainerRemove, trainerSession, validPassword, verifyPassword } = ctx;
  
    // ===================== 公开接口（无需登录）=====================
    // 登录（支持 username / email / phone）
    if (p === "/api/login" && m === "POST") {
      const ip = clientIp(req);
      const body = await readBody(req);
      const { username, password } = body;
      if (typeof username !== "string" || typeof password !== "string")
        return json(res, 400, { error: "缺少参数" });
      if (!loginAllowed(ip, username))
        return json(res, 429, { error: "尝试过于频繁，请稍后再试（IP 或账号已被限流）" });
      const acc = findUser(username);
      // 不存在用户也做一次 scrypt 比对，弱化枚举时序
      if (!acc || !verifyPassword(password, acc.pw)) {
        noteLoginFail(ip, username);
        return json(res, 401, { error: "用户名或密码错误" });
      }
      if (acc.status === "suspended") {
        noteLoginFail(ip, username);
        return json(res, 403, { error: "账号已被停用，请联系管理员" });
      }
      clearLoginFail(ip, username);
      acc.lastLoginAt = Date.now(); acc.updatedAt = Date.now();
      const accounts = getAccounts().map(a => a.username === acc.username ? acc : a);
      saveAccounts(accounts);
      const cookie = createSession(acc, req);
      return json(res, 200,
        { username: acc.username, role: acc.role, mustChange: !!acc.mustChange },
        { "Set-Cookie": `star_admin=${cookie}${cookieFlags(req)}; Max-Age=604800` });
    }
  
    // 登出
    if (p === "/api/logout" && m === "POST") {
      const token = getCurrentToken(req);
      if (token) { const s = loadSessions(); delete s[token]; saveSessions(s); }
      return json(res, 200, { ok: true },
        { "Set-Cookie": "star_admin=; HttpOnly; Path=/; Max-Age=0" });
    }
  
    // 注册（开放自助注册：仅用户名 + 密码，验证码/联系方式已移除）
    if (p === "/api/register" && m === "POST") {
      const ip = clientIp(req);
      const body = await readBody(req);
      const username = String(body.username || "").trim();
      const { password } = body;
      if (!RE_USERNAME.test(username))
        return json(res, 400, { error: "用户名 2-32 位字母数字/._-" });
      if (!validPassword(password))
        return json(res, 400, { error: "密码需 8-128 位，且含大写、小写、数字" });
      // 限流（注册尝试：10 次/10 分钟/IP）
      if (!rateCheck("reg:" + ip, 10, 600000))
        return json(res, 429, { error: "注册请求过于频繁，请稍后再试" });
      const accounts = getAccounts();
      if (accounts.find(a => a.username.toLowerCase() === username.toLowerCase()))
        return json(res, 409, { error: "用户名已存在" });
      const user = normalizeUser({
        username, role: "member", pw: hashPassword(password),
        status: "active", createdAt: Date.now(), updatedAt: Date.now(), lastLoginAt: Date.now(),
      });
      accounts.push(user); saveAccounts(accounts);
      const cookie = createSession(user, req);
      return json(res, 200,
        { username: user.username, role: user.role },
        { "Set-Cookie": `star_admin=${cookie}${cookieFlags(req)}; Max-Age=604800` });
    }

  return false;   // 未匹配到本模块的路由
};

module.exports.authed = async function (ctx) {
  const { req, res, p, m, u, json, readBody, s, ALL_ROLES, CHESS_RATING_MAX, CHESS_RATING_MIN, CHESS_RATING_START, CHESS_RATING_TIERS, CHESS_TIER_KEYS, RE_USERNAME, TACTICS_LEVELS_PER_TIER, TACTICS_TIERS, TACTICS_TIER_DEFS, TACTICS_TITLES, addLibraryComment, applyTacticsAttempt, chessLeaderboard, chinaDay, claimDailyQuest, clearLoginFail, clientIp, collectLibraryEntry, controlEngine, cookieFlags, createLibraryEntry, createSession, currentTacticsPuzzle, deleteLibraryComment, deleteLibraryEntry, engagementLeaderboard, engineStatus, findLibraryEntry, findUser, finishChessRatingGame, getAccounts, getChessRating, getConfig, getCurrentToken, getGamesStats, getMetrics, getSession, getTactics, hasPerm, hashPassword, libraryList, libraryMine, libraryPublicEntry, listSessionsFor, litAccess, litComment, litDecideAccess, litDeleteComment, litGatedMeta, litKnown, litNotifications, litPublic, litRequestAccess, litToggleLike, loadLibrary, loadLit, loadLitContent, loadSessions, loginAllowed, logoutAllFor, logoutOthers, normalizeDayFlags, normalizeUser, noteLoginFail, publicChessRating, publicEngagement, publicPuzzle, publicTactics, rateCheck, registerLibraryView, saveAccounts, saveConfig, saveSessions, saveUserTactics, startChessRatingGame, startTacticsAttempt, toggleLibraryStar, trainerImport, trainerLines, trainerRemove, trainerSession, validPassword, verifyPassword } = ctx;
  
    // 当前用户资料 / 改名 / 改密
    if (p === "/api/me") {
      const accounts = getAccounts();
      const me = accounts.find(a => a.id === s.userId) || accounts.find(a => a.username === s.username);
      if (!me) return json(res, 401, { error: "账号不存在" });
      if (m === "GET") {
        return json(res, 200, {
          username: me.username, role: me.role, status: me.status,
          createdAt: me.createdAt, lastLoginAt: me.lastLoginAt, mustChange: !!me.mustChange,
        });
      }
      if (m === "PUT") {
        const body = await readBody(req);
        let changed = false;
  
        // 改用户名（本人自助；唯一性 + 与账号创建一致的格式校验）
        const newUname = typeof body.username === "string" ? body.username.trim() : "";
        if (newUname && newUname !== me.username) {
          if (!RE_USERNAME.test(newUname))
            return json(res, 400, { error: "用户名 2-32 位字母数字/._-" });
          if (accounts.find(a => a.id !== me.id && a.username.toLowerCase() === newUname.toLowerCase()))
            return json(res, 409, { error: "用户名已存在" });
          me.username = newUname; me.updatedAt = Date.now(); changed = true;
          // 同步所有设备会话里的显示名
          const sessions = loadSessions();
          for (const tok of Object.keys(sessions))
            if (sessions[tok].userId === me.id) sessions[tok].username = newUname;
          saveSessions(sessions);
        }
  
        // 改密码：必须先验证当前密码（否则会话被劫持/XSS 时攻击者可直接改密锁死本人）
        let pwChanged = false;
        if (body.password) {
          if (!body.currentPassword || !verifyPassword(String(body.currentPassword), me.pw))
            return json(res, 403, { error: "当前密码不正确" });
          if (!validPassword(body.password))
            return json(res, 400, { error: "新密码需 8-128 位，且含大写、小写、数字" });
          me.pw = hashPassword(body.password); me.mustChange = false; me.updatedAt = Date.now();
          changed = true; pwChanged = true;
        }
  
        if (!changed) return json(res, 400, { error: "没有需要修改的内容" });
        saveAccounts(accounts);
        // 改密后作废本人其它设备的会话，当前会话保持有效
        if (pwChanged) logoutOthers(me.id, getCurrentToken(req));
        return json(res, 200, { ok: true, username: me.username });
      }
    }
  
    // 多设备会话管理
    if (p === "/api/me/sessions") {
      const cur = getCurrentToken(req);
      if (m === "GET") {
        const list = listSessionsFor(s.userId).map(x => ({
          id: x.token.slice(0, 8), ip: x.ip, ua: x.ua,
          createdAt: x.createdAt, exp: x.exp, current: x.token === cur,
        })).sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
        return json(res, 200, { sessions: list });
      }
      if (m === "DELETE") {
        const n = logoutOthers(s.userId, cur);
        return json(res, 200, { ok: true, removed: n });
      }
    }

  return false;   // 未匹配到本模块的路由
};
