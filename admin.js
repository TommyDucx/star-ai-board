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
function normalizeTactics(raw) {
  const prog = raw && typeof raw === "object" ? raw : {};
  const out = {
    schemaVersion: 2,
    selectedTier: TACTICS_TIERS.includes(prog.selectedTier) ? prog.selectedTier : "beginner",
    tiers: {},
    titles: {},
    stats: {},
    attempts: (prog.attempts && typeof prog.attempts === "object" && !Array.isArray(prog.attempts)) ? prog.attempts : {},
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
  saveUserTactics(userId, prog);
  return { prog, newly, attempt };
}
function applyTacticsResult(userId, tier, solved) {
  const started = startTacticsAttempt(userId, tier);
  if (started.error) return { prog: started.prog, newly: [] };
  return applyTacticsAttempt(userId, { attemptId: started.attempt.id, moves: solved ? (started.puzzle.moves || []) : [] });
}
function publicTactics(prog) {
  return {
    schemaVersion: 2,
    selectedTier: prog.selectedTier,
    tiers: prog.tiers, titles: prog.titles, stats: prog.stats, updatedAt: prog.updatedAt,
    levelsPerTier: TACTICS_LEVELS_PER_TIER,
    tiersDef: TACTICS_TIER_DEFS,
    titleDefs: TACTICS_TITLES,
  };
}

// ---------- 棋力评估（人机对战 Elo，按账号持久化，跨设备同步）----------
const CHESS_RATING_MIN = 600;
const CHESS_RATING_MAX = 2600;
const CHESS_RATING_START = 1200;
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
  return {
    rating: r.rating, bestRating: r.bestRating,
    games: r.games, wins: r.wins, draws: r.draws, losses: r.losses,
    currentStreak: r.currentStreak, bestStreak: r.bestStreak,
    lastGameAt: r.lastGameAt || null,
    recent: r.history.slice(-8).reverse(),
    tiers: CHESS_RATING_TIERS,
    limits: { min: CHESS_RATING_MIN, max: CHESS_RATING_MAX, start: CHESS_RATING_START },
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
  const result = ["win", "draw", "loss"].includes(body.result) ? body.result : null;
  if (!result) return { error: "对局结果无效" };
  const moves = clamp(Math.round(+body.moves || 0), 0, 300);
  if (moves < 8 && result === "draw") return { error: "有效手数不足，无法结算测评" };
  const metrics = body.metrics && typeof body.metrics === "object" ? body.metrics : {};
  const before = prog.rating;
  const delta = calcChessDelta(before, active.engineElo, result, metrics);
  const after = clamp(before + delta, CHESS_RATING_MIN, CHESS_RATING_MAX);
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
    before, after, delta, moves,
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

  // 题型配置公开；账号进度仍需登录后按 userId 拉取
  if (p === "/api/tactics/config" && m === "GET") {
    return json(res, 200, {
      tiers: TACTICS_TIER_DEFS.map(t => Object.assign({ levels: TACTICS_LEVELS_PER_TIER }, t)),
      levelsPerTier: TACTICS_LEVELS_PER_TIER,
      titleDefs: TACTICS_TITLES,
    });
  }

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

  // 题型闯关进度（账号持久化，跨设备同步）
  if (p === "/api/tactics/progress" && m === "GET") {
    return json(res, 200, { progress: publicTactics(getTactics(s.userId)) });
  }
  if ((p === "/api/tactics/select-tier" || p === "/api/tactics/current") && (m === "POST" || m === "GET")) {
    const body = m === "POST" ? await readBody(req) : {};
    const tier = body.tier || u.searchParams.get("tier") || getTactics(s.userId).selectedTier || "beginner";
    if (!TACTICS_TIERS.includes(tier)) return json(res, 400, { error: "难度档无效" });
    const prog = getTactics(s.userId);
    prog.selectedTier = tier;
    saveUserTactics(s.userId, prog);
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
  if (p === "/api/tactics/result" && m === "POST") {
    const body = await readBody(req);
    const tier = body.tier;
    if (!TACTICS_TIERS.includes(tier)) return json(res, 400, { error: "难度档无效" });
    if (typeof body.solved !== "boolean") return json(res, 400, { error: "缺少判定结果" });
    const { prog, newly } = applyTacticsResult(s.userId, tier, body.solved);
    return json(res, 200, { progress: publicTactics(prog), newly });
  }

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

module.exports = { init, handleRequest, logGame, getSession, getAccounts };
