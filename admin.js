// =============================================================================
// admin.js — 后台管理系统（鉴权 + API + 系统指标 + 对局日志）
//   零新增依赖：全部使用 Node 内置模块（crypto / os / fs / child_process）
//   数据存 admin/ 下 JSON 文件：
//     accounts.json     账号（密码 scrypt 哈希）
//     sessions.json     会话（默认 7 天过期）
//     games.log.jsonl   对局/分析日志（追加写）
//     config.json       公告等配置
//     .secret           会话签名密钥（运行时生成，gitignore）
// =============================================================================
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFile } = require("child_process");

const ADMIN_DIR = path.join(__dirname, "admin");
const ACCOUNTS_FILE = path.join(ADMIN_DIR, "accounts.json");
const SESSIONS_FILE = path.join(ADMIN_DIR, "sessions.json");
const GAMES_LOG = path.join(ADMIN_DIR, "games.log.jsonl");
const CONFIG_FILE = path.join(ADMIN_DIR, "config.json");
const SECRET_FILE = path.join(ADMIN_DIR, ".secret");

fs.mkdirSync(ADMIN_DIR, { recursive: true });

// 模块级状态（由 init 注入）
let PUBLIC_DIR = path.join(__dirname, "public");
let engineStatus = () => [];
let controlEngine = () => false;

// ---------- 密钥 ----------
function loadSecret() {
  try { return fs.readFileSync(SECRET_FILE, "utf8").trim(); }
  catch {
    const s = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    return s;
  }
}
let SECRET = loadSecret();

// ---------- 密码哈希（scrypt + 随机盐）----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return salt.toString("hex") + ":" + hash.toString("hex");
}
function verifyPassword(pw, stored) {
  if (typeof stored !== "string" || !stored.includes(":")) return false;
  const [saltHex, hashHex] = stored.split(":");
  try {
    const h = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
    const expected = Buffer.from(hashHex, "hex");
    if (h.length !== expected.length) return false;
    return crypto.timingSafeEqual(h, expected);
  } catch { return false; }
}

// ---------- 账号 ----------
function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8")); }
  catch { return null; }
}
function saveAccounts(a) { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(a, null, 2)); }
function seedAdmin() {
  const user = process.env.ADMIN_USER || "admin";
  const pass = process.env.ADMIN_PASS || "admin12345";
  const acc = [{
    username: user, role: "admin",
    pw: hashPassword(pass), createdAt: Date.now(), mustChange: true,
  }];
  saveAccounts(acc);
  return acc;
}
function publicAccount(a) {
  return { username: a.username, role: a.role, createdAt: a.createdAt, mustChange: !!a.mustChange };
}

// ---------- 会话（签名 cookie + 服务端存储）----------
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")); }
  catch { return {}; }
}
function saveSessions(s) { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s)); }
function makeToken() { return crypto.randomBytes(24).toString("hex"); }
function sign(val) { return val + "." + crypto.createHmac("sha256", SECRET).update(val).digest("hex"); }
function unsign(signed) {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const val = signed.slice(0, i), mac = signed.slice(i + 1);
  const exp = crypto.createHmac("sha256", SECRET).update(val).digest("hex");
  if (mac.length !== exp.length) return null;
  try { return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp)) ? val : null; }
  catch { return null; }
}
function createSession(username, role) {
  const token = makeToken();
  const sessions = loadSessions();
  sessions[token] = { username, role, exp: Date.now() + 7 * 864e5 };
  saveSessions(sessions);
  return sign(token);
}
function getSession(req) {
  const c = parseCookies(req).star_admin;
  if (!c) return null;
  const token = unsign(c);
  if (!token) return null;
  const sessions = loadSessions();
  const s = sessions[token];
  if (!s || s.exp < Date.now()) {
    if (s) { delete sessions[token]; saveSessions(sessions); }
    return null;
  }
  return s;
}

// ---------- 登录限流（按 IP，5 次/分钟）----------
const loginFails = new Map();
function loginAllowed(ip) {
  const r = loginFails.get(ip);
  if (!r) return true;
  if (Date.now() - r.first > 60000) { loginFails.delete(ip); return true; }
  return r.count < 5;
}
function noteLoginFail(ip) {
  const r = loginFails.get(ip) || { count: 0, first: Date.now() };
  r.count++; loginFails.set(ip, r);
}
function clearLoginFail(ip) { loginFails.delete(ip); }

// ---------- 配置（公告）----------
function getConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
  catch { return { announcement: { text: "", enabled: false } }; }
}
function saveConfig(c) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); }

// ---------- 系统指标 ----------
let cpuLast = null, cpuCurrent = 0;
function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const t in c.times) total += c.times[t];
    idle += c.times.idle;
  }
  return { idle, total };
}
function sampleCpu() {
  const cur = cpuTimes();
  if (cpuLast) {
    const idleDiff = cur.idle - cpuLast.idle;
    const totalDiff = cur.total - cpuLast.total;
    cpuCurrent = totalDiff > 0 ? Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100)) : 0;
  }
  cpuLast = cur;
}
setInterval(sampleCpu, 2000); sampleCpu();

function getDisk() {
  return new Promise((resolve) => {
    execFile("df", ["-k", "/"], (err, out) => {
      if (err) return resolve({ total: 0, used: 0, free: 0, percent: 0 });
      const lines = out.trim().split("\n");
      const last = lines[lines.length - 1].split(/\s+/);
      if (last.length < 6) return resolve({ total: 0, used: 0, free: 0, percent: 0 });
      const total = +last[2] * 1024, used = +last[3] * 1024, free = +last[4] * 1024;
      resolve({ total, used, free, percent: +(last[5].replace("%", "")) || 0 });
    });
  });
}
async function getMetrics() {
  const disk = await getDisk();
  const mem = os.totalmem(), free = os.freemem();
  return {
    cpu: +cpuCurrent.toFixed(1),
    mem: { total: mem, free, used: mem - free, percent: +(((mem - free) / mem) * 100).toFixed(1) },
    disk,
    uptime: os.uptime(),
    loadavg: os.loadavg(),
    hostname: os.hostname(),
    engines: engineStatus(),
    ts: Date.now(),
  };
}

// ---------- 对局日志 ----------
function logGame({ type, engine, movetime, ip }) {
  const line = JSON.stringify({ ts: Date.now(), type, engine, movetime: movetime || 0, ip: ip || "" }) + "\n";
  fs.appendFile(GAMES_LOG, line, () => {});
}
function getGamesStats() {
  let raw = "";
  try { raw = fs.readFileSync(GAMES_LOG, "utf8"); } catch { raw = ""; }
  const lines = raw.split("\n").filter(Boolean).slice(-20000);
  const byEngine = {}, byType = {};
  const now = Date.now(), DAY = 864e5;
  const buckets = new Array(24).fill(0);
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    byEngine[e.engine] = (byEngine[e.engine] || 0) + 1;
    byType[e.type] = (byType[e.type] || 0) + 1;
    if (now - e.ts < DAY) {
      const h = Math.floor((now - e.ts) / 3600e3);
      if (h >= 0 && h < 24) buckets[23 - h]++;
    }
  }
  return { total: lines.length, byEngine, byType, last24h: buckets };
}

// ---------- 工具 ----------
function parseCookies(req) {
  const h = req.headers.cookie;
  const out = {};
  if (!h) return out;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function json(res, code, obj, extraHeaders) {
  res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, extraHeaders || {}));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
  });
}
const ADMIN_MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};
function serveAdminFile(res, rel) {
  const base = path.join(PUBLIC_DIR, "admin");
  const filePath = path.normalize(path.join(base, rel));
  if (!filePath.startsWith(base)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not Found"); }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": ADMIN_MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=604800",
      "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN",
    });
    res.end(data);
  });
}
function isAdmin(s) { return s && s.role === "admin"; }
function isViewer(s) { return s && (s.role === "admin" || s.role === "viewer"); }

// ---------- API 路由 ----------
async function handleApi(req, res, u) {
  const p = u.pathname;
  const m = req.method;

  // 登录（公开）
  if (p === "/api/login" && m === "POST") {
    const ip = req.socket.remoteAddress || "";
    if (!loginAllowed(ip)) return json(res, 429, { error: "尝试过于频繁，请稍后再试" });
    const body = await readBody(req);
    const { username, password } = body;
    if (typeof username !== "string" || typeof password !== "string")
      return json(res, 400, { error: "缺少参数" });
    const accounts = loadAccounts() || seedAdmin();
    const acc = accounts.find(a => a.username === username);
    if (!acc || !verifyPassword(password, acc.pw)) {
      noteLoginFail(ip);
      return json(res, 401, { error: "用户名或密码错误" });
    }
    clearLoginFail(ip);
    const cookie = createSession(username, acc.role);
    return json(res, 200,
      { username: acc.username, role: acc.role, mustChange: !!acc.mustChange },
      { "Set-Cookie": `star_admin=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800` });
  }

  // 登出（公开调用，无会话也返回成功）
  if (p === "/api/logout" && m === "POST") {
    const c = parseCookies(req).star_admin;
    const token = c && unsign(c);
    if (token) { const s = loadSessions(); delete s[token]; saveSessions(s); }
    return json(res, 200, { ok: true },
      { "Set-Cookie": "star_admin=; HttpOnly; Path=/; Max-Age=0" });
  }

  // 公开公告
  if (p === "/api/announcement" && m === "GET")
    return json(res, 200, getConfig().announcement || { text: "", enabled: false });

  // 以下均需要登录
  const s = getSession(req);
  if (!s) return json(res, 401, { error: "未登录" });

  // 当前用户
  if (p === "/api/me") {
    if (m === "PUT") {
      const body = await readBody(req);
      const accounts = loadAccounts() || seedAdmin();
      const acc = accounts.find(a => a.username === s.username);
      if (body.password && typeof body.password === "string" && body.password.length >= 6) {
        acc.pw = hashPassword(body.password);
        acc.mustChange = false;
        saveAccounts(accounts);
      }
      return json(res, 200, { ok: true });
    }
    return json(res, 200, { username: s.username, role: s.role, mustChange: !!accMustChange(s.username) });
  }

  // 看板数据（viewer + admin）
  if (!isViewer(s)) return json(res, 403, { error: "forbidden" });
  if (p === "/api/admin/metrics" && m === "GET") return json(res, 200, await getMetrics());
  if (p === "/api/admin/games" && m === "GET") return json(res, 200, getGamesStats());
  if (p === "/api/admin/engines" && m === "GET") return json(res, 200, { engines: engineStatus() });

  // 以下仅 admin
  if (!isAdmin(s)) return json(res, 403, { error: "需要管理员权限" });

  // 账号管理
  if (p === "/api/admin/accounts" && m === "GET")
    return json(res, 200, { accounts: (loadAccounts() || seedAdmin()).map(publicAccount) });

  if (p === "/api/admin/accounts" && m === "POST") {
    const body = await readBody(req);
    const uname = String(body.username || "").trim();
    const pw = body.password, role = body.role;
    if (!/^[\w.-]{2,32}$/.test(uname)) return json(res, 400, { error: "用户名 2-32 位字母数字/._-" });
    if (typeof pw !== "string" || pw.length < 6) return json(res, 400, { error: "密码至少 6 位" });
    if (role !== "admin" && role !== "viewer") return json(res, 400, { error: "角色无效" });
    const accounts = loadAccounts() || seedAdmin();
    if (accounts.find(a => a.username === uname)) return json(res, 409, { error: "用户名已存在" });
    accounts.push({ username: uname, role, pw: hashPassword(pw), createdAt: Date.now(), mustChange: false });
    saveAccounts(accounts);
    return json(res, 200, { ok: true });
  }

  const acctMatch = p.match(/^\/api\/admin\/accounts\/(.+)$/);
  if (acctMatch && (m === "PUT" || m === "DELETE")) {
    const uname = decodeURIComponent(acctMatch[1]);
    const accounts = loadAccounts() || seedAdmin();
    const idx = accounts.findIndex(a => a.username === uname);
    if (idx < 0) return json(res, 404, { error: "账号不存在" });
    if (m === "DELETE") {
      if (uname === s.username) return json(res, 400, { error: "不能删除自己" });
      accounts.splice(idx, 1);
      saveAccounts(accounts);
      return json(res, 200, { ok: true });
    }
    // PUT：改密码 / 改角色
    const body = await readBody(req);
    const acc = accounts[idx];
    if (uname === s.username && body.role && body.role !== acc.role)
      return json(res, 403, { error: "不能修改自己的角色" });
    if (body.password && typeof body.password === "string" && body.password.length >= 6) {
      acc.pw = hashPassword(body.password); acc.mustChange = false;
    }
    if (body.role === "admin" || body.role === "viewer") acc.role = body.role;
    saveAccounts(accounts);
    return json(res, 200, { ok: true });
  }

  // 公告
  if (p === "/api/admin/announcement" && m === "PUT") {
    const body = await readBody(req);
    const cfg = getConfig();
    cfg.announcement = {
      text: String(body.text || "").slice(0, 500),
      enabled: !!body.enabled,
    };
    saveConfig(cfg);
    return json(res, 200, { ok: true });
  }

  // 引擎启停
  const engMatch = p.match(/^\/api\/admin\/engine\/([^/]+)\/(stop|start)$/);
  if (engMatch && m === "POST") {
    const key = decodeURIComponent(engMatch[1]);
    const ok = controlEngine(key, engMatch[2]);
    return json(res, ok ? 200 : 404, { ok });
  }

  return json(res, 404, { error: "not found" });
}

function accMustChange(username) {
  const a = (loadAccounts() || seedAdmin()).find(x => x.username === username);
  return a ? !!a.mustChange : false;
}

// ---------- 请求入口 ----------
function handleRequest(req, res) {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  if (p.startsWith("/api/")) {
    handleApi(req, res, u).catch(e => {
      if (!res.headersSent) json(res, 500, { error: "server error" });
    });
    return true;
  }
  if (p.startsWith("/admin/")) {
    const rel = p.slice("/admin/".length) || "login.html";
    // login 页公开，其余需登录
    if (rel === "login.html") { serveAdminFile(res, "login.html"); return true; }
    const s = getSession(req);
    if (!s) {
      if (rel.endsWith(".html")) { res.writeHead(302, { Location: "/admin/login.html" }); res.end(); }
      else res.writeHead(401).end("Unauthorized");
      return true;
    }
    serveAdminFile(res, rel);
    return true;
  }
  return false;
}

function init(opts) {
  if (opts.publicDir) PUBLIC_DIR = opts.publicDir;
  if (opts.engineStatus) engineStatus = opts.engineStatus;
  if (opts.controlEngine) controlEngine = opts.controlEngine;
  return { handleRequest, logGame };
}

module.exports = { init, handleRequest, logGame };
