"use strict";
/* S.T.A.R. 路由模块：棋力评估（配置 / 排行榜 / 对局结算）
 * 由 admin.js 的 handleApi 原样拆出（未改语义）。调用约定：
 *   - 由 handleApi 传入 ctx（req/res/p/m + 依赖超集；登录后的阶段还带 s）
 *   - 命中路由时直接用 json(res, ...) 写响应；调用方通过 res.headersSent / writableEnded
 *     判断「是否已被处理」，未处理则继续交给下一个模块。
 *   - 返回 false 仅表示「本模块没有匹配到路由」。 */

module.exports.public = async function (ctx) {
  const { req, res, p, m, u, json, readBody, ALL_ROLES, CHESS_RATING_MAX, CHESS_RATING_MIN, CHESS_RATING_START, CHESS_RATING_TIERS, CHESS_TIER_KEYS, RE_USERNAME, TACTICS_LEVELS_PER_TIER, TACTICS_TIERS, TACTICS_TIER_DEFS, TACTICS_TITLES, addLibraryComment, applyTacticsAttempt, chessLeaderboard, chinaDay, claimDailyQuest, clearLoginFail, clientIp, collectLibraryEntry, controlEngine, cookieFlags, createLibraryEntry, createSession, currentTacticsPuzzle, deleteLibraryComment, deleteLibraryEntry, engagementLeaderboard, engineStatus, findLibraryEntry, findUser, finishChessRatingGame, getAccounts, getChessRating, getConfig, getCurrentToken, getGamesStats, getMetrics, getSession, getTactics, hasPerm, hashPassword, libraryList, libraryMine, libraryPublicEntry, listSessionsFor, litAccess, litComment, litDecideAccess, litDeleteComment, litGatedMeta, litKnown, litNotifications, litPublic, litRequestAccess, litToggleLike, loadLibrary, loadLit, loadLitContent, loadSessions, loginAllowed, logoutAllFor, logoutOthers, normalizeDayFlags, normalizeUser, noteLoginFail, publicChessRating, publicEngagement, publicPuzzle, publicTactics, rateCheck, registerLibraryView, saveAccounts, saveConfig, saveSessions, saveUserTactics, startChessRatingGame, startTacticsAttempt, toggleLibraryStar, trainerImport, trainerLines, trainerRemove, trainerSession, validPassword, verifyPassword } = ctx;
  
    // 棋力评估排行榜公开展示；个人棋力和测评结算仍需登录
    if (p === "/api/chess-rating/leaderboard" && m === "GET") {
      return json(res, 200, { leaderboard: chessLeaderboard(u.searchParams.get("limit") || 3) });
    }
    if (p === "/api/chess-rating/me" && m === "GET") {
      const peek = getSession(req);
      if (!peek) return json(res, 200, { authenticated: false, progress: null });
      const acc = getAccounts().find(a => a.id === peek.userId);
      if (!acc || acc.status !== "active") return json(res, 200, { authenticated: false, progress: null });
      return json(res, 200, {
        authenticated: true,
        mustChange: !!acc.mustChange,
        progress: acc.mustChange ? null : publicChessRating(getChessRating(peek.userId)),
      });
    }

  return false;   // 未匹配到本模块的路由
};

module.exports.authed = async function (ctx) {
  const { req, res, p, m, u, json, readBody, s, ALL_ROLES, CHESS_RATING_MAX, CHESS_RATING_MIN, CHESS_RATING_START, CHESS_RATING_TIERS, CHESS_TIER_KEYS, RE_USERNAME, TACTICS_LEVELS_PER_TIER, TACTICS_TIERS, TACTICS_TIER_DEFS, TACTICS_TITLES, addLibraryComment, applyTacticsAttempt, chessLeaderboard, chinaDay, claimDailyQuest, clearLoginFail, clientIp, collectLibraryEntry, controlEngine, cookieFlags, createLibraryEntry, createSession, currentTacticsPuzzle, deleteLibraryComment, deleteLibraryEntry, engagementLeaderboard, engineStatus, findLibraryEntry, findUser, finishChessRatingGame, getAccounts, getChessRating, getConfig, getCurrentToken, getGamesStats, getMetrics, getSession, getTactics, hasPerm, hashPassword, libraryList, libraryMine, libraryPublicEntry, listSessionsFor, litAccess, litComment, litDecideAccess, litDeleteComment, litGatedMeta, litKnown, litNotifications, litPublic, litRequestAccess, litToggleLike, loadLibrary, loadLit, loadLitContent, loadSessions, loginAllowed, logoutAllFor, logoutOthers, normalizeDayFlags, normalizeUser, noteLoginFail, publicChessRating, publicEngagement, publicPuzzle, publicTactics, rateCheck, registerLibraryView, saveAccounts, saveConfig, saveSessions, saveUserTactics, startChessRatingGame, startTacticsAttempt, toggleLibraryStar, trainerImport, trainerLines, trainerRemove, trainerSession, validPassword, verifyPassword } = ctx;
    // 注：已移除 /api/tactics/result 死路由——public/ 无任何调用方，且允许客户端
    // 直接传 solved:true 一键通关（反作弊绕过）。正式流程走 /api/tactics/attempt/start + submit。
  
    // 棋力评估（账号持久化，跨设备同步）
    if (p === "/api/chess-rating/config" && m === "GET") {
      return json(res, 200, {
        tiers: CHESS_RATING_TIERS,
        limits: { min: CHESS_RATING_MIN, max: CHESS_RATING_MAX, start: CHESS_RATING_START },
      });
    }
    if (p === "/api/chess-rating/game/start" && m === "POST") {
      const body = await readBody(req);
      if (body.tier && !CHESS_TIER_KEYS.includes(body.tier)) return json(res, 400, { error: "难度档无效" });
      if (body.color && !["white", "black", "random"].includes(body.color)) return json(res, 400, { error: "执棋方无效" });
      const game = startChessRatingGame(s.userId, body);
      return json(res, 200, {
        gameId: game.id, tier: game.tier, color: game.color,
        engine: game.engine, engineElo: game.engineElo, movetime: game.movetime,
        progress: publicChessRating(getChessRating(s.userId)),
      });
    }
    if (p === "/api/chess-rating/game/finish" && m === "POST") {
      const body = await readBody(req);
      const result = finishChessRatingGame(s.userId, body);
      if (result.error) return json(res, 400, { error: result.error });
      return json(res, 200, {
        record: result.record,
        progress: publicChessRating(result.progress),
        leaderboard: chessLeaderboard(3),
      });
    }

  return false;   // 未匹配到本模块的路由
};
