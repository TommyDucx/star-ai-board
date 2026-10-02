"use strict";
/* S.T.A.R. 趣味玩法：残局闯关 + 猜大师下一步（均免登录，进度按 guestId / 账号记录）
 *
 * 残局闯关
 *   GET  /api/endgames                     关卡列表（含我的通关记录）
 *   POST /api/endgames/ai-move  {id,moves} 让 AI 应一手（服务端用 chess.js 复现玩家走子，
 *                                          不接受任意 FEN，避免匿名用户白嫖引擎）
 *   POST /api/endgames/finish   {id,moves,ms,result}  服务端独立校验目标是否达成后记录
 * 猜大师
 *   GET  /api/guess/games                  名局列表（含 SAN 着法序列）
 *   POST /api/guess/finish {gameId,guesses} 服务端独立评分并记录最好成绩
 */
const fs = require("fs");
const path = require("path");
const Chess = require("../public/js/lib/chess.min.js").Chess;

const ADMIN_DIR = path.join(__dirname, "..", "admin");
const PROGRESS_FILE = path.join(ADMIN_DIR, "fun_progress.json");

/* ============ 残局关卡（FEN 均经 chess.js 校验合法） ============ */
const PUZZLES = [
  {
    id: "rook-basic", title: "单车杀王 · 入门", theme: "rook", goal: "mate", side: "w",
    fen: "8/8/8/4k3/8/8/8/K6R w - - 0 1", moveLimit: 20, seconds: 300, elo: 1320,
    desc: "单车对单王：先用王与车压缩空间，把对方王逼到边线，再在底线将杀。",
  },
  {
    id: "rook-corner", title: "单车杀王 · 逼角", theme: "rook", goal: "mate", side: "w",
    fen: "8/8/8/8/8/1k6/8/K1R5 w - - 0 1", moveLimit: 22, seconds: 300, elo: 1400,
    desc: "黑王已进入腰部：先用车切断逃逸路线，再收网。",
  },
  {
    id: "kbn-mate", title: "马象杀单王", theme: "kbn", goal: "mate", side: "w",
    fen: "8/8/8/8/8/2k5/8/KBN5 w - - 0 1", moveLimit: 40, seconds: 600, elo: 1500,
    desc: "最难的基础残局：把王赶向与象同色的角（a8 或 h1），再用马封住逃生格。",
  },
  {
    id: "pawn-race", title: "兵残局对攻", theme: "pawn", goal: "promote", side: "w",
    fen: "7p/8/8/8/P7/8/8/K6k w - - 0 1", moveLimit: 12, seconds: 240, elo: 1250,
    desc: "双方各有一个通路兵：你恰好快一个节奏，先升变就锁定胜局。",
  },
];
const PUZZLE_MAP = new Map(PUZZLES.map(x => [x.id, x]));

/* ============ 猜大师：历史名局（SAN 序列，服务端校验） ============ */
const GAMES = [
  {
    id: "opera-1858", title: "歌剧院之局", white: "Paul Morphy", black: "Duke Karl / Count Isouard",
    year: 1858, event: "巴黎歌剧院", guessSide: "w",
    blurb: "莫菲在歌剧院包厢里下出的教科书级攻击：弃后、弃车，用双象与双车完成绝杀。",
    moves: ["e4", "e5", "Nf3", "d6", "d4", "Bg4", "dxe5", "Bxf3", "Qxf3", "dxe5", "Bc4", "Nf6", "Qb3", "Qe7", "Nc3", "c6", "Bg5", "b5", "Nxb5", "cxb5", "Bxb5+", "Nbd7", "O-O-O", "Rd8", "Rxd7", "Rxd7", "Rd1", "Qe6", "Bxd7+", "Nxd7", "Qb8+", "Nxb8", "Rd8#"],
  },
  {
    id: "reti-1910", title: "雷蒂的弃后杀", white: "Richard Réti", black: "Savielly Tartakower",
    year: 1910, event: "维也纳", guessSide: "w",
    blurb: "11 回合的极短杀局：弃后引王，双象完成将杀。",
    moves: ["e4", "c6", "d4", "d5", "Nc3", "dxe4", "Nxe4", "Nf6", "Qd3", "e5", "dxe5", "Qa5+", "Bd2", "Qxe5", "O-O-O", "Nxe4", "Qd8+", "Kxd8", "Bg5+", "Kc7", "Bd8#"],
  },
  {
    id: "legal-1750", title: "雷加尔杀法", white: "Legall de Kermeur", black: "Saint Brie",
    year: 1750, event: "巴黎", guessSide: "w",
    blurb: "最古老的著名陷阱：弃后之后，双马与象在三步内完成将杀。",
    moves: ["e4", "e5", "Bc4", "d6", "Nf3", "Bg4", "Nc3", "g6", "Nxe5", "Bxd1", "Bxf7+", "Ke7", "Nd5#"],
  },
  {
    id: "lasker-1912", title: "王的远征", white: "Edward Lasker", black: "George Thomas",
    year: 1912, event: "伦敦", guessSide: "w",
    blurb: "史上最著名的弃后攻王：黑王被一路赶到己方底线，最后被自己的棋子困死。",
    moves: ["d4", "e6", "Nf3", "f5", "Nc3", "Nf6", "Bg5", "Be7", "Bxf6", "Bxf6", "e4", "fxe4", "Nxe4", "b6", "Ne5", "O-O", "Bd3", "Bb7", "Qh5", "Qe7", "Qxh7+", "Kxh7", "Nxf6+", "Kh6", "Neg4+", "Kg5", "h4+", "Kf4", "g3+", "Kf3", "Be2+", "Kg2", "Rh2+", "Kg1", "Kd2#"],
  },
];

/* ---------- 关卡合法性自检（启动时跑一次，防止手写 FEN 出错） ---------- */
function validatePuzzles() {
  const bad = [];
  for (const pz of PUZZLES) {
    try { const c = new Chess(); c.load(pz.fen); if (!c.moves().length) bad.push(pz.id + "(无合法着法)"); }
    catch (e) { bad.push(pz.id + "(FEN 非法)"); }
  }
  return bad;
}
function validateGames() {
  const bad = [];
  for (const g of GAMES) {
    try {
      const c = new Chess();
      for (let i = 0; i < g.moves.length; i++) {
        const mv = c.move(g.moves[i]);
        if (!mv) { bad.push(g.id + " 第" + (i + 1) + "步 " + g.moves[i]); break; }
      }
    } catch (e) { bad.push(g.id + "(" + e.message + ")"); }
  }
  return bad;
}

/* ---------- 进度存储 ---------- */
function loadProgress() {
  try {
    const v = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}
function saveProgress(v) {
  try {
    if (!fs.existsSync(ADMIN_DIR)) fs.mkdirSync(ADMIN_DIR, { recursive: true });
    const tmp = PROGRESS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, PROGRESS_FILE);
  } catch {}
}
function keyOf(ctx, fallbackGuest) {
  try {
    const s = ctx.getSession ? ctx.getSession(ctx.req) : null;
    if (s && s.userId) return "u:" + s.userId;
  } catch {}
  const g = String(fallbackGuest || "").slice(0, 64);
  return g ? "g:" + g : null;
}

/* ---------- 用 chess.js 复现走子（拒绝任意 FEN） ---------- */
function replay(startFen, moves, maxPly) {
  const c = new Chess();
  c.load(startFen);
  const applied = [];
  for (const mv of (Array.isArray(moves) ? moves.slice(0, maxPly) : [])) {
    const r = c.move({ from: String(mv && mv.from || ""), to: String(mv && mv.to || ""), promotion: (mv && mv.promotion) || "q" });
    if (!r) return { error: "走子序列非法：第 " + (applied.length + 1) + " 步", c: null };
    applied.push({ from: r.from, to: r.to, san: r.san });
  }
  return { c, applied };
}
function goalMet(c, goal) {
  if (goal === "mate") return !!(c.in_checkmate && c.in_checkmate());
  if (goal === "promote") {
    // 复现后若场上出现额外的后（升变发生）即算达成
    const board = c.board();
    let queens = 0;
    for (const row of board) for (const sq of row) if (sq && sq.type === "q") queens++;
    return queens > 1;                       // 初始每方 1 后；多出的后 = 完成升变
  }
  return false;
}

module.exports.public = async function (ctx) {
  const { req, res, p, m, u, json, readBody, clientIp, rateCheck, engineMove } = ctx;

  /* ---------- 残局：关卡列表 ---------- */
  if (p === "/api/endgames" && m === "GET") {
    const k = keyOf(ctx, u.searchParams.get("guestId"));
    const prog = k ? (loadProgress()[k] || {}) : {};
    return json(res, 200, {
      puzzles: PUZZLES.map(x => ({
        id: x.id, title: x.title, theme: x.theme, goal: x.goal, fen: x.fen, side: x.side,
        moveLimit: x.moveLimit, seconds: x.seconds, elo: x.elo, desc: x.desc,
        solved: !!prog[x.id], best: prog[x.id] || null,
      })),
      loggedIn: k ? k.startsWith("u:") : false,
    });
  }

  /* ---------- 残局：AI 应手（只服务固定关卡） ---------- */
  if (p === "/api/endgames/ai-move" && m === "POST") {
    if (!rateCheck("eg:ai:" + clientIp(req), 120, 60000))
      return json(res, 429, { error: "请求过于频繁，请稍后再试" });
    const body = await readBody(req);
    const pz = PUZZLE_MAP.get(String(body.id || ""));
    if (!pz) return json(res, 404, { error: "关卡不存在" });
    const r = replay(pz.fen, body.moves, pz.moveLimit * 2 + 2);
    if (r.error) return json(res, 400, { error: r.error });
    const c = r.c;
    if (c.game_over()) return json(res, 200, { over: true, fen: c.fen(), goal: goalMet(c, pz.goal) });
    let mv;
    try {
      const out = await engineMove(c.fen(), { engine: "my-engine", elo: pz.elo, movetime: 300 });
      mv = out && (out.bestmove || out.move);
    } catch (e) { mv = null; }
    if (!mv || typeof mv !== "string" || mv.length < 4) {       // 引擎异常时退化到随机合法着法
      const legal = c.moves({ verbose: true });
      if (!legal.length) return json(res, 200, { over: true, fen: c.fen() });
      const pick = legal[Math.floor(Math.random() * legal.length)];
      mv = pick.from + pick.to + (pick.promotion || "");
    }
    const applied = c.move({ from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv.slice(4, 5) || "q" });
    if (!applied) return json(res, 500, { error: "引擎着法无法执行" });
    return json(res, 200, {
      move: { from: applied.from, to: applied.to, san: applied.san },
      fen: c.fen(),
      over: c.game_over(),
      goal: goalMet(c, pz.goal),
      check: c.in_check ? c.in_check() : false,
    });
  }

  /* ---------- 残局：提交结果（服务端独立校验） ---------- */
  if (p === "/api/endgames/finish" && m === "POST") {
    const body = await readBody(req);
    const pz = PUZZLE_MAP.get(String(body.id || ""));
    if (!pz) return json(res, 404, { error: "关卡不存在" });
    const r = replay(pz.fen, body.moves, pz.moveLimit * 2 + 2);
    if (r.error) return json(res, 400, { error: r.error });
    const ok = goalMet(r.c, pz.goal);
    const elapsed = Math.max(0, Math.min(3600000, Number(body.ms) || 0));
    const k = keyOf(ctx, body.guestId);
    let record = null;
    if (ok && k) {
      const all = loadProgress();
      const mine = all[k] || {};
      const prev = mine[pz.id];
      const cur = { bestMs: prev && prev.bestMs ? Math.min(prev.bestMs, elapsed) : elapsed, moves: r.applied.length, at: Date.now(), count: (prev && prev.count ? prev.count : 0) + 1 };
      mine[pz.id] = cur; all[k] = mine; saveProgress(all);
      record = cur;
    }
    return json(res, 200, { ok, goal: pz.goal, achieved: ok, verifiedMoves: r.applied.length, record });
  }

  /* ---------- 猜大师：名局列表 ---------- */
  if (p === "/api/guess/games" && m === "GET") {
    const k = keyOf(ctx, u.searchParams.get("guestId"));
    const prog = k ? (loadProgress()["guess:" + k] || {}) : {};
    return json(res, 200, {
      games: GAMES.map(g => ({
        id: g.id, title: g.title, white: g.white, black: g.black, year: g.year,
        event: g.event, guessSide: g.guessSide, blurb: g.blurb,
        plies: g.moves.length, best: prog[g.id] || null,
      })),
    });
  }

  /* ---------- 猜大师：下载某局完整着法（开始挑战时才拉取） ---------- */
  let gm = /^\/api\/guess\/games\/([a-z0-9-]{3,32})$/.exec(p);
  if (gm && m === "GET") {
    const g = GAMES.find(x => x.id === gm[1]);
    if (!g) return json(res, 404, { error: "对局不存在" });
    return json(res, 200, { game: { id: g.id, title: g.title, white: g.white, black: g.black, year: g.year, event: g.event, guessSide: g.guessSide, blurb: g.blurb, moves: g.moves } });
  }

  /* ---------- 猜大师：服务端评分 ---------- */
  if (p === "/api/guess/finish" && m === "POST") {
    const body = await readBody(req);
    const g = GAMES.find(x => x.id === String(body.gameId || ""));
    if (!g) return json(res, 404, { error: "对局不存在" });
    // 逐步比对：完全命中 100 / 同棋子（子力类型一致）60 / 同目标格 40 / 其他合法着法 10 / 非法 0
    const c = new Chess();
    const guesses = Array.isArray(body.guesses) ? body.guesses : [];
    const detail = [];
    let score = 0, exact = 0, total = 0;
    for (let i = 0; i < g.moves.length; i++) {
      const guess = guesses.find(x => Number(x.ply) === i);
      const fenBefore = c.fen();                          // 「猜之前」的局面（用于独立重建玩家着法）
      const mvReal = c.move(g.moves[i]);                  // 真实着法（推进局面）
      if (!mvReal) break;
      // 玩家只在 guessSide 行棋的回合猜（对手回合直接跳过，不计分）
      const mover = i % 2 === 0 ? "w" : "b";
      if (mover !== g.guessSide) continue;
      total++;
      let got = 0, kind = "miss";
      if (guess && guess.from && guess.to) {
        const gc = new Chess(); gc.load(fenBefore);
        let mvGuess = null;
        try { mvGuess = gc.move({ from: String(guess.from), to: String(guess.to), promotion: "q" }); } catch { mvGuess = null; }
        if (mvGuess) {
          if (mvGuess.san === mvReal.san) { got = 100; kind = "exact"; exact++; }
          else if (mvGuess.piece === mvReal.piece) { got = 60; kind = "piece"; }
          else if (mvGuess.to === mvReal.to) { got = 40; kind = "target"; }
          else { got = 10; kind = "other"; }
        }
      }
      score += got;
      detail.push({ ply: i, actual: mvReal.san, got, kind });
    }
    const accuracy = total ? Math.round(score / total) : 0;
    const grade = accuracy >= 90 ? "大师级" : accuracy >= 70 ? "优秀" : accuracy >= 45 ? "不俗" : accuracy >= 20 ? "还需磨练" : "初窥门径";
    const k = keyOf(ctx, body.guestId);
    let best = null;
    if (k) {
      const all = loadProgress();
      const mine = all["guess:" + k] || {};
      const prev = mine[g.id];
      if (!prev || accuracy > prev.accuracy) { mine[g.id] = { accuracy, score, exact, total, at: Date.now() }; all["guess:" + k] = mine; saveProgress(all); }
      best = all["guess:" + k][g.id];
    }
    return json(res, 200, { score, accuracy, exact, total, grade, detail, best });
  }

  return false;
};


module.exports._diagnostics = () => ({ puzzleErrors: validatePuzzles(), gameErrors: validateGames() });
