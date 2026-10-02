"use strict";
/* S.T.A.R. 路由模块：题型闯关（配置 / 进度 / 每日 / 选阶 / 作答）
 * 由 admin.js 的 handleApi 原样拆出（未改语义）。调用约定：
 *   - 由 handleApi 传入 ctx（req/res/p/m + 依赖超集；登录后的阶段还带 s）
 *   - 命中路由时直接用 json(res, ...) 写响应；调用方通过 res.headersSent / writableEnded
 *     判断「是否已被处理」，未处理则继续交给下一个模块。
 *   - 返回 false 仅表示「本模块没有匹配到路由」。 */

module.exports.public = async function (ctx) {
  const { req, res, p, m, u, json, readBody, ALL_ROLES, CHESS_RATING_MAX, CHESS_RATING_MIN, CHESS_RATING_START, CHESS_RATING_TIERS, CHESS_TIER_KEYS, RE_USERNAME, TACTICS_LEVELS_PER_TIER, TACTICS_TIERS, TACTICS_TIER_DEFS, TACTICS_TITLES, addLibraryComment, applyTacticsAttempt, chessLeaderboard, chinaDay, claimDailyQuest, clearLoginFail, clientIp, collectLibraryEntry, controlEngine, cookieFlags, createLibraryEntry, createSession, currentTacticsPuzzle, deleteLibraryComment, deleteLibraryEntry, engagementLeaderboard, engineStatus, findLibraryEntry, findUser, finishChessRatingGame, getAccounts, getChessRating, getConfig, getCurrentToken, getGamesStats, getMetrics, getSession, getTactics, hasPerm, hashPassword, libraryList, libraryMine, libraryPublicEntry, listSessionsFor, litAccess, litComment, litDecideAccess, litDeleteComment, litGatedMeta, litKnown, litNotifications, litPublic, litRequestAccess, litToggleLike, loadLibrary, loadLit, loadLitContent, loadSessions, loginAllowed, logoutAllFor, logoutOthers, normalizeDayFlags, normalizeUser, noteLoginFail, publicChessRating, publicEngagement, publicPuzzle, publicTactics, rateCheck, registerLibraryView, saveAccounts, saveConfig, saveSessions, saveUserTactics, startChessRatingGame, startTacticsAttempt, toggleLibraryStar, trainerImport, trainerLines, trainerRemove, trainerSession, validPassword, verifyPassword } = ctx;
  
    // 题型配置公开；账号进度仍需登录后按 userId 拉取
    if (p === "/api/tactics/config" && m === "GET") {
      return json(res, 200, {
        tiers: TACTICS_TIER_DEFS.map(t => Object.assign({ levels: TACTICS_LEVELS_PER_TIER }, t)),
        levelsPerTier: TACTICS_LEVELS_PER_TIER,
        titleDefs: TACTICS_TITLES,
      });
    }

  return false;   // 未匹配到本模块的路由
};

module.exports.authed = async function (ctx) {
  const { req, res, p, m, u, json, readBody, s, ALL_ROLES, CHESS_RATING_MAX, CHESS_RATING_MIN, CHESS_RATING_START, CHESS_RATING_TIERS, CHESS_TIER_KEYS, RE_USERNAME, TACTICS_LEVELS_PER_TIER, TACTICS_TIERS, TACTICS_TIER_DEFS, TACTICS_TITLES, addLibraryComment, applyTacticsAttempt, chessLeaderboard, chinaDay, claimDailyQuest, clearLoginFail, clientIp, collectLibraryEntry, controlEngine, cookieFlags, createLibraryEntry, createSession, currentTacticsPuzzle, deleteLibraryComment, deleteLibraryEntry, engagementLeaderboard, engineStatus, findLibraryEntry, findUser, finishChessRatingGame, getAccounts, getChessRating, getConfig, getCurrentToken, getGamesStats, getMetrics, getSession, getTactics, hasPerm, hashPassword, libraryList, libraryMine, libraryPublicEntry, listSessionsFor, litAccess, litComment, litDecideAccess, litDeleteComment, litGatedMeta, litKnown, litNotifications, litPublic, litRequestAccess, litToggleLike, loadLibrary, loadLit, loadLitContent, loadSessions, loginAllowed, logoutAllFor, logoutOthers, normalizeDayFlags, normalizeUser, noteLoginFail, publicChessRating, publicEngagement, publicPuzzle, publicTactics, rateCheck, registerLibraryView, saveAccounts, saveConfig, saveSessions, saveUserTactics, startChessRatingGame, startTacticsAttempt, toggleLibraryStar, trainerImport, trainerLines, trainerRemove, trainerSession, validPassword, verifyPassword } = ctx;
  
    // 题型闯关进度（账号持久化，跨设备同步）
    if (p === "/api/tactics/progress" && m === "GET") {
      return json(res, 200, { progress: publicTactics(getTactics(s.userId)) });
    }
    // 每日残局完成上报：把「今日已完成」落到账号上，使换设备后不再显示"今日未完成"。
    // 该标记只影响一个勾选状态、不给任何奖励，因此接受客户端日期；
    // 但日期必须是合法 YYYY-MM-DD 且与服务端（Asia/Shanghai）相差不超过 1 天，防止回填历史刷记录。
    if (p === "/api/tactics/daily-done" && m === "POST") {
      const body = await readBody(req);
      const raw = String(body.date || "");
      const serverDay = chinaDay();
      const day = (/^\d{4}-\d{2}-\d{2}$/.test(raw) && Math.abs(Date.parse(raw) - Date.parse(serverDay)) <= 86400000)
        ? raw : serverDay;
      const prog = getTactics(s.userId);
      prog.dailyDone = normalizeDayFlags(prog.dailyDone);
      prog.dailyDone[day] = true;
      prog.updatedAt = Date.now();
      saveUserTactics(s.userId, prog);
      return json(res, 200, { ok: true, date: day, progress: publicTactics(prog) });
    }
    if ((p === "/api/tactics/select-tier" || p === "/api/tactics/current") && (m === "POST" || m === "GET")) {
      const body = m === "POST" ? await readBody(req) : {};
      const tier = body.tier || u.searchParams.get("tier") || getTactics(s.userId).selectedTier || "beginner";
      if (!TACTICS_TIERS.includes(tier)) return json(res, 400, { error: "难度档无效" });
      const prog = getTactics(s.userId);
      // 仅在难度档真的变化时落盘：原先 GET /api/tactics/current 即使 tier 不变也会写一次进度文件，
      // 让一个只读语义的 GET 每次调用都产生磁盘写入（Pi 上是 SD 卡）。
      if (prog.selectedTier !== tier) {
        prog.selectedTier = tier;
        saveUserTactics(s.userId, prog);
      }
      const cur = currentTacticsPuzzle(prog, tier);
      return json(res, 200, {
        tier, currentLevel: cur.levelNo, completed: !cur.puzzle,
        puzzle: publicPuzzle(cur.puzzle, true),
        progress: publicTactics(prog),
      });
    }
    if (p === "/api/tactics/attempt/start" && m === "POST") {
      const body = await readBody(req);
      const tier = body.tier;
      if (!TACTICS_TIERS.includes(tier)) return json(res, 400, { error: "难度档无效" });
      const started = startTacticsAttempt(s.userId, tier);
      if (started.error) return json(res, 400, { error: started.error, progress: publicTactics(started.prog) });
      return json(res, 200, {
        attemptId: started.attempt.id,
        tier: started.attempt.tier,
        levelNo: started.attempt.levelNo,
        puzzle: publicPuzzle(started.puzzle, true),
        progress: publicTactics(started.prog),
      });
    }
    if (p === "/api/tactics/attempt/submit" && m === "POST") {
      const body = await readBody(req);
      const result = applyTacticsAttempt(s.userId, body);
      if (result.error) return json(res, 400, { error: result.error });
      const attemptResult = result.attempt.result || {};
      return json(res, 200, {
        solved: !!attemptResult.solved,
        passed: !!attemptResult.solved,
        duplicate: !!result.duplicate,
        levelNo: attemptResult.levelNo || result.attempt.levelNo,
        nextLevel: attemptResult.nextLevel || (result.prog.tiers[result.attempt.tier] || {}).currentLevel,
        currentStreak: attemptResult.currentStreak || 0,
        newlyUnlockedTitles: result.newly.map(id => Object.assign({ id }, TACTICS_TITLES.find(t => t.id === id) || {})),
        newly: result.newly,
        progress: publicTactics(result.prog),
      });
    }

  return false;   // 未匹配到本模块的路由
};
