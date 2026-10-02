"use strict";
/* S.T.A.R. 附件上传（文学评论区 / 对局评论区共用）
 *
 * POST /api/uploads   { scope:"lit"|"room", name, data(base64 或 dataURL), guestId? }
 *   · scope="lit"  → 必须登录（文学评论区，归属 = u:<userId>）
 *   · scope="room" → 免登录（对局评论区，归属 = g:<guestId>，配额与频率更严）
 *   返回 { file: { id, name, size, kind, mime, url, inline } }
 *
 * 文件经 uploads.js 落盘到 public/uploads/，由 server.js 的 /uploads/ 分支下发
 * （危险类型强制 attachment + octet-stream，防存储型 XSS）。
 */
const uploads = require("../uploads");

module.exports.public = async function (ctx) {
  const { req, res, p, m, json, readBodyLarge, clientIp, rateCheck, getSession } = ctx;

  if (p === "/api/uploads" && m === "POST") {
    const body = await readBodyLarge(req, 9 * 1024 * 1024);
    const scope = String(body.scope || "lit");
    const ip = clientIp(req);

    let owner = "", who = "";
    if (scope === "lit") {
      const s = getSession(req);
      if (!s) return json(res, 401, { error: "请先登录 S.T.A.R. 账号" });
      if (!rateCheck("up:lit:" + s.userId, 20, 600000))
        return json(res, 429, { error: "上传过于频繁，请稍后再试" });
      owner = "u:" + s.userId; who = s.username;
    } else if (scope === "room") {
      const gid = String(body.guestId || "").slice(0, 64);
      if (!gid) return json(res, 400, { error: "缺少访客标识" });
      if (!rateCheck("up:room:" + ip, 8, 600000))
        return json(res, 429, { error: "上传过于频繁，请稍后再试" });
      owner = "g:" + gid; who = "访客";
    } else {
      return json(res, 400, { error: "未知上传场景" });
    }

    const r = uploads.save({ name: body.name, base64: body.data, owner });
    if (r.error) return json(res, r.code || 400, { error: r.error });
    return json(res, 200, {
      file: {
        id: r.file.id, name: r.file.name, size: r.file.size, kind: r.file.kind,
        mime: r.file.mime, url: r.file.url, inline: r.file.inline,
      },
      quota: uploads.LIMITS.totalQuota,
    });
  }

  /* 上传空间概况（仅登录用户） */
  if (p === "/api/uploads/stats" && m === "GET") {
    const s = getSession(req);
    if (!s) return json(res, 401, { error: "请先登录" });
    return json(res, 200, uploads.stats());
  }

  return false;
};
