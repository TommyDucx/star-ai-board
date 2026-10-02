"use strict";
/* S.T.A.R. 路由模块：背谱训练（线路导入 / 训练 / 删除）
 * 由 admin.js 的 handleApi 原样拆出（未改语义）。调用约定：
 *   - 由 handleApi 传入 ctx（req/res/p/m + 依赖超集；登录后的阶段还带 s）
 *   - 命中路由时直接用 json(res, ...) 写响应；调用方通过 res.headersSent / writableEnded
 *     判断「是否已被处理」，未处理则继续交给下一个模块。
 *   - 返回 false 仅表示「本模块没有匹配到路由」。 */

module.exports.authed = async function (ctx) {
  const { req, res, p, m, u, json, readBody, s, ALL_ROLES, CHESS_RATING_MAX, CHESS_RATING_MIN, CHESS_RATING_START, CHESS_RATING_TIERS, CHESS_TIER_KEYS, RE_USERNAME, TACTICS_LEVELS_PER_TIER, TACTICS_TIERS, TACTICS_TIER_DEFS, TACTICS_TITLES, addLibraryComment, applyTacticsAttempt, chessLeaderboard, chinaDay, claimDailyQuest, clearLoginFail, clientIp, collectLibraryEntry, controlEngine, cookieFlags, createLibraryEntry, createSession, currentTacticsPuzzle, deleteLibraryComment, deleteLibraryEntry, engagementLeaderboard, engineStatus, findLibraryEntry, findUser, finishChessRatingGame, getAccounts, getChessRating, getConfig, getCurrentToken, getGamesStats, getMetrics, getSession, getTactics, hasPerm, hashPassword, libraryList, libraryMine, libraryPublicEntry, listSessionsFor, litAccess, litComment, litDecideAccess, litDeleteComment, litGatedMeta, litKnown, litNotifications, litPublic, litRequestAccess, litToggleLike, loadLibrary, loadLit, loadLitContent, loadSessions, loginAllowed, logoutAllFor, logoutOthers, normalizeDayFlags, normalizeUser, noteLoginFail, publicChessRating, publicEngagement, publicPuzzle, publicTactics, rateCheck, registerLibraryView, saveAccounts, saveConfig, saveSessions, saveUserTactics, startChessRatingGame, startTacticsAttempt, toggleLibraryStar, trainerImport, trainerLines, trainerRemove, trainerSession, validPassword, verifyPassword } = ctx;
    // 背谱训练（登录可用；仅记录本人学习进度）
    if (p === "/api/trainer/lines" && m === "GET") {
      const s2 = getSession(req);
      if (!s2) return json(res, 401, { error:"请先登录" });
      return json(res, 200, trainerLines(s2.userId));
    }
    if (p === "/api/trainer/import" && m === "POST") {
      const s2 = getSession(req);
      if (!s2) return json(res, 401, { error:"请先登录" });
      const body = await readBody(req);
      const r = trainerImport(s2.userId, body);
      return json(res, r.error ? 400 : 200, r.error ? { error: r.error } : r);
    }
    {
      const tk = /^\/api\/trainer\/lines\/([A-Za-z0-9-]+)$/.exec(p);
      if (tk && m === "DELETE") {
        const s2 = getSession(req);
        if (!s2) return json(res, 401, { error:"请先登录" });
        const r = trainerRemove(s2.userId, tk[1]);
        return json(res, r.error ? 404 : 200, r.error ? { error: r.error } : r);
      }
      if (tk && m === "POST") {
        const s2 = getSession(req);
        if (!s2) return json(res, 401, { error:"请先登录" });
        const body = await readBody(req);
        const r = trainerSession(s2.userId, tk[1], body);
        return json(res, r.error ? 404 : 200, r.error ? { error: r.error } : r);
      }
    }
    {
      const actionMatch = /^\/api\/library\/entries\/([A-Za-z0-9-]+)\/(favorite|collect|comments)$/.exec(p);
      if (actionMatch && m === "POST") {
        const [, id, action] = actionMatch;
        const body = await readBody(req);
        const result = action === "favorite" ? toggleLibraryStar(s.userId, id) : action === "collect" ? collectLibraryEntry(s.userId, id) : addLibraryComment(s.userId, id, body.text);
        if (result.error) return json(res, 400, result);
        return json(res, 200, result);
      }
      const deleteCommentMatch = /^\/api\/library\/entries\/([A-Za-z0-9-]+)\/comments\/([A-Za-z0-9-]+)$/.exec(p);
      if (deleteCommentMatch && m === "DELETE") {
        const result = deleteLibraryComment(s.userId, deleteCommentMatch[1], deleteCommentMatch[2]);
        if (result.error) return json(res, 400, result);
        return json(res, 200, result);
      }
      const deleteMatch = /^\/api\/library\/entries\/([A-Za-z0-9-]+)$/.exec(p);
      if (deleteMatch && m === "DELETE") {
        const result = deleteLibraryEntry(s.userId, deleteMatch[1]);
        if (result.error) return json(res, 400, result);
        return json(res, 200, result);
      }
    }

  return false;   // 未匹配到本模块的路由
};
