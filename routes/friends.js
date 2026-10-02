"use strict";
/* S.T.A.R. 路由模块：好友系统（搜索 / 申请 / 接受拒绝 / 留言）
 * 数据结构见 admin/friends.json：
 *   { schemaVersion:1,
 *     requests: [{ id, from, to, ts, status:"pending|accepted|rejected", decidedAt }],
 *     friends:  [{ a, b, since }],        // 双向去重，a<b 不强制，判断时两个方向都查
 *     messages: [{ id, from, to, text, ts }] }
 * 防重复申请：见 friendRequest —— 已好友/已 pending_out 直接拒绝；对方已 pending_in 则自动接受。
 * 越权防护：respond 仅 request.to 本人；留言仅好友之间；删除留言仅发送者本人。 */
module.exports.authed = async function (ctx) {
  const {
    req, res, p, m, s, u, json, readBody,
    loadFriends, saveFriends, isFriend, friendUser, friendRelation, loadAccounts, uuid,
  } = ctx;
  const me = s.userId;

  /* ---------- 搜索用户（用户名 / 用户 ID） ---------- */
  if (p === "/api/friends/search" && m === "GET") {
    const q = String(u.searchParams.get("q") || "").trim();
    if (!q) return json(res, 200, { users: [] });
    const accounts = loadAccounts();
    const lower = q.toLowerCase();
    const hits = (Array.isArray(accounts) ? accounts : [])
      .filter(a => a && a.id && a.id !== me)
      .filter(a => (a.username || "").toLowerCase().includes(lower) || a.id.includes(lower))
      .slice(0, 20)
      .map(a => ({ id: a.id, username: a.username, relation: friendRelation(me, a.id) }));
    return json(res, 200, { users: hits });
  }

  /* ---------- 我的好友 + 待处理申请 ---------- */
  if (p === "/api/friends" && m === "GET") {
    const f = loadFriends();
    const friends = f.friends
      .filter(x => x.a === me || x.b === me)
      .map(x => { const other = x.a === me ? x.b : x.a; return Object.assign({ since: x.since }, friendUser(other)); });
    const incoming = f.requests.filter(r => r.to === me && r.status === "pending")
      .map(r => ({ id: r.id, ts: r.ts, from: friendUser(r.from) }));
    const outgoing = f.requests.filter(r => r.from === me && r.status === "pending")
      .map(r => ({ id: r.id, ts: r.ts, to: friendUser(r.to) }));
    return json(res, 200, { friends, incoming, outgoing });
  }

  /* ---------- 发送好友申请（防重复 / 反向自动接受） ---------- */
  if (p === "/api/friends/request" && m === "POST") {
    const body = await readBody(req);
    const to = String(body.to || "");
    const accounts = loadAccounts();
    const target = Array.isArray(accounts) ? accounts.find(a => a && a.id === to) : null;
    if (!target) return json(res, 404, { error: "用户不存在" });
    if (to === me) return json(res, 400, { error: "不能添加自己为好友" });
    if (isFriend(me, to)) return json(res, 400, { error: "你们已经是好友" });
    const f = loadFriends();
    const out = f.requests.find(r => r.from === me && r.to === to && r.status === "pending");
    if (out) return json(res, 400, { error: "已发送申请，等待对方处理" });
    const inbound = f.requests.find(r => r.from === to && r.to === me && r.status === "pending");
    if (inbound) {                       // 对方已经向我发过申请 → 直接互加好友
      inbound.status = "accepted"; inbound.decidedAt = Date.now();
      f.friends.push({ a: me, b: to, since: Date.now() });
      saveFriends(f);
      return json(res, 200, { status: "accepted", username: target.username });
    }
    // 冷却：同一用户 3 秒内只能发一次（防刷）
    if ((f.__lastReq && f.__lastReq.me === me && Date.now() - f.__lastReq.ts < 3000)) {
      return json(res, 429, { error: "操作太频繁，请稍后再试" });
    }
    f.__lastReq = { me, ts: Date.now() };
    const pendingOut = f.requests.filter(r => r.from === me && r.status === "pending").length;
    if (pendingOut >= 30) return json(res, 400, { error: "待处理申请过多，请先等待对方处理" });
    f.requests.push({ id: uuid(), from: me, to, ts: Date.now(), status: "pending", decidedAt: 0 });
    saveFriends(f);
    return json(res, 200, { status: "pending", username: target.username });
  }

  /* ---------- 接受 / 拒绝好友申请（仅被申请者本人） ---------- */
  if (p === "/api/friends/respond" && m === "POST") {
    const body = await readBody(req);
    const f = loadFriends();
    const reqRec = f.requests.find(r => r.id === String(body.id || ""));
    if (!reqRec) return json(res, 404, { error: "申请不存在" });
    if (reqRec.to !== me) return json(res, 403, { error: "无权处理该申请" });      // 越权防护
    if (reqRec.status !== "pending") return json(res, 400, { error: "该申请已处理" });
    if (body.accept) {
      reqRec.status = "accepted";
      if (!isFriend(me, reqRec.from)) f.friends.push({ a: me, b: reqRec.from, since: Date.now() });
    } else reqRec.status = "rejected";
    reqRec.decidedAt = Date.now();
    saveFriends(f);
    return json(res, 200, { ok: true, status: reqRec.status });
  }

  /* ---------- 与某好友的留言列表（仅好友之间） ---------- */
  if (p === "/api/friends/messages" && m === "GET") {
    const withId = String(u.searchParams.get("with") || "");
    if (!isFriend(me, withId)) return json(res, 403, { error: "你们还不是好友" });
    const f = loadFriends();
    const list = f.messages
      .filter(x => (x.from === me && x.to === withId) || (x.from === withId && x.to === me))
      .slice(-100)
      .map(x => ({ id: x.id, from: x.from, to: x.to, text: x.text, ts: x.ts, mine: x.from === me }));
    return json(res, 200, { messages: list, with: friendUser(withId) });
  }

  /* ---------- 给好友留言 ---------- */
  if (p === "/api/friends/message" && m === "POST") {
    const body = await readBody(req);
    const to = String(body.to || "");
    if (!isFriend(me, to)) return json(res, 403, { error: "你们还不是好友" });
    let text = String(body.text == null ? "" : body.text)
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return json(res, 400, { error: "留言不能为空" });
    if (text.length > 500) return json(res, 400, { error: "留言过长（最多 500 字）" });
    const f = loadFriends();
    if (f.__lastMsg && f.__lastMsg.me === me && f.__lastMsg.to === to && Date.now() - f.__lastMsg.ts < 2000) {
      return json(res, 429, { error: "留言太频繁，请稍后再试" });
    }
    f.__lastMsg = { me, to, ts: Date.now() };
    const msg = { id: uuid(), from: me, to, text, ts: Date.now() };
    f.messages.push(msg);
    saveFriends(f);
    return json(res, 200, { message: { id: msg.id, from: msg.from, to: msg.to, text: msg.text, ts: msg.ts, mine: true } });
  }

  /* ---------- 删除自己的留言 ---------- */
  {
    const dm = /^\/api\/friends\/message\/([A-Za-z0-9-]+)$/.exec(p);
    if (dm && m === "DELETE") {
      const f = loadFriends();
      const i = f.messages.findIndex(x => x.id === dm[1]);
      if (i < 0) return json(res, 404, { error: "留言不存在" });
      if (f.messages[i].from !== me) return json(res, 403, { error: "只能删除自己的留言" });   // 越权防护
      f.messages.splice(i, 1);
      saveFriends(f);
      return json(res, 200, { ok: true });
    }
  }

  return false;   // 未匹配到本模块的路由
};
