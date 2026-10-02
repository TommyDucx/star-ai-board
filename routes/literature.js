"use strict";
/* S.T.A.R. 路由模块：文学板块（点赞 / 评论 / 阅读授权 / 通知）
 * 由 admin.js 的 handleApi 原样拆出（未改语义）。调用约定：
 *   - 由 handleApi 传入 ctx（req/res/p/m + 依赖超集；登录后的阶段还带 s）
 *   - 命中路由时直接用 json(res, ...) 写响应；调用方通过 res.headersSent / writableEnded
 *     判断「是否已被处理」，未处理则继续交给下一个模块。
 *   - 返回 false 仅表示「本模块没有匹配到路由」。 */

module.exports.public = async function (ctx) {
  const { req, res, p, m, u, json, readBody, ALL_ROLES, CHESS_RATING_MAX, CHESS_RATING_MIN, CHESS_RATING_START, CHESS_RATING_TIERS, CHESS_TIER_KEYS, RE_USERNAME, TACTICS_LEVELS_PER_TIER, TACTICS_TIERS, TACTICS_TIER_DEFS, TACTICS_TITLES, addLibraryComment, applyTacticsAttempt, chessLeaderboard, chinaDay, claimDailyQuest, clearLoginFail, clientIp, collectLibraryEntry, controlEngine, cookieFlags, createLibraryEntry, createSession, currentTacticsPuzzle, deleteLibraryComment, deleteLibraryEntry, engagementLeaderboard, engineStatus, findLibraryEntry, findUser, finishChessRatingGame, getAccounts, getChessRating, getConfig, getCurrentToken, getGamesStats, getMetrics, getSession, getTactics, hasPerm, hashPassword, libraryList, libraryMine, libraryPublicEntry, listSessionsFor, litAccess, litComment, litDecideAccess, litDeleteComment, litGatedMeta, litKnown, litNotifications, litPublic, litRequestAccess, litToggleLike, loadLibrary, loadLit, loadLitContent, loadSessions, loginAllowed, logoutAllFor, logoutOthers, normalizeDayFlags, normalizeUser, noteLoginFail, publicChessRating, publicEngagement, publicPuzzle, publicTactics, rateCheck, registerLibraryView, saveAccounts, saveConfig, saveSessions, saveUserTactics, startChessRatingGame, startTacticsAttempt, toggleLibraryStar, trainerImport, trainerLines, trainerRemove, trainerSession, validPassword, verifyPassword } = ctx;
  
    // 文学板块：点赞与评论（读公开，写需登录）
    if (p === "/api/literature" && m === "GET") {
      const s2 = getSession(req);
      return json(res, 200, litPublic(loadLit(), s2 && s2.userId));
    }
    // 文学：受保护作品的正文与授权申请
    {
      const lt = /^\/api\/literature\/([a-z0-9][a-z0-9_-]{0,31})\/(text|access\/request|access\/decide)$/.exec(p);
      if (lt && m === "GET" && lt[2] === "text") {
        const s2 = getSession(req);
        const meta = litGatedMeta(lt[1]);
        if (!meta) return json(res, 404, { error: "作品不存在" });
        const acc = litAccess(lt[1], s2 && s2.userId);
        if (!acc.allowed) return json(res, 403, { error: "该作品需要授权", state: acc.state, title: meta.title, author: meta.author, owner: meta.owner });
        const c = loadLitContent();
        return json(res, 200, { key: lt[1], title: meta.title, author: meta.author, paragraphs: (c.articles[lt[1]] || {}).paragraphs || [] });
      }
    }

  return false;   // 未匹配到本模块的路由
};

module.exports.authed = async function (ctx) {
  const { req, res, p, m, u, json, readBody, s, ALL_ROLES, CHESS_RATING_MAX, CHESS_RATING_MIN, CHESS_RATING_START, CHESS_RATING_TIERS, CHESS_TIER_KEYS, RE_USERNAME, TACTICS_LEVELS_PER_TIER, TACTICS_TIERS, TACTICS_TIER_DEFS, TACTICS_TITLES, addLibraryComment, applyTacticsAttempt, chessLeaderboard, chinaDay, claimDailyQuest, clearLoginFail, clientIp, collectLibraryEntry, controlEngine, cookieFlags, createLibraryEntry, createSession, currentTacticsPuzzle, deleteLibraryComment, deleteLibraryEntry, engagementLeaderboard, engineStatus, findLibraryEntry, findUser, finishChessRatingGame, getAccounts, getChessRating, getConfig, getCurrentToken, getGamesStats, getMetrics, getSession, getTactics, hasPerm, hashPassword, libraryList, libraryMine, libraryPublicEntry, listSessionsFor, litAccess, litComment, litDecideAccess, litDeleteComment, litGatedMeta, litKnown, litNotifications, litPublic, litRequestAccess, litToggleLike, loadLibrary, loadLit, loadLitContent, loadSessions, loginAllowed, logoutAllFor, logoutOthers, normalizeDayFlags, normalizeUser, noteLoginFail, publicChessRating, publicEngagement, publicPuzzle, publicTactics, rateCheck, registerLibraryView, saveAccounts, saveConfig, saveSessions, saveUserTactics, startChessRatingGame, startTacticsAttempt, toggleLibraryStar, trainerImport, trainerLines, trainerRemove, trainerSession, validPassword, verifyPassword } = ctx;
    {
      const lk = /^\/api\/literature\/([a-z0-9][a-z0-9_-]{0,31})\/(like|comment)$/.exec(p);
      if (lk && m === "POST") {
        const s2 = getSession(req);
        if (!s2) return json(res, 401, { error: "请先登录 S.T.A.R. 账号" });
        if (!litKnown(lk[1])) return json(res, 404, { error: "作品不存在" });
        const body = await readBody(req);
        const r = lk[2] === "like" ? litToggleLike(s2.userId, lk[1]) : litComment(s2.userId, lk[1], body.text, body.att);
        return json(res, r.error ? 400 : 200, r.error ? { error: r.error } : r);
      }
      const ld = /^\/api\/literature\/([a-z0-9][a-z0-9_-]{0,31})\/comment\/([A-Za-z0-9-]+)$/.exec(p);
      if (ld && m === "DELETE") {
        const s2 = getSession(req);
        if (!s2) return json(res, 401, { error: "请先登录" });
        const r = litDeleteComment(s2.userId, ld[1], ld[2], s2.role === "admin");
        return json(res, r.error ? 404 : 200, r.error ? { error: r.error } : r);
      }
    }
    // 文学：申请授权 / 审批 / 通知（需登录）
    {
      const lr = /^\/api\/literature\/([a-z0-9][a-z0-9_-]{0,31})\/access\/request$/.exec(p);
      if (lr && m === "POST") {
        if (!litKnown(lr[1])) return json(res, 404, { error: "作品不存在" });
        return json(res, 200, litRequestAccess(s.userId, lr[1]));
      }
      const ld2 = /^\/api\/literature\/([a-z0-9][a-z0-9_-]{0,31})\/access\/decide$/.exec(p);
      if (ld2 && m === "POST") {
        const body = await readBody(req);
        const r = litDecideAccess(s.userId, ld2[1], String(body.userId || ""), body.approve !== false);
        return json(res, r.error ? 403 : 200, r.error ? { error: r.error } : r);
      }
      if (p === "/api/notifications" && m === "GET") return json(res, 200, litNotifications(s.userId));
    }

  return false;   // 未匹配到本模块的路由
};
