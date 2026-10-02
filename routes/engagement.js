"use strict";
/* S.T.A.R. 路由模块：每日任务与激励（排行榜 / 我的 / 领取）
 * 由 admin.js 的 handleApi 原样拆出（未改语义）。调用约定：
 *   - 由 handleApi 传入 ctx（req/res/p/m + 依赖超集；登录后的阶段还带 s）
 *   - 命中路由时直接用 json(res, ...) 写响应；调用方通过 res.headersSent / writableEnded
 *     判断「是否已被处理」，未处理则继续交给下一个模块。
 *   - 返回 false 仅表示「本模块没有匹配到路由」。 */

module.exports.public = async function (ctx) {
  const { req, res, p, m, u, json, readBody, ALL_ROLES, CHESS_RATING_MAX, CHESS_RATING_MIN, CHESS_RATING_START, CHESS_RATING_TIERS, CHESS_TIER_KEYS, RE_USERNAME, TACTICS_LEVELS_PER_TIER, TACTICS_TIERS, TACTICS_TIER_DEFS, TACTICS_TITLES, addLibraryComment, applyTacticsAttempt, chessLeaderboard, chinaDay, claimDailyQuest, clearLoginFail, clientIp, collectLibraryEntry, controlEngine, cookieFlags, createLibraryEntry, createSession, currentTacticsPuzzle, deleteLibraryComment, deleteLibraryEntry, engagementLeaderboard, engineStatus, findLibraryEntry, findUser, finishChessRatingGame, getAccounts, getChessRating, getConfig, getCurrentToken, getGamesStats, getMetrics, getSession, getTactics, hasPerm, hashPassword, libraryList, libraryMine, libraryPublicEntry, listSessionsFor, litAccess, litComment, litDecideAccess, litDeleteComment, litGatedMeta, litKnown, litNotifications, litPublic, litRequestAccess, litToggleLike, loadLibrary, loadLit, loadLitContent, loadSessions, loginAllowed, logoutAllFor, logoutOthers, normalizeDayFlags, normalizeUser, noteLoginFail, publicChessRating, publicEngagement, publicPuzzle, publicTactics, rateCheck, registerLibraryView, saveAccounts, saveConfig, saveSessions, saveUserTactics, startChessRatingGame, startTacticsAttempt, toggleLibraryStar, trainerImport, trainerLines, trainerRemove, trainerSession, validPassword, verifyPassword } = ctx;
    if (p === "/api/engagement/leaderboard" && m === "GET") {
      return json(res, 200, { leaderboard: engagementLeaderboard(u.searchParams.get("limit") || 5) });
    }

  return false;   // 未匹配到本模块的路由
};

module.exports.authed = async function (ctx) {
  const { req, res, p, m, u, json, readBody, s, ALL_ROLES, CHESS_RATING_MAX, CHESS_RATING_MIN, CHESS_RATING_START, CHESS_RATING_TIERS, CHESS_TIER_KEYS, RE_USERNAME, TACTICS_LEVELS_PER_TIER, TACTICS_TIERS, TACTICS_TIER_DEFS, TACTICS_TITLES, addLibraryComment, applyTacticsAttempt, chessLeaderboard, chinaDay, claimDailyQuest, clearLoginFail, clientIp, collectLibraryEntry, controlEngine, cookieFlags, createLibraryEntry, createSession, currentTacticsPuzzle, deleteLibraryComment, deleteLibraryEntry, engagementLeaderboard, engineStatus, findLibraryEntry, findUser, finishChessRatingGame, getAccounts, getChessRating, getConfig, getCurrentToken, getGamesStats, getMetrics, getSession, getTactics, hasPerm, hashPassword, libraryList, libraryMine, libraryPublicEntry, listSessionsFor, litAccess, litComment, litDecideAccess, litDeleteComment, litGatedMeta, litKnown, litNotifications, litPublic, litRequestAccess, litToggleLike, loadLibrary, loadLit, loadLitContent, loadSessions, loginAllowed, logoutAllFor, logoutOthers, normalizeDayFlags, normalizeUser, noteLoginFail, publicChessRating, publicEngagement, publicPuzzle, publicTactics, rateCheck, registerLibraryView, saveAccounts, saveConfig, saveSessions, saveUserTactics, startChessRatingGame, startTacticsAttempt, toggleLibraryStar, trainerImport, trainerLines, trainerRemove, trainerSession, validPassword, verifyPassword } = ctx;
  
    // 成长中心：打开页面即生成当天活跃报告；领奖时再次由服务端校验完成条件。
    if (p === "/api/engagement/me" && m === "GET") {
      return json(res, 200, publicEngagement(s.userId, true));
    }
    if (p === "/api/engagement/claim" && m === "POST") {
      const body = await readBody(req);
      const result = claimDailyQuest(s.userId, String(body.questId || ""));
      if (result.error) return json(res, 400, { error:result.error });
      return json(res, 200, Object.assign({ ok:true }, result));
    }

  return false;   // 未匹配到本模块的路由
};
