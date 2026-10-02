#!/usr/bin/env node
/**
 * S.T.A.R. 接口冒烟测试 / 行为快照
 *
 * 用法：
 *   node tests/api_smoke.mjs --base http://127.0.0.1:8801            # 跑一遍，打印结果
 *   node tests/api_smoke.mjs --base http://127.0.0.1:8801 --save a.json   # 存快照
 *   node tests/api_smoke.mjs --base http://127.0.0.1:8801 --diff a.json  # 与快照对比（回归检查）
 *
 * 设计：只断言「状态码 + 响应形态」，不断言具体数值（账号/时间相关会变），
 * 因此重构前后对比时能抓出行为差异，而不会被动态数据干扰。
 */
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BASE = get("--base", "http://127.0.0.1:8801");
const SAVE = get("--save", null);
const DIFF = get("--diff", null);
const fs = await import("node:fs");
const PW = "smokePass12345";
const U = "smoke_" + Math.random().toString(36).slice(2, 7);
let cookie = "";

const call = async (path, method = "GET", body) => {
  const res = await fetch(BASE + path, {
    method, redirect: "manual",
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(e => ({ status: 0, headers: new Map(), text: async () => "NETERR" }));
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map(c => c.split(";")[0]).join("; ");
  let t = ""; try { t = await res.text(); } catch {}
  // 形态签名：把动态值（数字/时间/uuid）归一化，只保留结构
  const shape = t
    .replace(/"username":"[^"]*"/g, '"username":"<user>"')       // 随机账号名 → 归一化
    .replace(/"id":"[0-9a-f]{8}"/g, '"id":"<sid>"')              // 会话 id（8 位十六进制）
    .replace(/"[A-Za-z0-9_-]{16,}"/g, '"<id>"')
    .replace(/\d{10,}/g, "<num>")
    .replace(/"(likes|liked|count|pendingCount)":\s*\d+/g, '"$1":<n>')
    .slice(0, 180);
  return { status: res.status, shape };
};

const ROUTES = [
  "/api/announcement", "/api/tactics/config", "/api/chess-rating/leaderboard", "/api/chess-rating/config",
  "/api/chess-rating/me", "/api/engagement/leaderboard", "/api/library/entries", "/api/literature",
  "/api/literature/bach/text", "/api/literature/zzz/text", "/api/literature/bach/access/request",
  "/api/me", "/api/me/sessions", "/api/engagement/me", "/api/library/me", "/api/trainer/lines",
  "/api/tactics/progress", "/api/tactics/current", "/api/notifications", "/api/admin/metrics",
  "/api/admin/games", "/api/admin/engines", "/api/admin/accounts", "/api/admin/announcement",
  "/api/login", "/api/register", "/api/logout", "/api/notfound",
];

const results = {};
const rec = (key, r) => { results[key] = { status: r.status, shape: r.shape }; };

console.log(`== 匿名阶段 (${BASE}) ==`);
for (const r of ROUTES) {
  const g = await call(r, "GET"); rec("GET " + r, g);
  const p = await call(r, "POST"); rec("POST " + r, p);
  console.log(`  ${r.padEnd(34)} GET:${String(g.status).padEnd(4)} POST:${p.status}`);
}

console.log("== 登录阶段 ==");
const ops = [
  ["注册", () => call("/api/register", "POST", { username: U, password: PW })],
  ["登录", () => call("/api/login", "POST", { username: U, password: PW })],
  ["我的资料", () => call("/api/me")],
  ["会话列表", () => call("/api/me/sessions")],
  ["每日任务", () => call("/api/engagement/me")],
  ["棋谱库(我)", () => call("/api/library/me")],
  ["训练线路", () => call("/api/trainer/lines")],
  ["题型进度", () => call("/api/tactics/progress")],
  ["当前题型", () => call("/api/tactics/current")],
  ["题型配置", () => call("/api/tactics/config")],
  ["棋力配置", () => call("/api/chess-rating/config")],
  ["棋力(我)", () => call("/api/chess-rating/me")],
  ["文学列表", () => call("/api/literature")],
  ["文学正文(未授权)", () => call("/api/literature/bach/text")],
  ["点赞 bach", () => call("/api/literature/bach/like", "POST")],
  ["评论 bach(未授权)", () => call("/api/literature/bach/comment", "POST", { text: "smoke" })],
  ["申请授权", () => call("/api/literature/bach/access/request", "POST")],
  ["通知", () => call("/api/notifications")],
  ["脏 key 点赞", () => call("/api/literature/zzz/like", "POST")],
  ["取消点赞", () => call("/api/literature/bach/like", "POST")],
  ["登出", () => call("/api/logout", "POST")],
];
for (const [name, fn] of ops) {
  const r = await fn();
  rec("AUTH " + name, r);
  console.log(`  ${name.padEnd(20)} ${String(r.status).padEnd(5)} ${r.shape.slice(0, 70)}`);
}

if (SAVE) { fs.writeFileSync(SAVE, JSON.stringify(results, null, 1)); console.log("\n✓ 快照已保存: " + SAVE); }
if (DIFF) {
  const base = JSON.parse(fs.readFileSync(DIFF, "utf8"));
  const keys = [...new Set([...Object.keys(base), ...Object.keys(results)])];
  const diff = keys.filter(k => !base[k] || !results[k] || base[k].status !== results[k].status || base[k].shape !== results[k].shape);
  console.log(`\n== 与快照对比：共 ${keys.length} 项，差异 ${diff.length} 项 ==`);
  for (const k of diff) console.log(`  ✗ ${k}\n      基线: ${JSON.stringify(base[k])}\n      现在: ${JSON.stringify(results[k])}`);
  if (!diff.length) console.log("  ✓ 完全一致（状态码与响应形态）");
  process.exitCode = diff.length ? 1 : 0;
}
console.log("测试账号: " + U);
