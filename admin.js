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
const TACTICS_FILE = path.join(ADMIN_DIR, "tactics_progress.json");
const CHESS_RATING_FILE = path.join(ADMIN_DIR, "chess_rating.json");
const ENGAGEMENT_FILE = path.join(ADMIN_DIR, "engagement.json");
const LIBRARY_FILE = path.join(ADMIN_DIR, "shared_library.json");

fs.mkdirSync(ADMIN_DIR, { recursive: true });

// 模块级状态（由 init 注入）
let PUBLIC_DIR = path.join(__dirname, "public");
let engineStatus = () => [];
let engineMoveFn = async () => { throw new Error("引擎未就绪"); };   // 由 server.js 注入（残局 AI 走子）
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
// 客户端真实 IP：仅当直连来自本机回环（Cloudflare 隧道/反向代理在本地）时才信任转发头，
// 否则任何客户端都能伪造 cf-connecting-ip/x-forwarded-for 绕过按 IP 的限流。
function clientIp(req) {
  let ip = (req.socket && req.socket.remoteAddress) || "";
  const loop = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (loop) {
    const h = req.headers || {};
    if (h["cf-connecting-ip"]) ip = String(h["cf-connecting-ip"]).trim();
    else if (h["x-forwarded-for"]) ip = String(h["x-forwarded-for"]).split(",")[0].trim();
  }
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
  // 仅当 socket 本身已加密（HTTPS 直连）才加 Secure；不再信任 X-Forwarded-Proto（反向代理可被伪造，
  // 在 https 下下发 Secure 后 cookie 会被浏览器拒收，导致 LAN 用户登录后立即掉登录态）
  const secure = (req.socket && req.socket.encrypted) ? "; Secure" : "";
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
// 登录失败计数（IP + 账号 双维度，5 次/分钟）—— 落盘：进程重启后仍生效，防攻击者反复重启连接绕过
const LOGIN_FAILS_FILE = path.join(ADMIN_DIR, "login_fails.json");
function loadLoginFails() {
  try {
    const v = JSON.parse(fs.readFileSync(LOGIN_FAILS_FILE, "utf8"));
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}
function persistLoginFails() {
  try {
    // atomic rename：先写 .tmp 再 rename，chmod 0600 防同机其他用户读到失败计数（弱隐私但顺手收紧）
    const tmp = LOGIN_FAILS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(loginFails, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, LOGIN_FAILS_FILE);
  } catch {}
}
const loginFails = loadLoginFails();
function loginAllowed(ip, username) {
  const now = Date.now();
  const ipR = loginFails["ip:" + ip];
  if (ipR && now - ipR.first < 60000 && ipR.count >= 5) return false;
  const uR = loginFails["u:" + username.toLowerCase()];
  if (uR && now - uR.first < 60000 && uR.count >= 5) return false;
  return true;
}
function noteLoginFail(ip, username) {
  const now = Date.now();
  const ipR = loginFails["ip:" + ip] || { count: 0, first: now };
  ipR.count++; ipR.first = ipR.first || now; loginFails["ip:" + ip] = ipR;
  const uR = loginFails["u:" + username.toLowerCase()] || { count: 0, first: now };
  uR.count++; uR.first = uR.first || now; loginFails["u:" + username.toLowerCase()] = uR;
  persistLoginFails();
}
function clearLoginFail(ip, username) {
  delete loginFails["ip:" + ip];
  delete loginFails["u:" + username.toLowerCase()];
  persistLoginFails();
}

// ---------- 配置（公告）----------
function getConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
  catch { return { announcement: { text: "", enabled: false } }; }
}
function saveConfig(c) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); }

// ---------- 题型闯关进度（按账号持久化，跨设备同步）----------
// 数据模型（admin/tactics_progress.json，按 userId）：
//   { [userId]: { schemaVersion, selectedTier, tiers, titles, stats, attempts, updatedAt } }
const TACTICS_LEVELS_PER_TIER = 50;
const TACTICS_TIER_DEFS = [
  { key: "beginner", label: "入门", desc: "一步杀 · 底线杀 · 双重攻击 · 牵制" },
  { key: "elementary", label: "初级", desc: "两步杀 · 骑士叉 · 闪击 · 牵制获利" },
  { key: "intermediate", label: "中级", desc: "串击 · 双将 · 消除防御 · 引离" },
  { key: "advanced", label: "高级", desc: "闷杀 · 三步杀 · 弃子攻杀 · 残局技术" },
];
const TACTICS_TIERS = TACTICS_TIER_DEFS.map(t => t.key);
// 称号规则：type → total_pass | best_streak | tier_clear
const TACTICS_TITLES = [
  { id: "t10",  type: "total_pass",  target: 10,  name: "战术新兵", desc: "累计过关 10 关" },
  { id: "t50",  type: "total_pass",  target: 50,  name: "战术精兵", desc: "累计过关 50 关" },
  { id: "t100", type: "total_pass",  target: 100, name: "战术士官", desc: "累计过关 100 关" },
  { id: "t200", type: "total_pass",  target: 200, name: "战术军官", desc: "累计过关 200 关" },
  { id: "c3",   type: "best_streak", target: 3,   name: "三连胜",   desc: "任意档达成 3 连胜" },
  { id: "c5",   type: "best_streak", target: 5,   name: "五连胜",   desc: "任意档达成 5 连胜" },
  { id: "c10",  type: "best_streak", target: 10,  name: "十连胜",   desc: "任意档达成 10 连胜" },
  { id: "g1",   type: "tier_clear",  tier: "beginner",     target: TACTICS_LEVELS_PER_TIER, name: "入门毕业", desc: "通关「入门」全部 50 关" },
  { id: "g2",   type: "tier_clear",  tier: "elementary",   target: TACTICS_LEVELS_PER_TIER, name: "初级毕业", desc: "通关「初级」全部 50 关" },
  { id: "g3",   type: "tier_clear",  tier: "intermediate", target: TACTICS_LEVELS_PER_TIER, name: "中级毕业", desc: "通关「中级」全部 50 关" },
  { id: "g4",   type: "tier_clear",  tier: "advanced",     target: TACTICS_LEVELS_PER_TIER, name: "高级宗师", desc: "通关「高级」全部 50 关" },
];
let tacticsPuzzleCache = { mtimeMs: 0, byTier: {} };
function loadTactics() {
  try { const v = JSON.parse(fs.readFileSync(TACTICS_FILE, "utf8")); return (v && typeof v === "object" && !Array.isArray(v)) ? v : {}; }
  catch { return {}; }
}
function saveTactics(t) { writePrivate(TACTICS_FILE, JSON.stringify(t, null, 2)); }
function defaultTierProg() {
  return {
    unlocked: true, currentLevel: 1, passedLevels: [], failedLevels: [],
    passed: 0, combo: 0, bestCombo: 0, currentStreak: 0, bestStreak: 0,
    fails: 0, totalPassed: 0, lastAttemptId: null, updatedAt: Date.now(),
  };
}
function uniqLevelList(v) {
  return Array.from(new Set((Array.isArray(v) ? v : []).map(n => +n).filter(n => Number.isInteger(n) && n >= 1 && n <= TACTICS_LEVELS_PER_TIER))).sort((a, b) => a - b);
}
function nextUnpassedLevel(levels) {
  const done = new Set(levels || []);
  for (let i = 1; i <= TACTICS_LEVELS_PER_TIER; i++) {
    if (!done.has(i)) return i;
  }
  return TACTICS_LEVELS_PER_TIER + 1;
}
function normalizeTierProg(t) {
  const p = Object.assign(defaultTierProg(), t || {});
  const legacyPassed = Math.max(0, Math.min(TACTICS_LEVELS_PER_TIER, +p.passed || +p.totalPassed || 0));
  p.passedLevels = uniqLevelList(p.passedLevels);
  if (!p.passedLevels.length && legacyPassed > 0)
    p.passedLevels = Array.from({ length: legacyPassed }, (_, i) => i + 1);
  p.failedLevels = uniqLevelList(p.failedLevels);
  p.totalPassed = p.passedLevels.length;
  p.passed = p.totalPassed;
  p.currentLevel = nextUnpassedLevel(p.passedLevels);
  p.currentStreak = Math.max(0, +p.currentStreak || +p.combo || 0);
  p.bestStreak = Math.max(p.currentStreak, +p.bestStreak || +p.bestCombo || 0);
  p.combo = p.currentStreak;
  p.bestCombo = p.bestStreak;
  p.fails = Math.max(0, +p.fails || 0);
  return p;
}
function calcTacticsStats(prog) {
  const completedTiers = [];
  let totalPassedAllTiers = 0, bestStreakAllTiers = 0, currentStreakAllTiers = 0;
  for (const k of TACTICS_TIERS) {
    const t = normalizeTierProg(prog.tiers && prog.tiers[k]);
    totalPassedAllTiers += t.totalPassed;
    bestStreakAllTiers = Math.max(bestStreakAllTiers, t.bestStreak);
    currentStreakAllTiers = Math.max(currentStreakAllTiers, t.currentStreak);
    if (t.totalPassed >= TACTICS_LEVELS_PER_TIER) completedTiers.push(k);
  }
  return { totalPassedAllTiers, bestStreakAllTiers, currentStreakAllTiers, completedTiers };
}
function titleProgress(rule, prog) {
  const stats = prog.stats || calcTacticsStats(prog);
  if (rule.type === "total_pass") return Math.min(stats.totalPassedAllTiers, rule.target);
  if (rule.type === "best_streak") return Math.min(stats.bestStreakAllTiers, rule.target);
  if (rule.type === "tier_clear") return Math.min(((prog.tiers[rule.tier] || {}).totalPassed || 0), rule.target);
  return 0;
}
function normalizeTitles(v, prog) {
  const old = Array.isArray(v) ? v : Object.keys(v || {}).filter(k => v[k] && v[k].unlocked);
  const titles = {};
  const now = Date.now();
  for (const rule of TACTICS_TITLES) {
    const prev = !Array.isArray(v) && v && v[rule.id] ? v[rule.id] : null;
    const progress = titleProgress(rule, prog);
    const unlocked = !!(prev && prev.unlocked) || old.includes(rule.id) || progress >= rule.target;
    titles[rule.id] = {
      unlocked,
      unlockedAt: unlocked ? ((prev && prev.unlockedAt) || now) : null,
      progress, target: rule.target, condition: rule.desc,
    };
  }
  return titles;
}
// 每日解题计数（{ "YYYY-MM-DD": n }）——独立于 attempts 保存，
// 因为 attempts 只有 30 条上限，会把当天早先的解题记录挤掉，导致每日任务进度回退
function normalizeDailyMap(v) {
  const m = (v && typeof v === "object" && !Array.isArray(v)) ? Object.assign({}, v) : {};
  Object.keys(m).forEach(k => { m[k] = Math.max(0, Math.round(+m[k] || 0)); if (!m[k]) delete m[k]; });
  const keys = Object.keys(m).sort();
  while (keys.length > 14) delete m[keys.shift()];   // 只留最近 14 天
  return m;
}
// 每日布尔标记（{ "YYYY-MM-DD": true }），用于「今日残局已完成」这类跨设备同步的状态
function normalizeDayFlags(v) {
  const m = (v && typeof v === "object" && !Array.isArray(v)) ? Object.assign({}, v) : {};
  Object.keys(m).forEach(k => { if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !m[k]) delete m[k]; });
  const keys = Object.keys(m).sort();
  while (keys.length > 14) delete m[keys.shift()];
  return m;
}
function normalizeTactics(raw) {
  const prog = raw && typeof raw === "object" ? raw : {};
  const out = {
    schemaVersion: 2,
    selectedTier: TACTICS_TIERS.includes(prog.selectedTier) ? prog.selectedTier : "beginner",
    tiers: {},
    titles: {},
    stats: {},
    attempts: (prog.attempts && typeof prog.attempts === "object" && !Array.isArray(prog.attempts)) ? prog.attempts : {},
    dailySolved: normalizeDailyMap(prog.dailySolved),
    dailyDone: normalizeDayFlags(prog.dailyDone),
    updatedAt: prog.updatedAt || Date.now(),
  };
  TACTICS_TIERS.forEach(k => out.tiers[k] = normalizeTierProg(prog.tiers && prog.tiers[k]));
  out.stats = calcTacticsStats(out);
  out.titles = normalizeTitles(prog.titles, out);
  return out;
}
function getTactics(userId) {
  const all = loadTactics();
  if (!all[userId]) {
    all[userId] = normalizeTactics(null);
    saveTactics(all);
  }
  const norm = normalizeTactics(all[userId]);
  if (JSON.stringify(norm) !== JSON.stringify(all[userId])) {
    all[userId] = norm;
    saveTactics(all);
  }
  return norm;
}
function calcTacticsTitles(prog) {
  const newly = [];
  for (const rule of TACTICS_TITLES) {
    const cur = prog.titles[rule.id] || { unlocked: false };
    const progress = titleProgress(rule, prog);
    cur.progress = progress; cur.target = rule.target; cur.condition = rule.desc;
    if (!cur.unlocked && progress >= rule.target) {
      cur.unlocked = true;
      cur.unlockedAt = Date.now();
      newly.push(rule.id);
    }
    prog.titles[rule.id] = cur;
  }
  return newly;
}
function getTacticsPuzzles() {
  const file = path.join(PUBLIC_DIR, "data", "puzzles.json");
  const st = fs.statSync(file);
  if (tacticsPuzzleCache.mtimeMs === st.mtimeMs) return tacticsPuzzleCache.byTier;
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const byTier = {};
  TACTICS_TIERS.forEach(k => byTier[k] = []);
  for (const p of raw.puzzles || []) {
    if (byTier[p.tier]) byTier[p.tier].push(p);
  }
  tacticsPuzzleCache = { mtimeMs: st.mtimeMs, byTier };
  return byTier;
}
function publicPuzzle(p, includeMoves) {
  if (!p) return null;
  const out = { id: p.id, theme: p.theme, fen: p.fen, rating: p.rating, themes: p.themes || [], tier: p.tier };
  if (includeMoves) out.moves = p.moves || [];
  return out;
}
function currentTacticsPuzzle(prog, tier) {
  const pool = getTacticsPuzzles()[tier] || [];
  const t = prog.tiers[tier];
  if (!t || t.currentLevel > TACTICS_LEVELS_PER_TIER || !pool.length) return { levelNo: t ? t.currentLevel : 1, puzzle: null };
  const levelNo = Math.max(1, Math.min(TACTICS_LEVELS_PER_TIER, t.currentLevel));
  return { levelNo, puzzle: pool[Math.min(levelNo - 1, pool.length - 1)] };
}
function saveUserTactics(userId, prog) {
  prog.stats = calcTacticsStats(prog);
  calcTacticsTitles(prog);
  prog.updatedAt = Date.now();
  const all = loadTactics();
  all[userId] = prog;
  saveTactics(all);
}
function startTacticsAttempt(userId, tier) {
  const prog = getTactics(userId);
  prog.selectedTier = tier;
  const cur = currentTacticsPuzzle(prog, tier);
  if (!cur.puzzle) return { error: "该难度已通关或题库为空", prog };
  const attemptId = uuid();
  const attempt = {
    id: attemptId, tier, levelNo: cur.levelNo, puzzleId: cur.puzzle.id,
    createdAt: Date.now(), submitted: false, result: null,
  };
  prog.attempts[attemptId] = attempt;
  prog.tiers[tier].lastAttemptId = attemptId;
  const ids = Object.keys(prog.attempts).sort((a, b) => (prog.attempts[a].createdAt || 0) - (prog.attempts[b].createdAt || 0));
  while (ids.length > 30) delete prog.attempts[ids.shift()];
  saveUserTactics(userId, prog);
  return { prog, attempt, puzzle: cur.puzzle };
}
function movesEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((m, i) => String(m) === String(b[i]));
}
function applyTacticsAttempt(userId, body) {
  // ⚠️ 完整性边界：解题正确性只能与下发给客户端的解法做字符串比对，因为后端是零依赖 Node、
  // 没有走法合法性生成器（且 mateIn1 允许替代杀着）。客户端拿到解法即可"零对弈通关"。
  // 这是**已评估并接受**的架构约束，详见 AGENTS.md 第十一节；不要靠"最短用时"之类的假防线来补。
  const prog = getTactics(userId);
  const attempt = prog.attempts[String(body.attemptId || "")];
  if (!attempt) return { error: "挑战会话不存在或已过期" };
  if (attempt.submitted) return { prog, newly: [], attempt, duplicate: true };
  const tier = attempt.tier;
  const cur = currentTacticsPuzzle(prog, tier);
  if (!cur.puzzle || cur.levelNo !== attempt.levelNo || cur.puzzle.id !== attempt.puzzleId)
    return { error: "关卡状态已变化，请刷新当前关卡" };
  const solved = movesEqual(body.moves, cur.puzzle.moves);
  const t = prog.tiers[tier];
  const beforeTitles = Object.keys(prog.titles).filter(id => prog.titles[id] && prog.titles[id].unlocked);
  if (solved) {
    if (!t.passedLevels.includes(attempt.levelNo)) {
      t.passedLevels.push(attempt.levelNo);
      t.passedLevels = uniqLevelList(t.passedLevels);
      t.currentLevel = Math.min(TACTICS_LEVELS_PER_TIER + 1, attempt.levelNo + 1);
      t.totalPassed = t.passedLevels.length;
      t.passed = t.totalPassed;
      t.currentStreak += 1;
      t.bestStreak = Math.max(t.bestStreak, t.currentStreak);
      t.combo = t.currentStreak;
      t.bestCombo = t.bestStreak;
    }
  } else {
    if (!t.failedLevels.includes(attempt.levelNo)) t.failedLevels.push(attempt.levelNo);
    t.fails += 1;
    t.currentStreak = 0;
    t.combo = 0;
  }
  t.updatedAt = Date.now();
  prog.tiers[tier] = t;
  prog.stats = calcTacticsStats(prog);
  calcTacticsTitles(prog);
  const afterTitles = Object.keys(prog.titles).filter(id => prog.titles[id] && prog.titles[id].unlocked);
  const newly = afterTitles.filter(id => !beforeTitles.includes(id));
  attempt.submitted = true;
  attempt.result = { solved, levelNo: attempt.levelNo, nextLevel: t.currentLevel, currentStreak: t.currentStreak, newly, at: Date.now() };
  // 每日解题计数独立累加（不随 attempts 裁剪丢失），供每日任务/成长报告统计
  if (solved) {
    const day = chinaDay(attempt.result.at);
    prog.dailySolved = normalizeDailyMap(prog.dailySolved);
    prog.dailySolved[day] = (prog.dailySolved[day] || 0) + 1;
  }
  saveUserTactics(userId, prog);
  return { prog, newly, attempt };
}
function publicTactics(prog) {
  return {
    schemaVersion: 2,
    selectedTier: prog.selectedTier,
    tiers: prog.tiers, titles: prog.titles, stats: prog.stats, updatedAt: prog.updatedAt,
    levelsPerTier: TACTICS_LEVELS_PER_TIER,
    tiersDef: TACTICS_TIER_DEFS,
    titleDefs: TACTICS_TITLES,
    // 每日残局完成标记（跨设备同步）：{ "YYYY-MM-DD": true }
    dailyDone: prog.dailyDone || {},
  };
}

// ---------- 棋力评估（人机对战 Elo，按账号持久化，跨设备同步）----------
const CHESS_RATING_MIN = 600;
const CHESS_RATING_MAX = 2600;
const CHESS_RATING_START = 1200;
const CHESS_RATING_MIN_GAME_MS = 5000;        // 一局最短进行时长，堵瞬时脚本循环刷分
const CHESS_RATING_FINISH_MAX = 20;           // 每用户结算频率上限（窗口内最大场次）
const CHESS_RATING_FINISH_WINDOW_MS = 600000; // 频率窗口 = 10min
// 每天「计入棋力」的局数上限：超出后仍记录胜负与历史，但不再改动 rating。
// 这是产品规则（同棋类网站的每日计分上限）：把刷分收益从「每小时 +480」压到「每天 +~40」。
const CHESS_RATING_RATED_PER_DAY = 10;
// UCI 走法格式白名单（与前端 game.history({verbose:true}) 的 from/to/promotion 对应）。
// 注意：这是**格式**校验（后端无棋局合法性生成器），只能保证"像一手真棋"，
// 不能保证"这手棋在该局面下合法"——配合每日计分上限使用，不要误以为它根治了刷分。
const UCI_MOVE_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
function validUciList(list) {
  return Array.isArray(list) && list.length > 0 && list.length <= 400 && list.every(m => {
    if (typeof m !== "string" || !UCI_MOVE_RE.test(m)) return false;
    return m.slice(0, 2) !== m.slice(2, 4);   // 起止格相同的占位着法直接拒
  });
}
const CHESS_RATING_TIERS = [
  { key: "beginner", label: "初级", engineElo: 1000, movetime: 700, desc: "适合刚开始系统评估的用户" },
  { key: "intermediate", label: "中级", engineElo: 1400, movetime: 800, desc: "适合已有基础、想测试稳定性的用户" },
  { key: "advanced", label: "高级", engineElo: 1800, movetime: 1000, desc: "适合检验战术失误和残局稳定性" },
];
const CHESS_TIER_KEYS = CHESS_RATING_TIERS.map(t => t.key);
function loadChessRatings() {
  try {
    const v = JSON.parse(fs.readFileSync(CHESS_RATING_FILE, "utf8"));
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}
function saveChessRatings(v) { writePrivate(CHESS_RATING_FILE, JSON.stringify(v, null, 2)); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function defaultChessRating() {
  return {
    schemaVersion: 1,
    rating: CHESS_RATING_START,
    bestRating: CHESS_RATING_START,
    games: 0, wins: 0, draws: 0, losses: 0,
    currentStreak: 0, bestStreak: 0,
    activeGames: {},
    history: [],
    updatedAt: Date.now(),
  };
}
function normalizeChessRating(raw) {
  const r = Object.assign(defaultChessRating(), raw || {});
  r.schemaVersion = 1;
  r.rating = clamp(Math.round(+r.rating || CHESS_RATING_START), CHESS_RATING_MIN, CHESS_RATING_MAX);
  r.bestRating = clamp(Math.round(+r.bestRating || r.rating), CHESS_RATING_MIN, CHESS_RATING_MAX);
  r.games = Math.max(0, Math.round(+r.games || 0));
  r.wins = Math.max(0, Math.round(+r.wins || 0));
  r.draws = Math.max(0, Math.round(+r.draws || 0));
  r.losses = Math.max(0, Math.round(+r.losses || 0));
  r.currentStreak = Math.max(0, Math.round(+r.currentStreak || 0));
  r.bestStreak = Math.max(r.currentStreak, Math.round(+r.bestStreak || 0));
  r.activeGames = (r.activeGames && typeof r.activeGames === "object" && !Array.isArray(r.activeGames)) ? r.activeGames : {};
  r.history = Array.isArray(r.history) ? r.history.slice(-50) : [];
  r.ratedByDay = normalizeDailyMap(r.ratedByDay);
  r.updatedAt = +r.updatedAt || Date.now();
  return r;
}
function getChessRating(userId) {
  const all = loadChessRatings();
  if (!all[userId]) {
    all[userId] = defaultChessRating();
    saveChessRatings(all);
  }
  const norm = normalizeChessRating(all[userId]);
  if (JSON.stringify(norm) !== JSON.stringify(all[userId])) {
    all[userId] = norm;
    saveChessRatings(all);
  }
  return norm;
}
function publicChessRating(r) {
  const activeIds = Object.keys(r.activeGames || {});
  const activeGame = activeIds.length ? activeIds.map(id => r.activeGames[id]).find(Boolean) : null;
  return {
    rating: r.rating, bestRating: r.bestRating,
    games: r.games, wins: r.wins, draws: r.draws, losses: r.losses,
    currentStreak: r.currentStreak, bestStreak: r.bestStreak,
    lastGameAt: r.lastGameAt || null,
    activeGameId: activeGame ? activeGame.id : null,
    activeGame,
    recent: r.history.slice(-8).reverse(),
    tiers: CHESS_RATING_TIERS,
    limits: { min: CHESS_RATING_MIN, max: CHESS_RATING_MAX, start: CHESS_RATING_START },
    rated: {
      perDay: CHESS_RATING_RATED_PER_DAY,
      today: (r.ratedByDay || {})[chinaDay()] || 0,
    },
  };
}
function startChessRatingGame(userId, body) {
  const tier = CHESS_TIER_KEYS.includes(body.tier) ? body.tier : "beginner";
  const color = ["white", "black"].includes(body.color) ? body.color : (Math.random() < 0.5 ? "white" : "black");
  const tierDef = CHESS_RATING_TIERS.find(t => t.key === tier) || CHESS_RATING_TIERS[0];
  const all = loadChessRatings();
  const prog = normalizeChessRating(all[userId]);
  const gameId = uuid();
  prog.activeGames = {};
  prog.activeGames[gameId] = {
    id: gameId, tier, color,
    engine: "stockfish", engineElo: tierDef.engineElo, movetime: tierDef.movetime,
    userRatingAtStart: prog.rating, createdAt: Date.now(),
  };
  prog.updatedAt = Date.now();
  all[userId] = prog;
  saveChessRatings(all);
  return prog.activeGames[gameId];
}
function calcChessDelta(rating, engineElo, result, metrics) {
  const score = result === "win" ? 1 : (result === "draw" ? 0.5 : 0);
  const expected = 1 / (1 + Math.pow(10, (engineElo - rating) / 400));
  const k = rating < 1000 || rating > 2200 ? 14 : 18;
  const resultDelta = Math.round(k * (score - expected));
  const accuracy = clamp(Math.round(+metrics.accuracy || 70), 0, 100);
  const acpl = clamp(Math.round(+metrics.acpl || 120), 0, 600);
  const blunders = clamp(Math.round(+metrics.blunders || 0), 0, 20);
  let quality = 0;
  if (accuracy >= 88 && acpl <= 50) quality += 5;
  else if (accuracy >= 78 && acpl <= 90) quality += 2;
  if (accuracy < 55 || acpl >= 180) quality -= 4;
  if (blunders >= 3) quality -= 4;
  else if (blunders === 0 && acpl <= 80) quality += 2;
  if (result === "win" && quality < 0) quality = Math.max(quality, -2);
  if (result === "loss" && quality > 0) quality = Math.min(quality, 2);
  return clamp(resultDelta + quality, -24, 24);
}
function finishChessRatingGame(userId, body) {
  const all = loadChessRatings();
  const prog = normalizeChessRating(all[userId]);
  const gameId = String(body.gameId || "");
  const active = prog.activeGames[gameId];
  if (!active) return { error: "测评对局不存在或已结算" };
  // 反刷分(1)：一局最短进行时长，直接使「start 后秒 finish」循环全部失败
  const elapsed = active.createdAt ? (Date.now() - active.createdAt) : CHESS_RATING_MIN_GAME_MS;
  if (elapsed < CHESS_RATING_MIN_GAME_MS)
    return { error: "测评进行时间过短，无法结算（请完成真实对局）" };
  // 反刷分(2)：单用户结算频率上限，堵高速农分
  if (!rateCheck("rate:chessrating:" + userId, CHESS_RATING_FINISH_MAX, CHESS_RATING_FINISH_WINDOW_MS))
    return { error: "测评提交过于频繁，请稍后再试" };
  const result = ["win", "draw", "loss"].includes(body.result) ? body.result : null;
  if (!result) return { error: "对局结果无效" };
  // 反刷分(3)：着法必须是真实的 UCI 列表（前端传 game.history({verbose:true}) 的 from+to+promotion）。
  // 之前只校验「数量 >= 8」，一个纯数字 moves:8 就能通过 —— 现在必须给数组，且每项通过格式白名单。
  const moveList = body.moves;
  if (!Array.isArray(moveList)) return { error: "对局着法缺失，请刷新页面后重试" };
  if (!validUciList(moveList)) return { error: "对局着法格式无效，无法结算测评" };
  const moves = moveList.length;
  if (moves < 8) return { error: "有效手数不足，无法结算测评" };
  // 反刷分(4)：每日计入棋力的局数上限（独立计数，不受 history 50 条上限裁剪影响）
  const rateDay = chinaDay();
  prog.ratedByDay = normalizeDailyMap(prog.ratedByDay);
  const ratedToday = prog.ratedByDay[rateDay] || 0;
  const rated = ratedToday < CHESS_RATING_RATED_PER_DAY;
  const metrics = body.metrics && typeof body.metrics === "object" ? body.metrics : {};
  const before = prog.rating;
  const delta = rated ? calcChessDelta(before, active.engineElo, result, metrics) : 0;
  const after = clamp(before + delta, CHESS_RATING_MIN, CHESS_RATING_MAX);
  if (rated) prog.ratedByDay[rateDay] = ratedToday + 1;
  prog.rating = after;
  prog.bestRating = Math.max(prog.bestRating, after);
  prog.games += 1;
  if (result === "win") {
    prog.wins += 1;
    prog.currentStreak += 1;
    prog.bestStreak = Math.max(prog.bestStreak, prog.currentStreak);
  } else {
    if (result === "draw") prog.draws += 1;
    else prog.losses += 1;
    prog.currentStreak = 0;
  }
  const rec = {
    gameId, tier: active.tier, result, color: active.color,
    engine: active.engine, engineElo: active.engineElo,
    before, after, delta, moves, rated, ratedToday,
    accuracy: clamp(Math.round(+metrics.accuracy || 0), 0, 100),
    acpl: clamp(Math.round(+metrics.acpl || 0), 0, 600),
    blunders: clamp(Math.round(+metrics.blunders || 0), 0, 20),
    mistakes: clamp(Math.round(+metrics.mistakes || 0), 0, 50),
    playedAt: Date.now(),
  };
  prog.history.push(rec);
  prog.history = prog.history.slice(-50);
  prog.lastGameAt = rec.playedAt;
  delete prog.activeGames[gameId];
  prog.updatedAt = Date.now();
  all[userId] = prog;
  saveChessRatings(all);
  return { progress: prog, record: rec };
}
function chessLeaderboard(limit) {
  const all = loadChessRatings();
  const accounts = getAccounts();
  const byId = new Map(accounts.map(a => [a.id, a]));
  return Object.entries(all).map(([userId, raw]) => {
    const r = normalizeChessRating(raw);
    const acc = byId.get(userId);
    if (!acc || acc.status !== "active") return null;
    return {
      userId, username: acc.username,
      rating: r.rating, bestRating: r.bestRating,
      games: r.games, wins: r.wins, draws: r.draws, losses: r.losses,
      currentStreak: r.currentStreak,
    };
  }).filter(x => x && x.games > 0)
    .sort((a, b) => b.rating - a.rating || b.games - a.games || a.username.localeCompare(b.username))
    .slice(0, clamp(Math.round(+limit || 3), 1, 20));
}

// ---------- 成长中心：每日任务、活跃报告与称号 ----------
// 所有可领奖条件均由服务端已有的题型/测评记录推导，前端不能提交完成次数。
const DAILY_QUESTS = [
  { id: "check-in", label: "今日报到", desc: "打开成长中心，领取今日补给", target: 1, rewardXp: 10, rewardCoins: 5, type: "visit" },
  { id: "solve-one", label: "热身一题", desc: "今日完成 1 道题型", target: 1, rewardXp: 30, rewardCoins: 10, type: "solved" },
  { id: "solve-three", label: "战术连击", desc: "今日完成 3 道题型", target: 3, rewardXp: 55, rewardCoins: 20, type: "solved" },
  { id: "assessment", label: "实战校准", desc: "今日完成 1 局棋力测评", target: 1, rewardXp: 70, rewardCoins: 30, type: "assessment" },
];
const HONOR_DEFS = [
  { id:"rookie", icon:"♙", name:"星尘学徒", desc:"完成第一道题型", type:"solved", target:1 },
  { id:"scout", icon:"✦", name:"战术斥候", desc:"累计完成 10 题", type:"solved", target:10 },
  { id:"captain", icon:"♜", name:"棋盘队长", desc:"累计完成 50 题", type:"solved", target:50 },
  { id:"marshal", icon:"♛", name:"百题统帅", desc:"累计完成 100 题", type:"solved", target:100 },
  { id:"archivist", icon:"⌘", name:"题库守望者", desc:"累计完成 200 题", type:"solved", target:200 },
  { id:"spark3", icon:"⚡", name:"三连闪击", desc:"达成 3 连胜", type:"bestStreak", target:3 },
  { id:"spark5", icon:"☄", name:"五连星火", desc:"达成 5 连胜", type:"bestStreak", target:5 },
  { id:"spark10", icon:"✹", name:"十连风暴", desc:"达成 10 连胜", type:"bestStreak", target:10 },
  { id:"rated", icon:"◎", name:"初次定级", desc:"完成 1 局棋力测评", type:"games", target:1 },
  { id:"veteran", icon:"◈", name:"实战老兵", desc:"完成 10 局棋力测评", type:"games", target:10 },
  { id:"iron", icon:"◆", name:"铁壁棋手", desc:"完成 50 局棋力测评", type:"games", target:50 },
  { id:"rise1250", icon:"▲", name:"破晓 1250", desc:"棋力达到 1250", type:"rating", target:1250 },
  { id:"rise1400", icon:"▲", name:"锋芒 1400", desc:"棋力达到 1400", type:"rating", target:1400 },
  { id:"rise1600", icon:"▲", name:"恒星 1600", desc:"棋力达到 1600", type:"rating", target:1600 },
  { id:"rise1800", icon:"▲", name:"星舰 1800", desc:"棋力达到 1800", type:"rating", target:1800 },
  { id:"active3", icon:"☀", name:"三日航标", desc:"连续活跃 3 天", type:"activeStreak", target:3 },
  { id:"active7", icon:"☾", name:"七日轨道", desc:"连续活跃 7 天", type:"activeStreak", target:7 },
  { id:"active30", icon:"✺", name:"月度引擎", desc:"连续活跃 30 天", type:"activeStreak", target:30 },
];
function chinaDay(ts = Date.now()) {
  const parts = new Intl.DateTimeFormat("en", { timeZone:"Asia/Shanghai", year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date(ts));
  const get = t => parts.find(x => x.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function previousDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return chinaDay(Date.UTC(y, m - 1, d - 1));
}
function loadEngagement() {
  try { const v = JSON.parse(fs.readFileSync(ENGAGEMENT_FILE, "utf8")); return (v && typeof v === "object" && !Array.isArray(v)) ? v : {}; }
  catch { return {}; }
}
function saveEngagement(v) { writePrivate(ENGAGEMENT_FILE, JSON.stringify(v, null, 2)); }
function defaultEngagement() {
  return { schemaVersion:1, xp:0, coins:0, activeDays:0, activeStreak:0, bestActiveStreak:0, lastActiveDay:"", claimed:{}, reports:{}, updatedAt:Date.now() };
}
function normalizeEngagement(raw) {
  const e = Object.assign(defaultEngagement(), raw || {});
  e.schemaVersion = 1;
  e.xp = Math.max(0, Math.round(+e.xp || 0)); e.coins = Math.max(0, Math.round(+e.coins || 0));
  e.activeDays = Math.max(0, Math.round(+e.activeDays || 0)); e.activeStreak = Math.max(0, Math.round(+e.activeStreak || 0));
  e.bestActiveStreak = Math.max(e.activeStreak, Math.round(+e.bestActiveStreak || 0));
  e.claimed = (e.claimed && typeof e.claimed === "object" && !Array.isArray(e.claimed)) ? e.claimed : {};
  e.reports = (e.reports && typeof e.reports === "object" && !Array.isArray(e.reports)) ? e.reports : {};
  return e;
}
function levelForXp(xp) {
  let level = 1;
  while ((level + 1) * level * 50 <= xp) level++;
  const start = level * (level - 1) * 50, next = (level + 1) * level * 50;
  return { level, current:xp - start, needed:next - start, percent:Math.min(100, Math.round((xp - start) / (next - start) * 100)) };
}
function dayActivity(day, tactics, rating) {
  let solved = 0, assessments = 0;
  // 优先用独立的每日计数：attempts 只有 30 条上限，扫 attempts 会因裁剪而"进度回退"。
  // 老账号还没有 dailySolved 字段时，回退到扫 attempts（保持向后兼容）。
  const daily = tactics && tactics.dailySolved;
  if (daily && typeof daily === "object" && daily[day] != null) {
    solved = Math.max(0, Math.round(+daily[day] || 0));
  } else {
    for (const attempt of Object.values((tactics && tactics.attempts) || {})) {
      if (attempt && attempt.result && attempt.result.solved && chinaDay(attempt.result.at || 0) === day) solved++;
    }
  }
  for (const record of ((rating && rating.history) || [])) if (chinaDay(record.playedAt || 0) === day) assessments++;
  return { visit:1, solved, assessments };
}
function honorValue(type, tactics, rating, engagement) {
  const stats = tactics.stats || {};
  if (type === "solved") return stats.totalPassedAllTiers || 0;
  if (type === "bestStreak") return stats.bestStreakAllTiers || 0;
  if (type === "games") return rating.games || 0;
  if (type === "rating") return rating.bestRating || rating.rating || 0;
  if (type === "activeStreak") return engagement.bestActiveStreak || 0;
  return 0;
}
function publicEngagement(userId, touch) {
  const all = loadEngagement(), today = chinaDay();
  const e = normalizeEngagement(all[userId]);
  if (touch && e.lastActiveDay !== today) {
    e.activeDays++;
    e.activeStreak = e.lastActiveDay === previousDay(today) ? e.activeStreak + 1 : 1;
    e.bestActiveStreak = Math.max(e.bestActiveStreak, e.activeStreak);
    e.lastActiveDay = today;
  }
  const tactics = getTactics(userId), rating = getChessRating(userId), activity = dayActivity(today, tactics, rating);
  const claimedToday = e.claimed[today] || {};
  const quests = DAILY_QUESTS.map(q => {
    const progress = q.type === "assessment" ? activity.assessments : activity[q.type] || 0;
    return Object.assign({}, q, { progress:Math.min(q.target, progress), complete:progress >= q.target, claimed:!!claimedToday[q.id] });
  });
  const honors = HONOR_DEFS.map(h => {
    const progress = honorValue(h.type, tactics, rating, e);
    return Object.assign({}, h, { progress:Math.min(h.target, progress), unlocked:progress >= h.target });
  });
  const complete = quests.filter(q => q.complete).length, claimed = quests.filter(q => q.claimed).length;
  const report = {
    day:today, generatedAt:Date.now(), solved:activity.solved, assessments:activity.assessments,
    activeStreak:e.activeStreak, complete, claimed,
    headline: complete === quests.length ? "今日航线已满格，明天继续保持节奏。" : activity.solved ? "战术引擎正在升温，再完成一个任务就能拿到更多补给。" : "今日航线已经开启，先用一题让棋感回到棋盘上。",
  };
  e.reports[today] = report;
  for (const day of Object.keys(e.reports).sort().slice(0, -60)) delete e.reports[day];
  e.updatedAt = Date.now(); all[userId] = e; saveEngagement(all);
  return { profile:{ xp:e.xp, coins:e.coins, activeDays:e.activeDays, activeStreak:e.activeStreak, bestActiveStreak:e.bestActiveStreak, level:levelForXp(e.xp) }, quests, honors, report, reports:Object.values(e.reports).sort((a,b) => String(b.day).localeCompare(String(a.day))).slice(0, 14) };
}
function claimDailyQuest(userId, questId) {
  const quest = DAILY_QUESTS.find(q => q.id === questId);
  if (!quest) return { error:"任务不存在" };
  const state = publicEngagement(userId, true), item = state.quests.find(q => q.id === questId);
  if (!item.complete) return { error:"任务尚未完成" };
  if (item.claimed) return { error:"今日已领取该奖励" };
  const all = loadEngagement(), e = normalizeEngagement(all[userId]), today = chinaDay();
  if (!e.claimed[today]) e.claimed[today] = {};
  e.claimed[today][questId] = Date.now(); e.xp += quest.rewardXp; e.coins += quest.rewardCoins; e.updatedAt = Date.now(); all[userId] = e; saveEngagement(all);
  return { reward:{ xp:quest.rewardXp, coins:quest.rewardCoins }, engagement:publicEngagement(userId, false) };
}
function engagementLeaderboard(limit) {
  const all = loadEngagement(), accounts = new Map(getAccounts().map(a => [a.id, a]));
  return Object.entries(all).map(([userId, raw]) => {
    const a = accounts.get(userId), e = normalizeEngagement(raw);
    return a && a.status === "active" ? { username:a.username, xp:e.xp, level:levelForXp(e.xp).level, activeStreak:e.bestActiveStreak } : null;
  }).filter(Boolean).sort((a,b) => b.xp - a.xp || b.activeStreak - a.activeStreak || a.username.localeCompare(b.username)).slice(0, clamp(Math.round(+limit || 5), 1, 20));
}

// ---------- 共享棋谱库：目录、研读架、投稿与讨论 ----------
// 谱库内容按账号归属；公开浏览不要求登录，但收藏、投稿和讨论必须有会话。
const LIBRARY_CATEGORIES = [
  { id:"opening", name:"开局档案", mark:"OP" },
  { id:"middlegame", name:"中局计划", mark:"MP" },
  { id:"tactics", name:"战术专题", mark:"TC" },
  { id:"endgame", name:"残局手册", mark:"EG" },
  { id:"masterpiece", name:"名局复盘", mark:"GM" },
];
const LIBRARY_CATEGORY_IDS = new Set(LIBRARY_CATEGORIES.map(x => x.id));
function librarySeedEntry(id, category, title, summary, tags, pgn, daysAgo, scores) {
  const now = Date.now() - daysAgo * 864e5;
  return { id, category, title, summary, tags, pgn, authorId:"", author:"S.T.A.R. 档案室", createdAt:now, updatedAt:now, stars:{}, comments:[], copies:0, views:0, scores:scores || { acc:6, freq:6, diff:5, util:6 } };
}
function defaultLibrary() {
  return {
    schemaVersion:1,
    entries:[
      librarySeedEntry("star-opening-ruy", "opening", "西班牙开局：中心反击的 12 个节点", "从 e4-e5 的张力开始，辨认何时该完成发展、何时该用 d5 夺回中心。", ["西班牙开局","中心","发展"], "[Event \"Study: Ruy Lopez\"]\n[Result \"*\"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 *", 18, { acc:8.8, freq:9.2, diff:3.5, util:9.0 }),
      librarySeedEntry("star-tactic-pin", "tactics", "绝对牵制：别只看被牵住的子", "用五个短局面训练你先找国王身后的线路，再决定交换还是加压。", ["牵制","线路","战术"], "[Event \"Study: Absolute pin\"]\n[Result \"*\"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6 5. O-O f6 6. d4 exd4 7. Nxd4 c5 8. Nb3 Qxd1 9. Rxd1 *", 12, { acc:8.2, freq:7.5, diff:4.0, util:8.0 }),
      librarySeedEntry("star-endgame-pawn", "endgame", "王兵残局：通路兵之前，先数节奏", "对王、关键格与兵形节奏的入门索引；每个判断都可在棋盘上自己复现。", ["王兵残局","对王","通路兵"], "[Event \"Study: King and pawn\"]\n[Result \"1-0\"]\n\n1. e4 e5 2. Ke2 Ke7 3. Ke3 Ke6 4. d4 exd4+ 5. Kxd4 d6 6. Nf3 Nc6+ 7. Ke3 1-0", 8, { acc:9.0, freq:8.0, diff:2.5, util:8.5 }),
      librarySeedEntry("star-master-capablanca", "masterpiece", "卡帕布兰卡：把优势换成残局", "阅读一盘以简化而非猛攻取胜的名局，重点标出每一次主动换子的条件。", ["卡帕布兰卡","简化","名局"], "[Event \"Study: Conversion\"]\n[Result \"*\"]\n\n1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 Be7 5. e3 O-O 6. Nf3 h6 7. Bh4 b6 8. cxd5 Nxd5 9. Bxe7 Qxe7 *", 5, { acc:9.5, freq:6.5, diff:6.0, util:8.8 }),
      librarySeedEntry("star-plan-isolani", "middlegame", "孤兵局面：何时进攻，何时交换", "从开放线、轻子和王翼空间三个信号判断孤兵是资产还是包袱。", ["孤兵","中局","计划"], "[Event \"Study: Isolated pawn\"]\n[Result \"*\"]\n\n1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. cxd5 exd5 5. Bg5 Be7 6. e3 O-O 7. Bd3 c6 8. Qc2 Re8 9. Nge2 Nbd7 *", 3, { acc:8.6, freq:7.0, diff:6.5, util:7.5 }),
    ],
    collections:{},
  };
}
function loadLibrary() {
  try {
    const v = JSON.parse(fs.readFileSync(LIBRARY_FILE, "utf8"));
    if (v && Array.isArray(v.entries) && v.collections && typeof v.collections === "object") { migrateLibrary(v); return v; }
  } catch {}
  const seed = defaultLibrary(); saveLibrary(seed); return seed;
}
// ---- 棋谱 v2：目录编号 / 四维评分 / 研读热度（参考 Project Kylin 的谱库设计）----
const LIBRARY_SCORE_KEYS = ["acc", "freq", "diff", "util"];   // 准确 / 频率 / 难度 / 实用
function clampLibraryScore(v) {
  const n = Math.round((+v || 0) * 10) / 10;
  return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 0;
}
function libraryScoreAvg(entry) {
  const s = entry.scores || {};
  const sum = LIBRARY_SCORE_KEYS.reduce((a, k) => a + clampLibraryScore(s[k]), 0);
  return Math.round((sum / LIBRARY_SCORE_KEYS.length) * 10) / 10;
}
function libraryRounds(pgn) {
  const m = String(pgn || "").match(/\b\d+\./g);
  return m ? m.length : 0;
}
// 给缺编号/缺新字段的存量棋谱补齐；编号规则 STAR-年份-四位序号（按创建时间顺序， yearly 递增）
function migrateLibrary(data) {
  let changed = false;
  for (const e of data.entries) {
    if (!Array.isArray(e.comments)) { e.comments = []; changed = true; }
    if (typeof e.views !== "number" || !Number.isFinite(e.views)) { e.views = Math.max(0, Math.round(+e.views || 0)); changed = true; }
    if (!e.scores || typeof e.scores !== "object") { e.scores = { acc:6, freq:6, diff:5, util:6 }; changed = true; }
  }
  const missing = data.entries.filter(e => !e.code).sort((a, b) => a.createdAt - b.createdAt);
  if (missing.length) {
    changed = true;
    const nextByYear = new Map();
    for (const e of data.entries) {
      const m = /^STAR-(\d{2})-(\d{4})$/.exec(e.code || "");
      if (m) nextByYear.set(m[1], Math.max(nextByYear.get(m[1]) || 0, +m[2]));
    }
    for (const e of missing) {
      const y = String(new Date(e.createdAt || Date.now()).getFullYear() % 100).padStart(2, "0");
      const next = (nextByYear.get(y) || 0) + 1;
      nextByYear.set(y, next);
      e.code = "STAR-" + y + "-" + String(next).padStart(4, "0");
    }
  }
  if (changed) saveLibrary(data);
}
function nextLibraryCode(data) {
  const y = String(new Date().getFullYear() % 100).padStart(2, "0");
  let next = 0;
  for (const e of data.entries) {
    const m = /^STAR-(\d{2})-(\d{4})$/.exec(e.code || "");
    if (m && m[1] === y) next = Math.max(next, +m[2]);
  }
  return "STAR-" + y + "-" + String(next + 1).padStart(4, "0");
}

// ---------- 文学板块：点赞与评论（绑定站点账号）----------
// 数据：admin/literature.json  { schemaVersion, articles: { <key>: { likes:[userId], comments:[{id,userId,name,text,ts}], createdAt } } }
const LIT_FILE = path.join(ADMIN_DIR, "literature.json");
const LIT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;   // 文章 key：小写字母数字与 _-，≤32 字符
const LIT_TEXT_MAX = 600;                          // 单条评论最大长度
const LIT_KEEP = 200;                              // 每篇保留的评论条数（取最新）
const LIT_COOLDOWN_MS = 5000;                      // 同一用户对同一篇的评论冷却
const litCooldown = new Map();                     // "userId:key" -> 上次评论时间
function loadLit() {
  try {
    const v = JSON.parse(fs.readFileSync(LIT_FILE, "utf8"));
    if (v && v.articles && typeof v.articles === "object" && !Array.isArray(v.articles)) return v;
  } catch {}
  const d = { schemaVersion: 1, articles: {} };
  writePrivate(LIT_FILE, JSON.stringify(d, null, 2));
  return d;
}
function saveLit(v) { writePrivate(LIT_FILE, JSON.stringify(v, null, 2)); }
// 允许互动的作品 key：页面上的四篇 + 受保护正文文件里登记的作品。
// 不加校验的话，任何人都能对任意 key 点赞/评论 → 服务器上会被灌出无限垃圾记录。
const LIT_KNOWN_KEYS = ["bach", "jasmine", "mint", "dusk"];
function litKnown(key) {
  if (LIT_KNOWN_KEYS.indexOf(key) >= 0) return true;
  return !!litGatedMeta(key);
}
// ---------- 好友系统（好友关系 / 申请 / 留言）----------
// 数据：admin/friends.json  { schemaVersion, requests:[{id,from,to,ts,status,decidedAt}], friends:[{a,b,since}], messages:[{id,from,to,text,ts}] }
const FRIENDS_FILE = path.join(ADMIN_DIR, "friends.json");
function loadFriends() {
  try {
    const v = JSON.parse(fs.readFileSync(FRIENDS_FILE, "utf8"));
    if (v && Array.isArray(v.requests) && Array.isArray(v.friends) && Array.isArray(v.messages)) return v;
  } catch {}
  const d = { schemaVersion: 1, requests: [], friends: [], messages: [] };
  writePrivate(FRIENDS_FILE, JSON.stringify(d, null, 2));
  return d;
}
function saveFriends(v) { writePrivate(FRIENDS_FILE, JSON.stringify(v, null, 2)); }
function friendUser(id) {
  const accounts = loadAccounts();
  if (Array.isArray(accounts)) { const u = accounts.find(a => a && a.id === id); if (u) return { id: u.id, username: u.username }; }
  return { id, username: "已注销" };
}
function isFriend(a, b) {
  if (!a || !b) return false;
  const f = loadFriends();
  return f.friends.some(x => (x.a === a && x.b === b) || (x.a === b && x.b === a));
}
function friendRelation(me, other) {
  if (!other) return "none";
  if (me === other) return "self";
  if (isFriend(me, other)) return "friend";
  const f = loadFriends();
  if (f.requests.some(r => r.from === me && r.to === other && r.status === "pending")) return "pending_out";
  if (f.requests.some(r => r.from === other && r.to === me && r.status === "pending")) return "pending_in";
  return "none";
}

function litArticle(data, key, create) {
  let a = data.articles[key];
  if (!a && create) { a = data.articles[key] = { likes: [], comments: [], createdAt: Date.now() }; }
  if (!a) return null;
  if (!Array.isArray(a.likes)) a.likes = [];
  if (!Array.isArray(a.comments)) a.comments = [];
  return a;
}
function litName(userId) {
  const accounts = loadAccounts();
  if (Array.isArray(accounts)) {
    const u = accounts.find(x => x && x.id === userId);
    if (u && u.username) return String(u.username).slice(0, 24);
  }
  return "读者";
}
function litPublic(data, userId) {
  const out = {};
  // 受保护作品即使还没有任何点赞/评论也要出现在列表里（否则前端拿不到 gated 状态、卡片显示不出锁标识）
  const keys = Object.keys(data.articles);
  Object.keys(loadLitContent().articles || {}).forEach(k => { if (keys.indexOf(k) < 0) keys.push(k); });
  for (const key of keys) {
    if (!litKnown(key)) continue;          // 脏数据（不在白名单里的 key）不对外暴露
    let a = litArticle(data, key, false);
    const acc = litAccess(key, userId);
    // 受保护但还没人互动过：也要返回状态（前端靠它渲染锁标识），只是计数为 0
    if (!a) {
      if (!acc.gated) continue;
      a = { likes: [], comments: [] };
    }
    out[key] = {
      gated: !!acc.gated,
      access: acc.state,
      allowed: !!acc.allowed,
      owner: acc.owner || "",
      likes: a.likes.length,
      liked: !!userId && a.likes.indexOf(userId) >= 0,
      comments: a.comments.slice(-LIT_KEEP).map(c => ({
        id: c.id, uid: c.userId, name: c.name, text: c.text, ts: c.ts, mine: !!userId && c.userId === userId,
      })),
    };
  }
  return { articles: out };
}
function litToggleLike(userId, key) {
  const data = loadLit();
  const a = litArticle(data, key, true);
  const i = a.likes.indexOf(userId);
  if (i >= 0) a.likes.splice(i, 1); else a.likes.push(userId);
  saveLit(data);
  return { likes: a.likes.length, liked: i < 0 };
}
function litComment(userId, key, rawText) {
  let text = String(rawText == null ? "" : rawText);
  // 去掉控制字符与零宽字符，压缩连续空白
  text = text.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return { error: "评论不能为空" };
  if (text.length > LIT_TEXT_MAX) return { error: "评论过长（最多 " + LIT_TEXT_MAX + " 字）" };
  {
    const acc = litAccess(key, userId);
    if (acc.gated && !acc.allowed) return { error: "需要作者授权后才能评论" };
  }
  const ck = userId + ":" + key;
  const last = litCooldown.get(ck) || 0;
  if (Date.now() - last < LIT_COOLDOWN_MS) return { error: "评论太频繁，请稍后再试" };
  litCooldown.set(ck, Date.now());
  const data = loadLit();
  const a = litArticle(data, key, true);
  const c = { id: uuid(), userId, name: litName(userId), text, ts: Date.now() };
  a.comments.push(c);
  if (a.comments.length > LIT_KEEP) a.comments = a.comments.slice(-LIT_KEEP);
  saveLit(data);
  return { comment: { id: c.id, name: c.name, text: c.text, ts: c.ts, mine: true }, likes: a.likes.length };
}
function litDeleteComment(userId, key, cid, isAdmin) {
  const data = loadLit();
  const a = litArticle(data, key, false);
  if (!a) return { error: "文章不存在" };
  const i = a.comments.findIndex(c => c.id === cid);
  if (i < 0) return { error: "评论不存在" };
  if (a.comments[i].userId !== userId && !isAdmin) return { error: "只能删除自己的评论" };
  a.comments.splice(i, 1);
  saveLit(data);
  return { ok: true };
}


// ---------- 文学板块：受保护作品（登录 + 作者授权才可阅读）----------
// 正文不放在页面上（否则查看源码即可绕过），只存于 admin/literature_content.json；
// 访问申请记录在 literature.json 的 articles[key].access.requests 里。
const LIT_CONTENT_FILE = path.join(ADMIN_DIR, "literature_content.json");
function loadLitContent() {
  try {
    const v = JSON.parse(fs.readFileSync(LIT_CONTENT_FILE, "utf8"));
    if (v && v.articles && typeof v.articles === "object") return v;
  } catch {}
  return { schemaVersion: 1, articles: {} };
}
function litAccount(userId) {
  const accounts = loadAccounts();
  if (!Array.isArray(accounts) || !userId) return null;
  return accounts.find(a => a && a.id === userId) || null;
}
function litGatedMeta(key) {
  const c = loadLitContent();
  const art = c.articles[key];
  if (!art) return null;
  return { key, title: art.title || key, author: art.author || "", owner: art.owner || "Tommy" };
}
function litRequests(data, key) {
  const a = litArticle(data, key, true);
  if (!a.access || typeof a.access !== "object") a.access = { requests: [] };
  if (!Array.isArray(a.access.requests)) a.access.requests = [];
  return a.access.requests;
}
/* 访问状态：public / need_login / owner / granted / pending / denied / none */
function litAccess(key, userId) {
  const meta = litGatedMeta(key);
  if (!meta) return { gated: false, state: "public" };
  if (!userId) return { gated: true, state: "need_login", owner: meta.owner, title: meta.title, author: meta.author };
  const acc = litAccount(userId);
  const uname = acc ? acc.username : "";
  if (uname && uname === meta.owner) return { gated: true, state: "owner", allowed: true, owner: meta.owner, title: meta.title, author: meta.author };
  const req = litRequests(loadLit(), key).find(r => r.userId === userId);
  const st = req ? req.status : "none";
  return { gated: true, state: st, allowed: st === "approved", owner: meta.owner, title: meta.title, author: meta.author };
}
function litRequestAccess(userId, key) {
  const meta = litGatedMeta(key);
  if (!meta) return { error: "该作品无需授权" };
  const data = loadLit();
  const list = litRequests(data, key);
  const i = list.findIndex(r => r.userId === userId);
  if (i >= 0 && list[i].status === "approved") return { state: "approved" };
  const acc = litAccount(userId);
  const rec = { userId, name: acc ? acc.username : "读者", ts: Date.now(), status: "pending" };
  if (i >= 0) list[i] = rec; else list.push(rec);
  saveLit(data);
  return { state: "pending", requestedAt: rec.ts };
}
function litDecideAccess(deciderId, key, targetUserId, approve) {
  const meta = litGatedMeta(key);
  if (!meta) return { error: "该作品无需授权" };
  const decider = litAccount(deciderId);
  if (!decider || decider.username !== meta.owner) return { error: "只有作者本人可以审批" };
  const data = loadLit();
  const list = litRequests(data, key);
  const i = list.findIndex(r => r.userId === targetUserId);
  if (i < 0) return { error: "申请记录不存在" };
  list[i].status = approve ? "approved" : "denied";
  list[i].decidedAt = Date.now();
  list[i].decidedBy = decider.username;
  saveLit(data);
  return { ok: true, state: list[i].status, name: list[i].name };
}
/* 通知：作者看「待审批」，读者看「我的申请状态」 */
function litNotifications(userId) {
  const data = loadLit();
  const content = loadLitContent();
  const keys = Object.keys(content.articles || {});
  const mine = [];
  const pending = [];
  for (const key of keys) {
    const meta = litGatedMeta(key);
    if (!meta) continue;
    const list = litRequests(data, key);
    const myReq = list.find(r => r.userId === userId);
    if (myReq) mine.push({ key, title: meta.title, status: myReq.status, ts: myReq.ts, decidedAt: myReq.decidedAt || 0 });
    if (meta.owner && litAccount(userId) && litAccount(userId).username === meta.owner) {
      list.filter(r => r.status === "pending").forEach(r => pending.push({ key, title: meta.title, userId: r.userId, name: r.name, ts: r.ts }));
    }
  }
  pending.sort((a, b) => b.ts - a.ts);
  return { owner: pending.length > 0, pending, mine, pendingCount: pending.length };
}

function registerLibraryView(id) {
  const data = loadLibrary(), entry = findLibraryEntry(data, id);
  if (!entry) return null;
  entry.views = Math.min(1e6, Math.max(0, Math.round(+entry.views || 0)) + 1);
  saveLibrary(data);
  return entry.views;
}

// ---------- 背谱训练（Opening Memory）：从共享棋谱导入线路，Leitner 间隔重复 ----------
// 与闯关相同的一致性边界：训练由客户端进行、服务端只记录会话结果（低风险：仅影响记忆进度，不发奖励）。
const TRAINER_FILE = path.join(ADMIN_DIR, "trainer.json");
const TRAINER_INTERVALS_DAYS = [1, 3, 7, 14, 30, 60];   // box 1..6 的复习间隔（天）
function loadTrainer() {
  try {
    const v = JSON.parse(fs.readFileSync(TRAINER_FILE, "utf8"));
    if (v && v.lines && typeof v.lines === "object" && !Array.isArray(v.lines)) return v;
  } catch {}
  const d = { schemaVersion: 1, lines: {} };
  writePrivate(TRAINER_FILE, JSON.stringify(d, null, 2));
  return d;
}
function saveTrainer(v) { writePrivate(TRAINER_FILE, JSON.stringify(v, null, 2)); }
function normalizeTrainerLine(l) {
  return {
    key: String(l.key || ""), sourceId: String(l.sourceId || ""), code: String(l.code || ""), title: cleanLibraryText(l.title, 60),
    moves: Array.isArray(l.moves) ? l.moves.slice(0, 160) : [],
    box: Math.max(0, Math.min(TRAINER_INTERVALS_DAYS.length, Math.round(+l.box || 0))),
    dueAt: +l.dueAt || 0, streak: Math.max(0, Math.round(+l.streak || 0)),
    bestStreak: Math.max(0, Math.round(+l.bestStreak || 0)),
    sessions: Math.max(0, Math.round(+l.sessions || 0)), errors: Math.max(0, Math.round(+l.errors || 0)),
    addedAt: +l.addedAt || Date.now(), lastTrainedAt: +l.lastTrainedAt || 0,
  };
}
function trainerPublicLine(l) {
  // moveList 是用户自己的训练数据（导入即由本人提交），随行返回供训练界面使用
  return { key:l.key, sourceId:l.sourceId, code:l.code || "", title:l.title, moveList:l.moves, moves:l.moves.length,
    box:l.box, boxMax:TRAINER_INTERVALS_DAYS.length, due:l.dueAt <= Date.now(), dueAt:l.dueAt,
    nextDays: l.dueAt <= Date.now() ? 0 : (TRAINER_INTERVALS_DAYS[l.box] || 60),
    streak:l.streak, bestStreak:l.bestStreak, sessions:l.sessions, errors:l.errors, addedAt:l.addedAt };
}
function trainerImport(userId, body) {
  const sourceId = String(body.sourceId || "").slice(0, 64);
  const title = cleanLibraryText(body.title, 60);
  const moves = Array.isArray(body.moves) ? body.moves : [];
  if (!sourceId) return { error:"缺少来源棋谱" };
  if (moves.length < 2) return { error:"这条棋谱没有可训练的着法" };
  if (moves.length > 160) return { error:"线路过长（最多 160 手）" };
  if (!moves.every(m => typeof m === "string" && UCI_MOVE_RE.test(m) && m.slice(0, 2) !== m.slice(2, 4)))
    return { error:"着法格式无效" };
  const data = loadTrainer();
  if (!data.lines[userId] || typeof data.lines[userId] !== "object") data.lines[userId] = {};
  const userLines = data.lines[userId];
  if (Object.values(userLines).some(l => l.sourceId === sourceId)) return { error:"这条棋谱已在你的训练计划里" };
  const key = "tl-" + uuid();
  const libEntry = findLibraryEntry(loadLibrary(), sourceId);
  const line = normalizeTrainerLine({ key, sourceId, title, moves, box:0, dueAt:0, addedAt:Date.now(), code: libEntry ? libEntry.code || "" : "" });
  userLines[key] = line;
  saveTrainer(data);
  return { line: trainerPublicLine(userLines[key]) };
}
function trainerLines(userId) {
  const data = loadTrainer();
  const userLines = data.lines[userId] || {};
  return { lines: Object.values(userLines).map(trainerPublicLine).sort((a, b) => (a.dueAt - b.dueAt) || (b.addedAt - a.addedAt)), intervals: TRAINER_INTERVALS_DAYS };
}
function trainerSession(userId, key, body) {
  const data = loadTrainer(), userLines = data.lines[userId] || {};
  const line = userLines[key];
  if (!line) return { error:"训练线路不存在" };
  const errors = Math.max(0, Math.min(400, Math.round(+body.errors || 0)));
  const done = body.done !== false;
  line.sessions += 1; line.errors += errors; line.lastTrainedAt = Date.now();
  // Leitner：全对 → 记忆盒 +1（间隔变长）；有错 → 盒 -1，明天再来。中途放弃不动盒子。
  if (done && errors === 0) {
    line.streak += 1; line.bestStreak = Math.max(line.bestStreak, line.streak);
    line.box = Math.min(TRAINER_INTERVALS_DAYS.length, line.box + 1);
  } else if (done) {
    line.streak = 0; line.box = Math.max(0, line.box - 1);
  }
  const days = line.box >= TRAINER_INTERVALS_DAYS.length ? 60 : TRAINER_INTERVALS_DAYS[line.box];
  line.dueAt = Date.now() + days * 864e5;
  saveTrainer(data);
  return { line: trainerPublicLine(line), nextDays: days };
}
function trainerRemove(userId, key) {
  const data = loadTrainer(), userLines = data.lines[userId] || {};
  if (!userLines[key]) return { error:"训练线路不存在" };
  delete userLines[key]; saveTrainer(data); return { ok:true };
}
function saveLibrary(v) { writePrivate(LIBRARY_FILE, JSON.stringify(v, null, 2)); }
function cleanLibraryText(value, maxLen) {
  if (typeof value !== "string") return "";
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").trim().slice(0, maxLen);
}
function libraryAuthor(entry) {
  if (!entry.authorId) return entry.author || "S.T.A.R. 档案室";
  const account = getAccounts().find(a => a.id === entry.authorId);
  return account ? account.username : "已注销棋手";
}
function libraryPublicEntry(entry, userId, detail) {
  const stars = entry.stars && typeof entry.stars === "object" ? entry.stars : {};
  const collection = userId && loadLibrary().collections && loadLibrary().collections[userId];
  const s = entry.scores && typeof entry.scores === "object" ? entry.scores : {};
  const out = {
    id:entry.id, title:entry.title, summary:entry.summary, category:entry.category,
    tags:Array.isArray(entry.tags) ? entry.tags : [], author:libraryAuthor(entry),
    createdAt:entry.createdAt, updatedAt:entry.updatedAt, stars:Object.keys(stars).length,
    comments:Array.isArray(entry.comments) ? entry.comments.length : 0, copies:Math.max(0, +entry.copies || 0),
    starred:!!(userId && stars[userId]), collected:!!(userId && collection && collection[entry.id]), owned:!!(userId && entry.authorId === userId),
    code:entry.code || "", views:Math.max(0, Math.round(+entry.views || 0)),
    scores:Object.fromEntries(LIBRARY_SCORE_KEYS.map(k => [k, clampLibraryScore(s[k])])),
    score:libraryScoreAvg(entry), rounds:libraryRounds(entry.pgn),
  };
  if (detail) {
    out.pgn = entry.pgn || "";
    out.commentList = (entry.comments || []).slice(-50).map(c => ({ id:c.id, author:libraryAuthor({ authorId:c.authorId, author:c.author }), text:c.text, createdAt:c.createdAt, owned:!!(userId && c.authorId === userId) }));
  }
  return out;
}
function libraryList(userId, query) {
  const data = loadLibrary();
  const q = cleanLibraryText(query.get("q") || "", 80).toLocaleLowerCase();
  const category = String(query.get("category") || "all");
  const sort = ["new", "hot", "copies", "views", "score", "comments"].includes(query.get("sort")) ? query.get("sort") : "new";
  const pageSize = Math.max(4, Math.min(24, Math.round(+query.get("pageSize") || 8)));
  const page = Math.max(1, Math.round(+query.get("page") || 1));
  const matched = data.entries.filter(e => {
    const haystack = [e.title, e.summary, e.code || ""].concat(e.tags || []).join(" ").toLocaleLowerCase();
    return (!q || haystack.includes(q));
  });
  // 分类计数按当前检索词计算（不含分类本身），供目录导航显示“每格几份”
  const counts = { all:matched.length };
  for (const c of LIBRARY_CATEGORIES) counts[c.id] = matched.filter(e => e.category === c.id).length;
  let entries = matched.filter(e => category === "all" || e.category === category);
  entries.sort((a, b) => {
    if (sort === "hot") return Object.keys(b.stars || {}).length - Object.keys(a.stars || {}).length || b.createdAt - a.createdAt;
    if (sort === "copies") return (+b.copies || 0) - (+a.copies || 0) || b.createdAt - a.createdAt;
    if (sort === "views") return (+b.views || 0) - (+a.views || 0) || b.createdAt - a.createdAt;
    if (sort === "score") return libraryScoreAvg(b) - libraryScoreAvg(a) || b.createdAt - a.createdAt;
    if (sort === "comments") return (Array.isArray(b.comments) ? b.comments.length : 0) - (Array.isArray(a.comments) ? a.comments.length : 0) || b.createdAt - a.createdAt;
    return b.createdAt - a.createdAt;
  });
  const total = entries.length, pages = Math.max(1, Math.ceil(total / pageSize));
  return { categories:LIBRARY_CATEGORIES, counts, entries:entries.slice((Math.min(page, pages) - 1) * pageSize, Math.min(page, pages) * pageSize).map(e => libraryPublicEntry(e, userId, false)), total, page:Math.min(page, pages), pages, sort, category, query:q };
}
function findLibraryEntry(data, id) { return data.entries.find(e => e.id === id); }
function createLibraryEntry(userId, body) {
  const title = cleanLibraryText(body.title, 60), summary = cleanLibraryText(body.summary, 420);
  const category = String(body.category || "");
  const pgn = cleanLibraryText(body.pgn, 16000);
  const tags = Array.isArray(body.tags) ? body.tags.map(x => cleanLibraryText(String(x), 18)).filter(Boolean).slice(0, 6) : [];
  if (title.length < 3) return { error:"标题至少 3 个字" };
  if (!LIBRARY_CATEGORY_IDS.has(category)) return { error:"请选择有效分类" };
  if (summary.length < 12) return { error:"摘要至少 12 个字，说明这份棋谱值得读什么" };
  if (pgn.length < 12) return { error:"请贴入至少一段 PGN 或棋谱文本" };
  const data = loadLibrary(), now = Date.now();
  const scoresIn = body.scores && typeof body.scores === "object" ? body.scores : {};
  const entry = { id:"lib-" + uuid(), code:nextLibraryCode(data), title, summary, category, tags, pgn,
    authorId:userId, author:"", createdAt:now, updatedAt:now, stars:{}, comments:[], copies:0, views:0,
    scores:Object.fromEntries(LIBRARY_SCORE_KEYS.map(k => [k, clampLibraryScore(scoresIn[k])])) };
  data.entries.push(entry); saveLibrary(data); return { entry:libraryPublicEntry(entry, userId, true) };
}
function toggleLibraryStar(userId, id) {
  const data = loadLibrary(), entry = findLibraryEntry(data, id);
  if (!entry) return { error:"资料不存在或已撤下" };
  if (!entry.stars || typeof entry.stars !== "object") entry.stars = {};
  if (entry.stars[userId]) delete entry.stars[userId]; else entry.stars[userId] = Date.now();
  entry.updatedAt = Date.now(); saveLibrary(data); return { entry:libraryPublicEntry(entry, userId, true) };
}
function collectLibraryEntry(userId, id) {
  const data = loadLibrary(), entry = findLibraryEntry(data, id);
  if (!entry) return { error:"资料不存在或已撤下" };
  if (!data.collections[userId]) data.collections[userId] = {};
  if (data.collections[userId][id]) {
    delete data.collections[userId][id];
    entry.copies = Math.max(0, (+entry.copies || 0) - 1);   // 取消收藏同步递减计数
    saveLibrary(data);
    return { collected:false, entry:libraryPublicEntry(entry, userId, true) };
  }
  data.collections[userId][id] = { collectedAt:Date.now() };
  entry.copies = Math.max(0, +entry.copies || 0) + 1;
  saveLibrary(data); return { collected:true, fresh:true, entry:libraryPublicEntry(entry, userId, true) };
}
function addLibraryComment(userId, id, raw) {
  const text = cleanLibraryText(raw, 300), data = loadLibrary(), entry = findLibraryEntry(data, id);
  if (!entry) return { error:"资料不存在或已撤下" };
  if (text.length < 2) return { error:"评论至少写 2 个字" };
  const account = getAccounts().find(a => a.id === userId);
  if (!account) return { error:"账号不存在" };
  if (!Array.isArray(entry.comments)) entry.comments = [];
  entry.comments.push({ id:"comment-" + uuid(), authorId:userId, author:account.username, text, createdAt:Date.now() });
  entry.updatedAt = Date.now(); saveLibrary(data); return { entry:libraryPublicEntry(entry, userId, true) };
}
function libraryMine(userId) {
  const data = loadLibrary(), collected = data.collections[userId] || {};
  return {
    submitted:data.entries.filter(e => e.authorId === userId).sort((a,b) => b.createdAt - a.createdAt).map(e => libraryPublicEntry(e, userId, false)),
    collected:Object.keys(collected).map(id => findLibraryEntry(data, id)).filter(Boolean).sort((a,b) => (collected[b.id].collectedAt || 0) - (collected[a.id].collectedAt || 0)).map(e => libraryPublicEntry(e, userId, false)),
  };
}
function deleteLibraryEntry(userId, id) {
  const data = loadLibrary(), entry = findLibraryEntry(data, id);
  if (!entry) return { error:"资料不存在或已撤下" };
  const account = getAccounts().find(a => a.id === userId);
  if (entry.authorId !== userId && !(account && account.role === "admin")) return { error:"只能撤下自己的投稿" };
  data.entries = data.entries.filter(e => e.id !== id);
  for (const shelf of Object.values(data.collections)) if (shelf && typeof shelf === "object") delete shelf[id];
  saveLibrary(data); return { ok:true };
}
function deleteLibraryComment(userId, entryId, commentId) {
  const data = loadLibrary(), entry = findLibraryEntry(data, entryId);
  if (!entry || !Array.isArray(entry.comments)) return { error:"评论不存在或资料已撤下" };
  const account = getAccounts().find(a => a.id === userId), comment = entry.comments.find(c => c.id === commentId);
  if (!comment) return { error:"评论不存在或已删除" };
  if (comment.authorId !== userId && !(account && account.role === "admin")) return { error:"只能删除自己的评论" };
  entry.comments = entry.comments.filter(c => c.id !== commentId); entry.updatedAt = Date.now(); saveLibrary(data);
  return { ok:true };
}

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
    // -P 强制 POSIX 输出：macOS 的 df 默认多出 iused/ifree/%iused 三列，
    // 按列位置取值会整体错位（曾把 Used 当 total、Available 当 used、iused 当 percent，
    // 出现 "used > total"、"percent 426864"、"free null" 的不可能值）；Linux 上原下标也差一位。
    execFile("df", ["-kP", "/"], (err, out) => {
      if (err) return resolve({ total: 0, used: 0, free: 0, percent: 0 });
      const row = out.trim().split("\n").slice(1)
        .map(l => l.trim().split(/\s+/))
        .filter(c => c.length >= 6 && c[c.length - 1] === "/")
        .pop();
      if (!row) return resolve({ total: 0, used: 0, free: 0, percent: 0 });
      resolve({
        total: +row[1] * 1024,
        used: +row[2] * 1024,
        free: +row[3] * 1024,
        percent: +(row[4].replace("%", "")) || 0,
      });
    });
  });
}
// 可用内存：os.freemem() 在 macOS 不含 inactive/cached 页，恒被算成「用了 96~99%」，
// Linux 也不含可回收的 cache。这里尽量取「真正可用」的口径，让后台的内存条有意义。
function readMemInfo() {
  try {
    const txt = fs.readFileSync("/proc/meminfo", "utf8");
    const pick = k => { const m = txt.match(new RegExp("^" + k + ":\\s+(\\d+) kB", "m")); return m ? +m[1] * 1024 : 0; };
    const total = pick("MemTotal"), avail = pick("MemAvailable");
    return (total && avail) ? { total, free: avail, source: "MemAvailable" } : null;
  } catch { return null; }
}
function darwinAvailableMem() {
  return new Promise(resolve => {
    execFile("vm_stat", (err, out) => {
      if (err) return resolve(null);
      const psz = +((out.match(/page size of (\d+) bytes/) || [])[1] || 4096);
      const pick = k => { const m = out.match(new RegExp("^" + k + ":\\s+(\\d+)\\.", "m")); return m ? +m[1] : 0; };
      const free = (pick("Pages free") + pick("Pages inactive") + pick("Pages speculative")) * psz;
      resolve(free > 0 ? free : null);
    });
  });
}
async function getMem() {
  let total = os.totalmem();
  let free = os.freemem(), source = "os.freemem";
  if (process.platform === "linux") {
    const m = readMemInfo(); if (m) { total = m.total || total; free = m.free; source = m.source; }
  } else if (process.platform === "darwin") {
    const f = await darwinAvailableMem(); if (f != null) { free = Math.min(f, total); source = "vm_stat"; }
  }
  free = Math.max(0, Math.min(free, total));
  const used = total - free;
  return { total, free, used, percent: +((used / total) * 100).toFixed(1), source };
}
async function getMetrics() {
  const disk = await getDisk();
  const mem = await getMem();
  return {
    cpu: +cpuCurrent.toFixed(1),
    mem,
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
// 对局日志轮转：超过 5MB 时只保留最后 2 万行，防止长期运行把磁盘写满
const GAMES_LOG_MAX = 5 * 1024 * 1024;
const GAMES_LOG_KEEP = 20000;
let gamesRotating = false;
function rotateGamesLog() {
  if (gamesRotating) return;
  try {
    if (!fs.existsSync(GAMES_LOG)) return;
    if (fs.statSync(GAMES_LOG).size <= GAMES_LOG_MAX) return;
    gamesRotating = true;
    const raw = fs.readFileSync(GAMES_LOG, "utf8");
    const lines = raw.split("\n").filter(Boolean).slice(-GAMES_LOG_KEEP);
    const tmp = GAMES_LOG + ".tmp";
    fs.writeFileSync(tmp, lines.length ? lines.join("\n") + "\n" : "", { mode: 0o600 });
    fs.renameSync(tmp, GAMES_LOG);
  } catch (e) {
    // 轮转失败不影响主流程；下次定时再试
  } finally {
    gamesRotating = false;
  }
}
setInterval(rotateGamesLog, 10 * 60 * 1000).unref();
rotateGamesLog();
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
    const raw = part.slice(i + 1).trim();
    // 畸形百分号编码（如 "%"）会让 decodeURIComponent 抛错 → 未捕获异常拖垮服务
    let val = raw;
    try { val = decodeURIComponent(raw); } catch { val = raw; }
    out[part.slice(0, i).trim()] = val;
  }
  return out;
}
function json(res, code, obj, extraHeaders) {
  res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=utf-8" }, extraHeaders || {}));
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = "", done = false;
    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onError);
    };
    const settle = (v) => { if (done) return; done = true; cleanup(); resolve(v); };
    const onData = c => {
      d += c;
      if (d.length > 1e6) { req.destroy(); settle({}); }   // 超限：销毁连接并让 promise 立即落地，调用方校验失败→4xx
    };
    const onEnd = () => { try { settle(JSON.parse(d || "{}")); } catch { settle({}); } };
    const onError = () => settle({});
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onError);
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
/* ---------- 路由模块（原 handleApi 的 if 链按域拆到 routes/ 下） ----------
 * 拆分原则：每个模块只处理自己域的路径；各域路径互不重叠（已用 32 条路由的匿名矩阵核对），
 * 因此模块之间的顺序不影响行为，这里仍保持拆分前的先后顺序，便于逐行对照。 */
const routeAuth = require("./routes/auth");
const routeLiterature = require("./routes/literature");
const routeTactics = require("./routes/tactics");
const routeRating = require("./routes/rating");
const routeEngagement = require("./routes/engagement");
const routeLibrary = require("./routes/library");
const routeTrainer = require("./routes/trainer");
const routeAdmin = require("./routes/admin");
const routeFriends = require("./routes/friends");
const routeRooms = require("./routes/rooms");
const routeFun = require("./routes/fun");
const PUBLIC_ROUTES = [routeAuth, routeFun, routeRooms, routeTactics, routeRating, routeEngagement, routeLibrary, routeLiterature];
const AUTHED_ROUTES = [routeAuth, routeEngagement, routeLibrary, routeLiterature, routeTrainer, routeTactics, routeRating, routeFriends, routeAdmin];

async function handleApi(req, res, u) {
  const p = u.pathname;
  const m = req.method;

  // 已响应判定：json() 会立即 writeHead，因此这两个标志任一为真即视为该请求已被处理
  const responded = () => res.writableEnded || res.headersSent;
  const baseCtx = {
    req, res, p, m, u,
    uuid, loadAccounts, loadFriends, saveFriends, isFriend, friendUser, friendRelation,
    ALL_ROLES,
    CHESS_RATING_MAX,
    CHESS_RATING_MIN,
    CHESS_RATING_START,
    CHESS_RATING_TIERS,
    CHESS_TIER_KEYS,
    RE_USERNAME,
    TACTICS_LEVELS_PER_TIER,
    TACTICS_TIERS,
    TACTICS_TIER_DEFS,
    TACTICS_TITLES,
    addLibraryComment,
    applyTacticsAttempt,
    chessLeaderboard,
    chinaDay,
    claimDailyQuest,
    clearLoginFail,
    clientIp,
    collectLibraryEntry,
    controlEngine: (...a) => controlEngine(...a),
    cookieFlags,
    createLibraryEntry,
    createSession,
    currentTacticsPuzzle,
    deleteLibraryComment,
    deleteLibraryEntry,
    engagementLeaderboard,
    engineStatus: (...a) => engineStatus(...a),
    engineMove: (...a) => engineMoveFn(...a),
    findLibraryEntry,
    findUser,
    finishChessRatingGame,
    getAccounts,
    getChessRating,
    getConfig,
    getCurrentToken,
    getGamesStats: (...a) => getGamesStats(...a),
    getMetrics: (...a) => getMetrics(...a),
    getSession,
    getTactics,
    hasPerm,
    hashPassword,
    json,
    libraryList,
    libraryMine,
    libraryPublicEntry,
    listSessionsFor,
    litAccess,
    litComment,
    litDecideAccess,
    litDeleteComment,
    litGatedMeta,
    litKnown,
    litNotifications,
    litPublic,
    litRequestAccess,
    litToggleLike,
    loadLibrary,
    loadLit,
    loadLitContent,
    loadSessions,
    loginAllowed,
    logoutAllFor,
    logoutOthers,
    normalizeDayFlags,
    normalizeUser,
    noteLoginFail,
    publicChessRating,
    publicEngagement,
    publicPuzzle,
    publicTactics,
    rateCheck,
    readBody,
    registerLibraryView,
    saveAccounts,
    saveConfig,
    saveSessions,
    saveUserTactics,
    startChessRatingGame,
    startTacticsAttempt,
    toggleLibraryStar,
    trainerImport,
    trainerLines,
    trainerRemove,
    trainerSession,
    validPassword,
    verifyPassword,
  };

  // ===================== 公开接口（无需登录）=====================
  
  // 公开公告
  if (p === "/api/announcement" && m === "GET")
    return json(res, 200, getConfig().announcement || { text: "", enabled: false });
  for (const mod of PUBLIC_ROUTES) {
    if (!mod.public) continue;
    await mod.public(baseCtx);
    if (responded()) return;
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
  const authedCtx = Object.assign({}, baseCtx, { s });
  for (const mod of AUTHED_ROUTES) {
    if (!mod.authed) continue;
    await mod.authed(authedCtx);
    if (responded()) return;
  }

  return json(res, 404, { error: "not found" });
}

// ---------- 请求入口 ----------
function handleRequest(req, res) {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  if (p.startsWith("/api/")) {
    handleApi(req, res, u).catch(e => {
      console.error("[API 500]", e && e.stack || e);
      if (!res.headersSent) json(res, 500, { error: "server error" });
    });
    return true;
  }
  if (p.startsWith("/admin/")) {
    // 归一化末尾：/admin/、/admin/.、/admin// 一律视为「未指定文件」→ 登录页，
    // 避免同一入口出现 200 / 302 / 401 三种状态码（原先 /admin// 会掉到 401）
    let rel = p.slice("/admin/".length).replace(/^[./]+/, "");
    if (!rel) rel = "login.html";
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
  if (opts.engineMove) engineMoveFn = opts.engineMove;
  return { handleRequest, logGame };
}

module.exports = { init, handleRequest, logGame, getSession, getAccounts };
