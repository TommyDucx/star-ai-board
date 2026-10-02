"use strict";
/* S.T.A.R. 对局房间 REST（全部免登录；身份靠 guestId + seat token）
 *  · POST /api/rooms              创建房间 → { id, token, seat, url }
 *  · GET  /api/rooms/:id          读取房间状态（?guestId=&token= 可选，用于判定"我是谁"）
 *  · GET  /api/rooms/:id/verify   校验 token/guestId → { ok:true, role, seat, token }
 *  · GET  /api/rooms/stats        公开统计（房间数，便于前端提示）
 * 实时走子/认输/重赛/聊天走 WebSocket（type:"room"），见 server.js。 */
const rooms = require("../rooms");

module.exports.public = async function (ctx) {
  const { req, res, p, m, u, json, readBody, clientIp, rateCheck } = ctx;

  /* ---------- 创建房间 ---------- */
  if (p === "/api/rooms" && m === "POST") {
    if (!rateCheck("room:new:" + clientIp(req), 12, 60000))
      return json(res, 429, { error: "创建过于频繁，请稍后再试" });
    const body = await readBody(req);
    const r = rooms.create({ guestId: body.guestId, name: body.name });
    const st = rooms.publicState(r.room, { seat: r.seat });
    return json(res, 200, { id: r.room.id, token: r.token, seat: r.seat, role: "host", state: st });
  }

  /* ---------- 公开统计 ---------- */
  if (p === "/api/rooms/stats" && m === "GET") return json(res, 200, rooms.stats());

  /* ---------- 读取房间 ---------- */
  let mm = /^\/api\/rooms\/([A-Za-z0-9-]{6,64})$/.exec(p);
  if (mm && m === "GET") {
    const room = rooms.get(mm[1]);
    if (!room) return json(res, 404, { error: "房间不存在或已失效", code: "ROOM_NOT_FOUND" });
    const tk = u.searchParams.get("token") || "";
    const gid = u.searchParams.get("guestId") || "";
    const seat = rooms.seatOfToken(room, tk) || rooms.seatOfGuest(room, gid);
    return json(res, 200, { state: rooms.publicState(room, { seat }) });
  }

  /* ---------- 校验身份（刷新后恢复座位前的确认） ---------- */
  mm = /^\/api\/rooms\/([A-Za-z0-9-]{6,64})\/verify$/.exec(p);
  if (mm && m === "GET") {
    const room = rooms.get(mm[1]);
    if (!room) return json(res, 404, { error: "房间不存在或已失效", code: "ROOM_NOT_FOUND" });
    const tk = u.searchParams.get("token") || "";
    const gid = u.searchParams.get("guestId") || "";
    const seat = rooms.seatOfToken(room, tk) || rooms.seatOfGuest(room, gid);
    return json(res, 200, {
      ok: !!seat, seat: seat || null,
      role: seat ? (room.seats[seat].guestId === room.hostGuestId ? "host" : "player") : "spectator",
      token: seat ? room.seats[seat].token : null,
      spectators: room.spectators.length,
      status: room.status,
    });
  }

  return false;
};
