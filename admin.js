// =============================================================================
// admin.js — 后台管理系统（鉴权 + 账号体系 + RBAC + API + 系统指标 + 对局日志）
//   零新增依赖：全部使用 Node 内置模块（crypto / os / fs / child_process）
//   注册简化：仅用户名 + 密码（验证码/邮箱/手机/自助找回密码已整体移除，
//   忘记密码由管理员在「账号管理」里重置）
//   数据存 admin/ 下 JSON 文件：
//     accounts.json      用户（密码 scrypt 哈希；含角色/状态）
//     sessions.json      会话（默认 7 天过期，含 userId/ip/ua 用于多设备）
//     games.log.jsonl    对局/分析日志（追加写）
//     config.json        公告等配置
//     .secret            会话签名密钥（运行时生成，gitignore）
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

// ---------- 工具 ----------
function clientIp(req) {
  const ip = (req.socket && req.socket.remoteAddress) || "";
  return ip.replace(/^::ffff:/, "");
}
function uuid() { return (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString("hex"); }

// 用户名策略：2-32 位字母数字/._-（注册 / 管理员创建 / 用户改名 三处共用）
const RE_USERNAME = /^[\w.-]{2,32}$/;
// 密码策略：8-128 位，含小写 + 大写 + 数字
function validPassword(pw) {
  return typeof pw === "string" && pw.length >= 8 && pw.length <= 128 &&
    /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw);
}
// 敏感数据落盘：0600 权限（accounts.json 曾是 0644，本机其他用户可读密码哈希/会话 token）
function writePrivate(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

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
// 对不存在用户也做一次 scrypt 比对，弱化用户枚举的时序差异
const DUMMY_HASH = hashPassword("dummy-for-timing-only");

// ---------- RBAC ----------
// 角色 → 权限集合。admin 拥有全部（"*"）。
const ROLE_PERMISSIONS = {
  admin:  ["*"],
  editor: ["account:read", "account:write", "announcement:write", "engine:control",
           "metrics:read", "games:read", "engines:read"],
  viewer: ["metrics:read", "games:read", "engines:read"],
  member: ["profile:read", "profile:write", "session:read", "session:write"],
};
function rolePerms(role) { return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.member; }
function hasPerm(role, perm) {
  const p = rolePerms(role);
  return p.includes("*") || p.includes(perm);
}
const ALL_ROLES = Object.keys(ROLE_PERMISSIONS);

// ---------- 用户（数据建模 + 向后兼容迁移）----------
function normalizeUser(u) {
  return {
    id: u.id || uuid(),
    username: u.username,
    role: ALL_ROLES.includes(u.role) ? u.role : "member",
    pw: u.pw || DUMMY_HASH,
    status: ["active", "suspended"].includes(u.status) ? u.status : "active",
    mustChange: !!u.mustChange,
    createdAt: u.createdAt || Date.now(),
    updatedAt: u.updatedAt || Date.now(),
    lastLoginAt: u.lastLoginAt || 0,
  };
}
function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8")); }
  catch { return null; }
}
function saveAccounts(a) { writePrivate(ACCOUNTS_FILE, JSON.stringify(a, null, 2)); }
// 启动期一次性迁移旧 schema（补齐缺失字段并落盘；同时剥离已废弃的 email/phone/isVerified 字段）
(function migrateAccounts() {
  const cur = loadAccounts();
  if (!cur) return;
  let changed = false;
  const norm = cur.map(u => {
    const n = normalizeUser(u);
    if (n.id !== u.id || !ALL_ROLES.includes(u.role) || n.status !== u.status ||
        "email" in u || "phone" in u || "isVerified" in u) changed = true;
    return n;
  });
  if (changed) saveAccounts(norm);
})();
function getAccounts() { const a = loadAccounts(); return ((a && a.length) ? a : seedAdmin()).map(normalizeUser); }
function findUser(login) {
  const l = String(login || "").trim().toLowerCase();
  return getAccounts().find(a => a.username.toLowerCase() === l);
}
function seedAdmin() {
  const user = process.env.ADMIN_USER || "admin";
  const pass = process.env.ADMIN_PASS || "admin12345";
  const acc = [normalizeUser({
    username: user, role: "admin",
    pw: hashPassword(pass), createdAt: Date.now(), mustChange: true, status: "active",
  })];
  saveAccounts(acc);
  return acc;
}
function publicAccount(a) {
  return {
    id: a.id, username: a.username, role: a.role,
    status: a.status, mustChange: !!a.mustChange,
    createdAt: a.createdAt, updatedAt: a.updatedAt, lastLoginAt: a.lastLoginAt,
  };
}

// ---------- 会话（签名 cookie + 服务端存储，支持多设备）----------
function loadSessions() {
  try { const v = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")); return (v && typeof v === "object" && !Array.isArray(v)) ? v : {}; }
  catch { return {}; }
}
function saveSessions(s) { writePrivate(SESSIONS_FILE, JSON.stringify(s)); }
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
function createSession(user, req) {
  const token = makeToken();
  const sessions = loadSessions();
  sessions[token] = {
    userId: user.id, username: user.username, role: user.role,
    exp: Date.now() + 7 * 864e5,
    ip: clientIp(req),
    ua: (req.headers["user-agent"] || "").slice(0, 200),
    createdAt: Date.now(),
  };
  saveSessions(sessions);
  return sign(token);
}
function cookieFlags(req) {
  // 仅在经 HTTPS（cloudflared 反代）访问时加 Secure；LAN http 不加以免登录失效
  const secure = (req.headers["x-forwarded-proto"] === "https" || (req.socket && req.socket.encrypted)) ? "; Secure" : "";
  return `; HttpOnly; SameSite=Lax${secure}; Path=/`;
}
function getCurrentToken(req) {
  const c = parseCookies(req).star_admin;
  return c ? unsign(c) : null;
}
function getSession(req) {
  const token = getCurrentToken(req);
  if (!token) return null;
  const sessions = loadSessions();
  const s = sessions[token];
  if (!s || s.exp < Date.now()) {
    if (s) { delete sessions[token]; saveSessions(sessions); }
    return null;
  }
  return s;
}
function listSessionsFor(userId) {
  const sessions = loadSessions();
  const out = [];
  for (const [tok, s] of Object.entries(sessions)) {
    if (s.userId === userId) out.push({ token: tok, ...s });
  }
  return out;
}
function logoutOthers(userId, currentToken) {
  const sessions = loadSessions();
  let n = 0;
  for (const tok of Object.keys(sessions)) {
    if (sessions[tok].userId === userId && tok !== currentToken) { delete sessions[tok]; n++; }
  }
  saveSessions(sessions);
  return n;
}
function logoutAllFor(userId) {
  const sessions = loadSessions();
  let n = 0;
  for (const tok of Object.keys(sessions)) {
    if (sessions[tok].userId === userId) { delete sessions[tok]; n++; }
  }
  saveSessions(sessions);
  return n;
}

// ---------- 限流 ----------
// 通用滑动窗口：返回 true 表示未超限（调用即记一次）
const rateBuckets = new Map();
function rateCheck(key, max, windowMs) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  rateBuckets.set(key, arr);
  return arr.length <= max;
}
// 登录失败计数（IP + 账号 双维度，5 次/分钟）
const loginFails = new Map();
function loginAllowed(ip, username) {
  const now = Date.now();
  const ipR = loginFails.get("ip:" + ip);
  if (ipR && now - ipR.first < 60000 && ipR.count >= 5) return false;
  const uR = loginFails.get("u:" + username.toLowerCase());
  if (uR && now - uR.first < 60000 && uR.count >= 5) return false;
  return true;
}
function noteLoginFail(ip, username) {
  const now = Date.now();
  const ipR = loginFails.get("ip:" + ip) || { count: 0, first: now };
  ipR.count++; ipR.first = ipR.first || now; loginFails.set("ip:" + ip, ipR);
  const uR = loginFails.get("u:" + username.toLowerCase()) || { count: 0, first: now };
  uR.count++; uR.first = uR.first || now; loginFails.set("u:" + username.toLowerCase(), uR);
}
function clearLoginFail(ip, username) {
  loginFails.delete("ip:" + ip);
  loginFails.delete("u:" + username.toLowerCase());
}

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
  // 必须仍在 admin 目录内（加 path.sep 防止同名前缀目录如 adminX 绕过 startsWith）
  if (!filePath.startsWith(base + path.sep)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not Found"); }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": ADMIN_MIME[ext] || "application/octet-stream",
      // 后台前端每次验证（no-cache）：JS 曾因 7 天强缓存导致修复后浏览器仍跑旧代码（定时器爆炸 bug 无法热修复）
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN",
    });
    res.end(data);
  });
}
function isAdmin(s) { return s && s.role === "admin"; }

// ---------- API 路由 ----------
async function handleApi(req, res, u) {
  const p = u.pathname;
  const m = req.method;

  // ===================== 公开接口（无需登录）=====================
  // 登录（支持 username / email / phone）
  if (p === "/api/login" && m === "POST") {
    const ip = clientIp(req);
    const body = await readBody(req);
    const { username, password } = body;
    if (typeof username !== "string" || typeof password !== "string")
      return json(res, 400, { error: "缺少参数" });
    if (!loginAllowed(ip, username))
      return json(res, 429, { error: "尝试过于频繁，请稍后再试（IP 或账号已被限流）" });
    const acc = findUser(username);
    // 不存在用户也做一次 scrypt 比对，弱化枚举时序
    if (!acc || !verifyPassword(password, acc.pw)) {
      noteLoginFail(ip, username);
      return json(res, 401, { error: "用户名或密码错误" });
    }
    if (acc.status === "suspended") {
      noteLoginFail(ip, username);
      return json(res, 403, { error: "账号已被停用，请联系管理员" });
    }
    clearLoginFail(ip, username);
    acc.lastLoginAt = Date.now(); acc.updatedAt = Date.now();
    const accounts = getAccounts().map(a => a.username === acc.username ? acc : a);
    saveAccounts(accounts);
    const cookie = createSession(acc, req);
    return json(res, 200,
      { username: acc.username, role: acc.role, mustChange: !!acc.mustChange },
      { "Set-Cookie": `star_admin=${cookie}${cookieFlags(req)}; Max-Age=604800` });
  }

  // 登出
  if (p === "/api/logout" && m === "POST") {
    const token = getCurrentToken(req);
    if (token) { const s = loadSessions(); delete s[token]; saveSessions(s); }
    return json(res, 200, { ok: true },
      { "Set-Cookie": "star_admin=; HttpOnly; Path=/; Max-Age=0" });
  }

  // 公开公告
  if (p === "/api/announcement" && m === "GET")
    return json(res, 200, getConfig().announcement || { text: "", enabled: false });

  // 注册（开放自助注册：仅用户名 + 密码，验证码/联系方式已移除）
  if (p === "/api/register" && m === "POST") {
    const ip = clientIp(req);
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const { password } = body;
    if (!RE_USERNAME.test(username))
      return json(res, 400, { error: "用户名 2-32 位字母数字/._-" });
    if (!validPassword(password))
      return json(res, 400, { error: "密码需 8-128 位，且含大写、小写、数字" });
    // 限流（注册尝试：10 次/10 分钟/IP）
    if (!rateCheck("reg:" + ip, 10, 600000))
      return json(res, 429, { error: "注册请求过于频繁，请稍后再试" });
    const accounts = getAccounts();
    if (accounts.find(a => a.username.toLowerCase() === username.toLowerCase()))
      return json(res, 409, { error: "用户名已存在" });
    const user = normalizeUser({
      username, role: "member", pw: hashPassword(password),
      status: "active", createdAt: Date.now(), updatedAt: Date.now(), lastLoginAt: Date.now(),
    });
    accounts.push(user); saveAccounts(accounts);
    const cookie = createSession(user, req);
    return json(res, 200,
      { username: user.username, role: user.role },
      { "Set-Cookie": `star_admin=${cookie}${cookieFlags(req)}; Max-Age=604800` });
  }

  // ===================== 以下均需要登录 =====================
  const s = getSession(req);
  if (!s) return json(res, 401, { error: "未登录" });

  // 强制改密：账号仍需改密时，仅放行 /api/me（读资料 / 改密），其余受保护接口一律拦截
  {
    const _acc = getAccounts().find(a => a.id === s.userId);
    if (_acc && _acc.mustChange && p !== "/api/me")
      return json(res, 403, { error: "请先修改密码后再继续操作", mustChange: true });
  }

  // 当前用户资料 / 改名 / 改密
  if (p === "/api/me") {
    const accounts = getAccounts();
    const me = accounts.find(a => a.id === s.userId) || accounts.find(a => a.username === s.username);
    if (!me) return json(res, 401, { error: "账号不存在" });
    if (m === "GET") {
      return json(res, 200, {
        username: me.username, role: me.role, status: me.status,
        createdAt: me.createdAt, lastLoginAt: me.lastLoginAt, mustChange: !!me.mustChange,
      });
    }
    if (m === "PUT") {
      const body = await readBody(req);
      let changed = false;

      // 改用户名（本人自助；唯一性 + 与账号创建一致的格式校验）
      const newUname = typeof body.username === "string" ? body.username.trim() : "";
      if (newUname && newUname !== me.username) {
        if (!RE_USERNAME.test(newUname))
          return json(res, 400, { error: "用户名 2-32 位字母数字/._-" });
        if (accounts.find(a => a.id !== me.id && a.username.toLowerCase() === newUname.toLowerCase()))
          return json(res, 409, { error: "用户名已存在" });
        me.username = newUname; me.updatedAt = Date.now(); changed = true;
        // 同步所有设备会话里的显示名
        const sessions = loadSessions();
        for (const tok of Object.keys(sessions))
          if (sessions[tok].userId === me.id) sessions[tok].username = newUname;
        saveSessions(sessions);
      }

      // 改密码：必须先验证当前密码（否则会话被劫持/XSS 时攻击者可直接改密锁死本人）
      if (body.password) {
        if (!body.currentPassword || !verifyPassword(String(body.currentPassword), me.pw))
          return json(res, 403, { error: "当前密码不正确" });
        if (!validPassword(body.password))
          return json(res, 400, { error: "新密码需 8-128 位，且含大写、小写、数字" });
        me.pw = hashPassword(body.password); me.mustChange = false; me.updatedAt = Date.now(); changed = true;
      }

      if (!changed) return json(res, 400, { error: "没有需要修改的内容" });
      saveAccounts(accounts);
      return json(res, 200, { ok: true, username: me.username });
    }
  }

  // 多设备会话管理
  if (p === "/api/me/sessions") {
    const cur = getCurrentToken(req);
    if (m === "GET") {
      const list = listSessionsFor(s.userId).map(x => ({
        id: x.token.slice(0, 8), ip: x.ip, ua: x.ua,
        createdAt: x.createdAt, exp: x.exp, current: x.token === cur,
      })).sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
      return json(res, 200, { sessions: list });
    }
    if (m === "DELETE") {
      const n = logoutOthers(s.userId, cur);
      return json(res, 200, { ok: true, removed: n });
    }
  }

  // ===================== RBAC 受保护资源 =====================
  function need(perm) {
    if (!hasPerm(s.role, perm)) { json(res, 403, { error: "权限不足（需要 " + perm + "）" }); return false; }
    return true;
  }

  // 看板数据
  if (p === "/api/admin/metrics" && m === "GET") { if (!need("metrics:read")) return; return json(res, 200, await getMetrics()); }
  if (p === "/api/admin/games" && m === "GET") { if (!need("games:read")) return; return json(res, 200, getGamesStats()); }
  if (p === "/api/admin/engines" && m === "GET") { if (!need("engines:read")) return; return json(res, 200, { engines: engineStatus() }); }

  // 账号管理（读）
  if (p === "/api/admin/accounts" && m === "GET") {
    if (!need("account:read")) return;
    return json(res, 200, { accounts: getAccounts().map(publicAccount) });
  }
  // 账号管理（建）
  if (p === "/api/admin/accounts" && m === "POST") {
    if (!need("account:write")) return;
    const body = await readBody(req);
    const uname = String(body.username || "").trim();
    const pw = body.password, role = body.role;
    if (!RE_USERNAME.test(uname)) return json(res, 400, { error: "用户名 2-32 位字母数字/._-" });
    if (!validPassword(pw)) return json(res, 400, { error: "密码需 8-128 位，且含大写、小写、数字" });
    if (!ALL_ROLES.includes(role)) return json(res, 400, { error: "角色无效" });
    const accounts = getAccounts();
    if (accounts.find(a => a.username.toLowerCase() === uname.toLowerCase())) return json(res, 409, { error: "用户名已存在" });
    accounts.push(normalizeUser({ username: uname, role, pw: hashPassword(pw), createdAt: Date.now(), updatedAt: Date.now() }));
    saveAccounts(accounts);
    return json(res, 200, { ok: true });
  }
  // 账号管理（改 / 删）
  const acctMatch = p.match(/^\/api\/admin\/accounts\/(.+)$/);
  if (acctMatch && (m === "PUT" || m === "DELETE")) {
    if (!need("account:write")) return;
    const uname = decodeURIComponent(acctMatch[1]);
    const accounts = getAccounts();
    const idx = accounts.findIndex(a => a.username === uname);
    if (idx < 0) return json(res, 404, { error: "账号不存在" });
    if (m === "DELETE") {
      if (uname === s.username) return json(res, 400, { error: "不能删除自己" });
      if (accounts[idx].role === "admin") return json(res, 400, { error: "不能删除管理员账号" });
      accounts.splice(idx, 1);
      saveAccounts(accounts);
      return json(res, 200, { ok: true });
    }
    const body = await readBody(req);
    const acc = accounts[idx];
    if (uname === s.username && body.role && body.role !== acc.role)
      return json(res, 403, { error: "不能修改自己的角色" });
    if (body.status && ["active", "suspended"].includes(body.status)) acc.status = body.status;
    if (body.password && validPassword(body.password)) { acc.pw = hashPassword(body.password); acc.mustChange = false; }
    if (body.role && ALL_ROLES.includes(body.role)) {
      // 防止把自己/唯一管理员降级导致锁死：editor 不能把别人改成 admin 除非自己也是 admin
      if (body.role === "admin" && s.role !== "admin")
        return json(res, 403, { error: "仅管理员可授予 admin 角色" });
      if (acc.role === "admin" && body.role !== "admin" && !accounts.some(a => a !== acc && a.role === "admin"))
        return json(res, 400, { error: "至少保留一个管理员" });
      acc.role = body.role;
    }
    acc.updatedAt = Date.now();
    saveAccounts(accounts);
    return json(res, 200, { ok: true });
  }

  // 公告
  if (p === "/api/admin/announcement" && m === "PUT") {
    if (!need("announcement:write")) return;
    const body = await readBody(req);
    const cfg = getConfig();
    cfg.announcement = { text: String(body.text || "").slice(0, 500), enabled: !!body.enabled };
    saveConfig(cfg);
    return json(res, 200, { ok: true });
  }

  // 引擎启停
  const engMatch = p.match(/^\/api\/admin\/engine\/([^/]+)\/(stop|start)$/);
  if (engMatch && m === "POST") {
    if (!need("engine:control")) return;
    const key = decodeURIComponent(engMatch[1]);
    const ok = controlEngine(key, engMatch[2]);
    return json(res, ok ? 200 : 404, { ok });
  }

  return json(res, 404, { error: "not found" });
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
    // login / register 公开（自助找回密码页已随验证码系统一并移除）
    if (rel === "login.html" || rel === "register.html") { serveAdminFile(res, rel); return true; }
    // 静态资源（css/js/图片）放行：前端脚本不含敏感数据，数据均走 /api（已有会话 + RBAC 守卫）
    if (/\.(css|js|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot)$/i.test(rel)) { serveAdminFile(res, rel); return true; }
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
