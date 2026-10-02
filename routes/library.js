"use strict";
/* S.T.A.R. 路由模块：共享棋谱库（目录 / 热度 / 我的收藏与投稿）
 * 由 admin.js 的 handleApi 原样拆出（未改语义）。调用约定：
 *   - 由 handleApi 传入 ctx（req/res/p/m + 依赖超集；登录后的阶段还带 s）
 *   - 命中路由时直接用 json(res, ...) 写响应；调用方通过 res.headersSent / writableEnded
 *     判断「是否已被处理」，未处理则继续交给下一个模块。
 *   - 返回 false 仅表示「本模块没有匹配到路由」。 */

module.exports.public = async function (ctx) {
  const { req, res, p, m, u, json, readBody, ALL_ROLES, CHESS_RATING_MAX, CHESS_RATING_MIN, CHESS_RATING_START, CHESS_RATING_TIERS, CHESS_TIER_KEYS, RE_USERNAME, TACTICS_LEVELS_PER_TIER, TACTICS_TIERS, TACTICS_TIER_DEFS, TACTICS_TITLES, addLibraryComment, applyTacticsAttempt, chessLeaderboard, chinaDay, claimDailyQuest, clearLoginFail, clientIp, collectLibraryEntry, controlEngine, cookieFlags, createLibraryEntry, createSession, currentTacticsPuzzle, deleteLibraryComment, deleteLibraryEntry, engagementLeaderboard, engineStatus, findLibraryEntry, findUser, finishChessRatingGame, getAccounts, getChessRating, getConfig, getCurrentToken, getGamesStats, getMetrics, getSession, getTactics, hasPerm, hashPassword, libraryList, libraryMine, libraryPublicEntry, listSessionsFor, litAccess, litComment, litDecideAccess, litDeleteComment, litGatedMeta, litKnown, litNotifications, litPublic, litRequestAccess, litToggleLike, loadLibrary, loadLit, loadLitContent, loadSessions, loginAllowed, logoutAllFor, logoutOthers, normalizeDayFlags, normalizeUser, noteLoginFail, publicChessRating, publicEngagement, publicPuzzle, publicTactics, rateCheck, registerLibraryView, saveAccounts, saveConfig, saveSessions, saveUserTactics, startChessRatingGame, startTacticsAttempt, toggleLibraryStar, trainerImport, trainerLines, trainerRemove, trainerSession, validPassword, verifyPassword } = ctx;
    // 共享棋谱库：目录与详情公开可读；登录后会额外返回本人收藏/投稿状态。
    if (p === "/api/library/entries" && m === "GET") {
      const peek = getSession(req);
      return json(res, 200, libraryList(peek && peek.userId, u.searchParams));
    }
    {
      // 研读热度：打开详情时由前端 POST 上报（POST 才产生写盘，符合“只读 GET 无副作用”的约定）
      const viewMatch = /^\/api\/library\/entries\/([A-Za-z0-9-]+)\/view$/.exec(p);
      if (viewMatch && m === "POST") {
        if (!rateCheck("libview:" + clientIp(req), 30, 60000)) return json(res, 429, { error:"上报过于频繁" });
        const views = registerLibraryView(viewMatch[1]);
        if (views == null) return json(res, 404, { error:"资料不存在或已撤下" });
        return json(res, 200, { ok:true, views });
      }
      const detailMatch = /^\/api\/library\/entries\/([A-Za-z0-9-]+)$/.exec(p);
      if (detailMatch && m === "GET") {
        const data = loadLibrary(), entry = findLibraryEntry(data, detailMatch[1]);
        if (!entry) return json(res, 404, { error:"资料不存在或已撤下" });
        const peek = getSession(req);
        return json(res, 200, { entry:libraryPublicEntry(entry, peek && peek.userId, true) });
      }
    }

  return false;   // 未匹配到本模块的路由
};

module.exports.authed = async function (ctx) {
  const { req, res, p, m, u, json, readBody, s, ALL_ROLES, CHESS_RATING_MAX, CHESS_RATING_MIN, CHESS_RATING_START, CHESS_RATING_TIERS, CHESS_TIER_KEYS, RE_USERNAME, TACTICS_LEVELS_PER_TIER, TACTICS_TIERS, TACTICS_TIER_DEFS, TACTICS_TITLES, addLibraryComment, applyTacticsAttempt, chessLeaderboard, chinaDay, claimDailyQuest, clearLoginFail, clientIp, collectLibraryEntry, controlEngine, cookieFlags, createLibraryEntry, createSession, currentTacticsPuzzle, deleteLibraryComment, deleteLibraryEntry, engagementLeaderboard, engineStatus, findLibraryEntry, findUser, finishChessRatingGame, getAccounts, getChessRating, getConfig, getCurrentToken, getGamesStats, getMetrics, getSession, getTactics, hasPerm, hashPassword, libraryList, libraryMine, libraryPublicEntry, listSessionsFor, litAccess, litComment, litDecideAccess, litDeleteComment, litGatedMeta, litKnown, litNotifications, litPublic, litRequestAccess, litToggleLike, loadLibrary, loadLit, loadLitContent, loadSessions, loginAllowed, logoutAllFor, logoutOthers, normalizeDayFlags, normalizeUser, noteLoginFail, publicChessRating, publicEngagement, publicPuzzle, publicTactics, rateCheck, registerLibraryView, saveAccounts, saveConfig, saveSessions, saveUserTactics, startChessRatingGame, startTacticsAttempt, toggleLibraryStar, trainerImport, trainerLines, trainerRemove, trainerSession, validPassword, verifyPassword } = ctx;
  
    // 共享棋谱库：写操作全部绑定当前账号，不能由前端伪造作者或收藏人。
    if (p === "/api/library/entries" && m === "POST") {
      const result = createLibraryEntry(s.userId, await readBody(req));
      if (result.error) return json(res, 400, result);
      return json(res, 201, result);
    }
    if (p === "/api/library/me" && m === "GET") return json(res, 200, libraryMine(s.userId));

  return false;   // 未匹配到本模块的路由
};
