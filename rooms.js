"use strict";
/**
 * S.T.A.R. 熟人邀请制轻量对局房间
 * ---------------------------------------------------------------
 * 设计要点
 *  · 免注册：访客用浏览器生成的 guestId 标识；入座时服务端发放 seat token，
 *    刷新/断线凭 token 恢复原座位（token 只存在本机 localStorage，不写进 URL）。
 *  · 角色：host(创建者=白方) / player(黑方) / spectator(观战，只读)。
 *    权限边界全部在服务端判定，前端展示只是观感。
 *  · 权威性：走子由服务端用 chess.js 校验（合法性 + 是否轮到该方），
 *    客户端传来的 fen 一律不信任。
 *  · 生命周期：waiting →(第二人就座) playing →(将杀/认输/超时/放弃/和棋) finished
 *    · waiting 30 分钟无人 → 回收
 *    · 双方都离线超过 seatHold(5min) 或双方主动离开超 emptyTtl(10min) → 回收
 *    · finished 后保留 2 小时可回看 → 回收
 *    · 房间总数上限 200，超限按最旧优先回收
 *  · 时钟：每方 10 分钟底时，走子时扣减实际用时；超时判负（由 sweep 定时器兜底）。
 *
 * 数据：admin/rooms.json（已在 .gitignore，不入库）
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Chess = require("./public/js/lib/chess.min.js").Chess;
const uploads = require("./uploads");   // 评论区附件（归属 = g:<guestId>）

const ADMIN_DIR = path.join(__dirname, "admin");
const ROOMS_FILE = path.join(ADMIN_DIR, "rooms.json");

const L = {
  maxSpectators: 20,          // 观战者上限
  seatHoldMs: 5 * 60 * 1000,  // 掉线保留座位时长（超时判放弃）
  waitingTtlMs: 30 * 60 * 1000,
  emptyTtlMs: 10 * 60 * 1000,
  finishedTtlMs: 2 * 60 * 60 * 1000,
  maxRooms: 200,
  baseMs: 10 * 60 * 1000,     // 每方底时
  maxChat: 60,
  maxMoves: 600,              // 单局最大步数（防脚本刷）
  moveGapMs: 120,             // 两次走子最小间隔（防抖/防脚本）
};

let rooms = new Map();        // id -> room
let dirty = false;
let sweepTimer = null;

/* ---------------- 持久化 ---------------- */
function load() {
  try {
    const v = JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8"));
    if (v && Array.isArray(v.rooms)) {
      rooms = new Map(v.rooms.filter(r => r && r.id).map(r => [r.id, r]));
    }
  } catch { rooms = new Map(); }
}
function saveNow() {
  try {
    if (!fs.existsSync(ADMIN_DIR)) fs.mkdirSync(ADMIN_DIR, { recursive: true });
    const tmp = ROOMS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, savedAt: Date.now(), rooms: [...rooms.values()] }), { mode: 0o600 });
    fs.renameSync(tmp, ROOMS_FILE);
    dirty = false;
  } catch (e) { /* 磁盘异常不影响内存对局 */ }
}
function save() { dirty = true; }

/* ---------------- 工具 ---------------- */
const uuid = () => crypto.randomUUID();
const token = () => crypto.randomBytes(18).toString("base64url");
const now = () => Date.now();
function safeName(n, fallback) {
  const s = String(n == null ? "" : n).replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim();
  return (s || fallback).slice(0, 16);
}
function newChess(fen) { const c = new Chess(); if (fen) { try { c.load(fen); } catch { /* 无效 FEN 用初始局面 */ } } return c; }

/* ---------------- 房间创建 ---------------- */
function create({ guestId, name }) {
  const id = uuid();
  const seat = { guestId: String(guestId || uuid()), token: token(), name: safeName(name, "房主"), connected: false, lastSeen: now(), ms: L.baseMs, joinedAt: now() };
  const room = {
    id, createdAt: now(), hostGuestId: seat.guestId,
    status: "waiting",                 // waiting | playing | finished
    seats: { w: seat, b: null },
    spectators: [],
    fen: new Chess().fen(),
    moves: [],
    chat: [],
    lastMoveAt: 0,
    startedAt: 0,
    endedAt: 0,
    result: null,
    lastActivity: now(),
    expiresAt: now() + L.waitingTtlMs,
    rev: 1,                            // 状态版本号：前端据此判断是否需要整体重取
  };
  rooms.set(id, room);
  trimRooms();
  save();
  return { room, token: seat.token, seat: "w" };
}

/* ---------------- 座位/观战入座 ---------------- */
/**
 * 重复进入同一房间的处理：
 *  · 带正确 token → 恢复原座位（重连，含刷新）
 *  · 同 guestId 无 token → 恢复原座位（同浏览器）
 *  · 座位未满且是空位 → 入座（waiting→playing）
 *  · 否则 → 观战者（超上限则拒绝）
 */
function join(roomId, { guestId, name, token: tk }) {
  const room = rooms.get(String(roomId || ""));
  if (!room) return { error: "房间不存在或已失效", code: "ROOM_NOT_FOUND" };
  if (room.status === "finished" && isExpired(room)) return { error: "房间已失效", code: "ROOM_EXPIRED" };
  const gid = String(guestId || "");
  room.lastActivity = now();

  // ① token / guestId 命中已有座位 → 恢复
  for (const s of ["w", "b"]) {
    const seat = room.seats[s];
    if (!seat) continue;
    if ((tk && seat.token === tk) || (gid && seat.guestId === gid)) {
      if (name) seat.name = safeName(name, seat.name);
      seat.lastSeen = now();
      return { room, seat: s, token: seat.token, role: seatRole(room, s, gid) };
    }
  }
  // ② 有空位 → 入座
  const empty = !room.seats.w ? "w" : (!room.seats.b ? "b" : null);
  if (empty && !tk) {                    // 带 token 却不对应任何座位：视为观战，避免占座攻击
    room.seats[empty] = { guestId: gid || uuid(), token: token(), name: safeName(name, empty === "w" ? "白方" : "黑方"), connected: false, lastSeen: now(), ms: L.baseMs, joinedAt: now() };
    if (room.seats.w && room.seats.b && room.status === "waiting") {
      room.status = "playing"; room.startedAt = now(); room.lastMoveAt = now();
      room.expiresAt = 0;                // 对局中不按 waiting TTL 回收
    }
    if (room.status === "waiting") room.expiresAt = now() + L.waitingTtlMs;
    save();
    return { room, seat: empty, token: room.seats[empty].token, role: seatRole(room, empty, gid) };
  }
  // ③ 观战
  const exist = room.spectators.find(s => s.guestId && gid && s.guestId === gid);
  if (exist) { exist.lastSeen = now(); if (name) exist.name = safeName(name, exist.name); return { room, seat: null, role: "spectator" }; }
  if (room.spectators.length >= L.maxSpectators) return { error: "房间观战人数已满", code: "ROOM_FULL" };
  room.spectators.push({ guestId: gid || uuid(), name: safeName(name, "观战者"), lastSeen: now() });
  save();
  return { room, seat: null, role: "spectator" };
}

function seatRole(room, seat, gid) {
  if (!seat) return "spectator";
  return (room.hostGuestId && room.seats[seat] && room.seats[seat].guestId === room.hostGuestId) ? "host" : "player";
}

/* ---------------- 走子 ---------------- */
function move(roomId, { token: tk, from, to, promotion }) {
  const room = rooms.get(String(roomId || ""));
  if (!room) return { error: "房间不存在或已失效", code: "ROOM_NOT_FOUND" };
  if (room.status !== "playing") return { error: "对局尚未开始或已结束", code: "NOT_PLAYING" };
  const seat = seatOfToken(room, tk);
  if (!seat) return { error: "你不在对局座位上（观战者只能查看）", code: "FORBIDDEN" };
  if (room.turn && room.turn !== seat) return { error: "还没轮到你走棋", code: "NOT_YOUR_TURN" };
  if (room.moves.length >= L.maxMoves) return { error: "对局步数已达上限", code: "TOO_MANY_MOVES" };
  const last = room.moves[room.moves.length - 1];
  if (last && now() - last.ts < L.moveGapMs) return { error: "操作过快", code: "TOO_FAST" };

  // 时钟：扣减本方用时（用 lastMoveAt 计算）
  const elapsed = room.lastMoveAt ? Math.max(0, now() - room.lastMoveAt) : 0;
  const seatRec = room.seats[seat];
  seatRec.ms = Math.max(0, (seatRec.ms == null ? L.baseMs : seatRec.ms) - elapsed);
  if (seatRec.ms <= 0) { finish(room, seat === "w" ? "b" : "w", "timeout"); save(); return { room, timeout: true }; }

  const c = newChess(room.fen);
  let mv;
  try { mv = c.move({ from: String(from || ""), to: String(to || ""), promotion: ["q", "r", "b", "n"].includes(promotion) ? promotion : "q" }); }
  catch { mv = null; }
  if (!mv) return { error: "非法走子", code: "ILLEGAL_MOVE" };
  seatRec.lastSeen = now();
  room.fen = c.fen();
  room.turn = c.turn();
  room.lastMoveAt = now();
  room.moves.push({ n: room.moves.length + 1, from: mv.from, to: mv.to, san: mv.san, by: seat, ts: now(), ms: seatRec.ms });
  room.lastActivity = now();
  room.rev++;

  // 终局判定
  if (c.game_over()) {
    if (c.in_checkmate()) finish(room, seat, "checkmate");
    else if (c.in_stalemate()) finish(room, null, "stalemate");
    else if (typeof c.insufficient_material === "function" && c.insufficient_material()) finish(room, null, "insufficient");
    else finish(room, null, c.in_threefold_repetition && c.in_threefold_repetition() ? "repetition" : "draw");
  }
  save();
  return { room, move: room.moves[room.moves.length - 1] };
}

function seatOfToken(room, tk) {
  if (!tk) return null;
  for (const s of ["w", "b"]) if (room.seats[s] && room.seats[s].token === tk) return s;
  return null;
}
function seatOfGuest(room, gid) {
  if (!gid) return null;
  for (const s of ["w", "b"]) if (room.seats[s] && room.seats[s].guestId === gid) return s;
  return null;
}

function finish(room, winner, reason) {
  if (room.status === "finished") return;
  room.status = "finished";
  room.endedAt = now();
  room.result = { winner: winner || null, reason, at: room.endedAt };
  room.expiresAt = now() + L.finishedTtlMs;
  room.rev++;
}

function resign(roomId, { token: tk }) {
  const room = rooms.get(String(roomId || ""));
  if (!room) return { error: "房间不存在或已失效", code: "ROOM_NOT_FOUND" };
  if (room.status !== "playing") return { error: "对局尚未开始或已结束", code: "NOT_PLAYING" };
  const seat = seatOfToken(room, tk);
  if (!seat) return { error: "只有对局双方可以认输", code: "FORBIDDEN" };
  finish(room, seat === "w" ? "b" : "w", "resign");
  save();
  return { room };
}

/* ---------------- 重赛（清盘重开，双方确认由前端保证） ---------------- */
function rematch(roomId, { token: tk }) {
  const room = rooms.get(String(roomId || ""));
  if (!room) return { error: "房间不存在或已失效", code: "ROOM_NOT_FOUND" };
  if (room.status !== "finished") return { error: "对局尚未结束", code: "NOT_FINISHED" };
  const seat = seatOfToken(room, tk);
  if (!seat) return { error: "只有对局双方可以发起重赛", code: "FORBIDDEN" };
  room.readyVotes = room.readyVotes || {};
  room.readyVotes[seat] = true;
  const both = room.seats.w && room.seats.b && room.readyVotes.w && room.readyVotes.b;
  if (!both) { save(); return { room, waitingOther: true }; }
  // 交换黑白，重新开局
  const w = room.seats.w; room.seats.w = room.seats.b; room.seats.b = w;
  for (const s of ["w", "b"]) if (room.seats[s]) room.seats[s].ms = L.baseMs;
  room.status = "playing";
  room.fen = new Chess().fen();
  room.moves = []; room.turn = undefined; room.result = null; room.readyVotes = {};
  room.endedAt = 0; room.startedAt = now(); room.lastMoveAt = now(); room.expiresAt = 0;
  room.rev++;
  save();
  return { room, restarted: true };
}

/* ---------------- 聊天（房间内轻量文字，房内所有人可用） ---------------- */
function chat(roomId, { token: tk, guestId, text, att }) {
  const room = rooms.get(String(roomId || ""));
  if (!room) return { error: "房间不存在或已失效", code: "ROOM_NOT_FOUND" };
  let name = null, role = "spectator";
  const seat = seatOfToken(room, tk) || seatOfGuest(room, guestId);
  if (seat) { name = room.seats[seat].name; role = seatRole(room, seat, room.seats[seat].guestId); }
  else { const sp = room.spectators.find(s => s.guestId === String(guestId || "")); if (!sp) return { error: "你不在该房间", code: "FORBIDDEN" }; name = sp.name; }
  const t = String(text == null ? "" : text).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  // 附件：校验存在 + 归属本人（访客用 guestId 归属）
  const at = uploads.normalizeAtts(att, "g:" + String(guestId || ""));
  if (at.error) return { error: at.error, code: "BAD_ATT" };
  const atts = at.atts || [];
  if (!t && !atts.length) return { error: "内容为空", code: "EMPTY" };
  const item = { name, role, text: t.slice(0, 200), ts: now() };
  if (atts.length) item.att = atts;
  room.chat.push(item);
  if (room.chat.length > L.maxChat) room.chat.splice(0, room.chat.length - L.maxChat);
  room.lastActivity = now();
  save();
  return { room, item };
}

/* ---------------- 在线状态 ---------------- */
function presence(roomId, { token: tk, guestId, on }) {
  const room = rooms.get(String(roomId || ""));
  if (!room) return null;
  const seat = seatOfToken(room, tk) || seatOfGuest(room, guestId);
  if (seat) { room.seats[seat].connected = !!on; room.seats[seat].lastSeen = now(); }
  else { const sp = room.spectators.find(s => s.guestId === String(guestId || "")); if (sp) sp.lastSeen = now(); }
  room.lastActivity = now();
  save();
  return room;
}

function leave(roomId, { token: tk, guestId }) {
  const room = rooms.get(String(roomId || ""));
  if (!room) return null;
  const seat = seatOfToken(room, tk) || seatOfGuest(room, guestId);
  if (seat) {
    room.seats[seat].connected = false;
    room.seats[seat].lastSeen = now();
    room.seats[seat].leftAt = now();
  } else {
    const i = room.spectators.findIndex(s => s.guestId === String(guestId || ""));
    if (i >= 0) room.spectators.splice(i, 1);
  }
  save();
  return room;
}

/* ---------------- 状态输出（按角色裁剪，观战者看不到私有字段） ---------------- */
function publicState(room, opts = {}) {
  const viewerSeat = opts.seat || null;
  const c = newChess(room.fen);
  const seats = {};
  for (const s of ["w", "b"]) {
    const st = room.seats[s];
    seats[s] = st ? {
      name: st.name, connected: !!st.connected, ms: st.ms == null ? L.baseMs : st.ms,
      online: !!st.connected || (now() - (st.lastSeen || 0) < 30000),
      isHost: st.guestId === room.hostGuestId,
      isYou: viewerSeat === s,
    } : null;
  }
  return {
    id: room.id, status: room.status, rev: room.rev,
    fen: room.fen,
    turn: c.turn(),
    moves: room.moves.map(m => ({ n: m.n, from: m.from, to: m.to, san: m.san, by: m.by, ms: m.ms })),
    seats,
    spectatorCount: room.spectators.length,
    result: room.result,
    chat: room.chat.slice(-L.maxChat),
    createdAt: room.createdAt, startedAt: room.startedAt, endedAt: room.endedAt,
    baseMs: L.baseMs,
    yourSeat: viewerSeat,
    inCheck: c.in_check ? c.in_check() : false,
    checkmate: c.in_checkmate ? c.in_checkmate() : false,
  };
}

/* ---------------- 回收 ---------------- */
function isExpired(room) {
  const t = now();
  if (room.status === "waiting") return room.expiresAt && t > room.expiresAt;
  if (room.status === "finished") return room.expiresAt && t > room.expiresAt;
  return false;
}
function bothOffline(room) {
  if (room.status !== "playing") return false;
  const t = now();
  const a = room.seats.w, b = room.seats.b;
  const off = s => !s || (!s.connected && t - (s.lastSeen || 0) > L.seatHoldMs);
  return off(a) && off(b);
}
function sweep() {
  const t = now();
  let changed = false;
  for (const [id, room] of rooms) {
    // 对局中的超时判负 / 放弃判负
    if (room.status === "playing") {
      if (room.lastMoveAt) {
        const side = room.turn || (newChess(room.fen)).turn();
        const rec = room.seats[side];
        const elapsed = t - room.lastMoveAt;
        if (rec && (rec.ms == null ? L.baseMs : rec.ms) - elapsed <= 0) {
          finish(room, side === "w" ? "b" : "w", "timeout"); changed = true; continue;
        }
      }
      if (bothOffline(room)) { finish(room, null, "abandon"); changed = true; continue; }
    }
    if (isExpired(room)) { rooms.delete(id); changed = true; }
  }
  trimRooms();
  if (changed || dirty) saveNow();
}
function trimRooms() {
  if (rooms.size <= L.maxRooms) return;
  const arr = [...rooms.values()].sort((a, b) => (a.lastActivity || 0) - (b.lastActivity || 0));
  const drop = rooms.size - L.maxRooms;
  for (let i = 0; i < drop; i++) rooms.delete(arr[i].id);
}

function stats() {
  let waiting = 0, playing = 0, finished = 0;
  for (const r of rooms.values()) { if (r.status === "waiting") waiting++; else if (r.status === "playing") playing++; else finished++; }
  return { total: rooms.size, waiting, playing, finished };
}

/* ---------------- 启动 ---------------- */
function start() {
  load();
  sweep();
  if (!sweepTimer) sweepTimer = setInterval(sweep, 15000);
  if (sweepTimer.unref) sweepTimer.unref();
}

module.exports = { start, create, join, move, resign, rematch, chat, presence, leave, publicState, seatOfToken, seatOfGuest, get: (id) => rooms.get(String(id || "")), stats, LIMITS: L, _saveNow: saveNow };

// 进程退出前落盘（systemd restart 时不丢对局）
process.on("exit", () => { try { if (dirty) saveNow(); } catch {} });
process.on("SIGTERM", () => { try { saveNow(); } catch {} });
process.on("SIGINT", () => { try { saveNow(); } catch {} });
