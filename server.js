// =============================================================================
// S.T.A.R. 双引擎 AI 推荐服务
//   - 静态托管 public/（围棋页 / 国际象棋页 / 主页）
//   - WebSocket 桥接：
//       国际象棋 → 本地 Stockfish（UCI 协议）
//       围棋     → 本地 KataGo（line-delimited JSON analysis 协议）
// 启动：npm install && node server.js   →  http://localhost:8765
// =============================================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const admin = require("./admin");

const PORT = process.env.PORT || 8765;
const PUBLIC_DIR = path.join(__dirname, "public");
const STOCKFISH = path.join(__dirname, "public", "stockfish");
const RECKLESS = path.join(__dirname, "public", "reckless");
const MY_ENGINE = path.join(__dirname, "my-engine", "handcrafted", "target", "release", "my-engine");
const MY_ENGINE_NNUE = path.join(__dirname, "my-engine", "nnue", "target", "release", "my-engine-nnue");
const ENGINES_DIR = path.join(__dirname, "public", "engines");

// 引擎表：key → 二进制路径（含提示/能力标记）
// ⚠️ 顺序即前端引擎下拉顺序：BiaoZi 两个自研引擎置顶
const ENGINES = {
  "my-engine":{ path: MY_ENGINE, elo: false },  // BiaoZi 手写 eval 路线（v2_smp，Policy 引导搜索）
  "my-engine-nnue": {
    path: MY_ENGINE_NNUE, elo: false,           // BiaoZi NNUE 增量路线（Eval=nnue，增量累加器）
    options: [{ name: "Eval", value: "nnue" }],
  },
  stockfish:  { path: STOCKFISH, elo: true },   // 支持 UCI_LimitStrength/UCI_Elo
  reckless:   { path: RECKLESS, elo: false },   // 不支持 Elo option（自带棋力）
  // ── CCRL 顶级引擎（2026 排名，public/engines/ 下有二进制即自动可用）──
  plentychess: { path: path.join(ENGINES_DIR, "plentychess"), elo: false },  // CCRL #3
  alexandria:  { path: path.join(ENGINES_DIR, "alexandria"),  elo: false },  // CCRL #6
  viridithas:  { path: path.join(ENGINES_DIR, "viridithas"),  elo: false },  // CCRL #7
  quanticade:  { path: path.join(ENGINES_DIR, "quanticade"),  elo: false },  // CCRL #9
  halogen:     { path: path.join(ENGINES_DIR, "halogen"),     elo: false },  // CCRL #11
  clover:      { path: path.join(ENGINES_DIR, "clover"),      elo: false },  // CCRL #13
  berserk:     { path: path.join(ENGINES_DIR, "berserk"),     elo: false },  // CCRL #14
  ethereal:    { path: path.join(ENGINES_DIR, "ethereal"),    elo: false },  // CCRL #26（无 NNUE 降级版）
};
// 启动时检测引擎二进制是否存在（前端据此只显示可用引擎）
Object.entries(ENGINES).forEach(([k, cfg]) => {
  cfg.available = fs.existsSync(cfg.path);
});

// ---- 围棋引擎配置（多引擎）----
const KATAGO = process.env.KATAGO || "/usr/local/bin/katago";
const GO_MODELS_DIR = process.env.GO_MODELS_DIR || path.join(__dirname, "models");
const GO_TMP = path.join(os.tmpdir(), "star-go");

function whichPath(bin) {
  const cands = [bin];
  for (const d of ["/usr/local/bin", "/usr/bin", "/usr/local/games", "/usr/games",
                   path.join(__dirname, "engines", "go")]) {
    cands.push(path.join(d, bin));
  }
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}
function findGoScript(name) {
  for (const d of [path.join(__dirname, "engines", "go"), "/usr/local/share/michi", "/opt/michi"]) {
    const p = path.join(d, name);
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

function goKataLabel(tag) {
  const map = {
    "b10c128": "KataGo b10c128（快速·默认）",
    "b10c384h6nbttflrs": "KataGo b10c384（新架构·快）",
    "b15c192": "KataGo b15c192（快）",
    "b18c384nbt": "KataGo b18c384（强）",
    "b20c256": "KataGo b20c256（强）",
    "b40c256x2": "KataGo b40c256（最强·慢）",
    "b18c384nbt-humanv0": "KataGo b18 人类棋风",
    "b18c384nbt-optimisticv13-s5971M": "KataGo b18 乐观版",
    "b18c384nbt-uec": "KataGo b18 UEC 冠军",
    "kata9x9-b18c384nbt-20231025": "KataGo 9×9 专用",
    "b10c512h8nbt3tflrs-fson-silu-rsnh": "KataGo b10c512（新架构·强）",
    "b11c768h12nbt3tflrs-fson-silu": "KataGo b11c768（超大·慢）",
    "g170-b30c320x2-s4824661760-d1229536699": "KataGo g170-b30（强）",
    "g170-b40c256x2-s5095420928-d1229425124": "KataGo g170-b40（最强·慢）",
    "g170e-b20c256x2-s5303129600-d1228401921": "KataGo g170e-b20",
  };
  return map[tag] || "KataGo " + tag;
}

// 下拉速度序（越靠前越快，作为默认优先）
const KATA_SPEED_ORDER = [
  "g170e-b10c128", "b10c384h6nbttflrs", "g170e-b20c256x2-s5303129600-d1228401921",
  "b18c384nbt-humanv0", "b18c384nbt-uec", "b18c384nbt-optimisticv13-s5971M",
  "b10c512h8nbt3tflrs-fson-silu-rsnh", "g170-b30c320x2-s4824661760-d1229536699",
  "g170-b40c256x2-s5095420928-d1229425124", "kata9x9-b18c384nbt-20231025",
  "b11c768h12nbt3tflrs-fson-silu",
];

// 围棋引擎注册表：type=kata（analysis JSON）/ gtp（标准 GTP）
function discoverGoEngines() {
  const out = {};
  const katas = [];
  try {
    for (const f of fs.readdirSync(GO_MODELS_DIR)) {
      const m = /^katago-(.+)\.(bin\.gz|txt\.gz)$/.exec(f);
      if (m) {
        const tag = m[1];
        const key = "katago-" + tag;
        katas.push(key);
        out[key] = {
          type: "kata", label: goKataLabel(tag),
          binary: KATAGO, model: path.join(GO_MODELS_DIR, f),
        };
      }
    }
  } catch (e) { /* models dir 不存在 */ }
  // 按速度序重建插入顺序（前端默认第一个）
  const order = (a) => {
    const t = a.replace("katago-", "");
    const i = KATA_SPEED_ORDER.indexOf(t);
    return i >= 0 ? i : KATA_SPEED_ORDER.length;
  };
  const sorted = [...katas].sort((a, b) => order(a) - order(b));
  const ordered = {};
  for (const k of sorted) ordered[k] = out[k];
  for (const k of Object.keys(out)) if (!ordered[k]) ordered[k] = out[k];
  // GTP 引擎（探测二进制；脚本类走 python）
  const gtpDefs = [
    { key: "gnugo", label: "GNU Go（经典棋风）", cmd: whichPath("gnugo"), args: ["--mode", "gtp", "--level", "10"], scoreCmd: "estimate_score" },
    { key: "pachi", label: "Pachi（MCTS）", cmd: whichPath("pachi"), args: [], scoreCmd: null },
    { key: "fuego", label: "Fuego（UCT）", cmd: whichPath("fuego"), args: ["--quiet"], scoreCmd: "estimate_score" },
    { key: "michi", label: "Michi（神经 MCTS）", cmd: findGoScript("michi.py") ? "python3" : null, script: findGoScript("michi.py"), args: [], scoreCmd: null },
    { key: "mogo", label: "MoGo（老牌 MCTS）", cmd: whichPath("mogo"), args: [], scoreCmd: null },
  ];
  for (const g of gtpDefs) {
    if (!g.cmd) continue;
    const args = g.script ? [g.script].concat(g.args) : g.args;
    ordered[g.key] = { type: "gtp", ...g, cmd: g.cmd, args };
    delete ordered[g.key].script;
  }
  return ordered;
}
const GO_ENGINES = discoverGoEngines();
const GO_KEYS = Object.keys(GO_ENGINES);
const GO_DEFAULT = GO_KEYS.find(k => k.startsWith("katago-")) || GO_KEYS[0] || null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".gz": "application/gzip",
};

// 输入校验工具：所有客户端参数在进入引擎 stdin 前必须过这里（防 UCI/GTP 换行注入与类型滥用）
function cleanStr(v, maxLen) {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  return s.length && s.length <= maxLen ? s : null;
}
const FEN_RE = /^[rnbqkpRNBQKP1-8/]+\s[bw]\s(-|[KQkqA-Ha-h1-8]+|-)\s(-|[a-h][36]|-)\s\d+\s\d+$/;
function validFen(v) {
  const s = cleanStr(v, 100);
  return s && FEN_RE.test(s) ? s : null;
}
function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

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

const server = http.createServer((req, res) => {
  try {
    if (admin.handleRequest(req, res)) return;
    const qIdx = req.url.indexOf("?");
    const query = qIdx >= 0 ? req.url.slice(qIdx + 1) : "";
    // 畸形百分号编码（如 /%）会抛 URIError；未捕获会让整个进程崩溃 → 返回 400
    let urlPath;
    try {
      urlPath = decodeURIComponent(qIdx >= 0 ? req.url.slice(0, qIdx) : req.url);
    } catch {
      res.writeHead(400); return res.end("Bad Request");
    }
    // 空字节（/%00）会让 fs.readFile 同步抛 ERR_INVALID_ARG_VALUE
    if (urlPath.includes("\0")) { res.writeHead(400); return res.end("Bad Request"); }
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
    // 必须仍在 public 目录内（加 path.sep 防止同名前缀目录绕过 startsWith）
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end("Forbidden"); }
    fs.readFile(filePath, (err, data) => {
      try {
        if (err) { res.writeHead(404); return res.end("Not Found"); }
        const ext = path.extname(filePath);
        const type = MIME[ext] || "application/octet-stream";
        // 缓存分级：带 ?v=N 指纹的非 HTML 资源可永久强缓存（内容变更必换 N）；
        // HTML / CSS / JS 未带版本号时保持 no-cache（改版即时生效）；其余资源 7 天。
        const hasV = new URLSearchParams(query).has("v");
        const cacheControl = (hasV && ext !== ".html")
          ? "public, max-age=31536000, immutable"
          : ((ext === ".html" || ext === ".css" || ext === ".js") ? "no-cache" : "public, max-age=604800");
        const headers = {
          "Content-Type": type,
          "Cache-Control": cacheControl,
          // 基础安全头：防 MIME 嗅探 / 防被第三方 iframe 嵌套 / 限制 referrer 泄漏
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "SAMEORIGIN",
          "Referrer-Policy": "strict-origin-when-cross-origin",
        };
        // 文本类资源 gzip（>1KB 才值得压缩）
        const accept = req.headers["accept-encoding"] || "";
        if (/^text\/|application\/json/.test(type) && data.length > 1024 && /\bgzip\b/.test(accept)) {
          headers["Content-Encoding"] = "gzip";
          headers["Vary"] = "Accept-Encoding";
          res.writeHead(200, headers);
          return res.end(zlib.gzipSync(data));
        }
        res.writeHead(200, headers);
        res.end(data);
      } catch (e) {
        // 读文件回调内的意外异常不能外泄（回调在事件循环里，外层 try 捕不到）
        try { if (!res.headersSent) { res.writeHead(500); res.end("Internal Server Error"); } } catch (_) {}
      }
    });
  } catch (e) {
    try { if (!res.headersSent) { res.writeHead(400); res.end("Bad Request"); } } catch (_) {}
  }
});

/* ===================== 国际象棋：UCI 引擎（Stockfish / Reckless） ===================== */
class ChessEngine {
  constructor(enginePath, options = []) {
    this.path = enginePath;
    this.options = options;
    this.proc = null;
    this.buf = "";
    this.waiters = [];
    this.queue = Promise.resolve();
    this._uci = false;
    this.lastUse = Date.now();
  }
  _ensureAlive() {
    if (!this.proc || this.proc.exitCode !== null) {
      // cwd 设为引擎所在目录：自研引擎据此定位同目录的 policy.bin（策略模型）
      // stderr 也接管：自研引擎（BiaoZi）的 info 行走 stderr，不读就解析不到评估分数
      this.proc = spawn(this.path, [], { stdio: ["pipe", "pipe", "pipe"], cwd: path.dirname(this.path) });
      this.buf = "";
      this.errBuf = "";
      this.errLines = [];
      this._uci = false;
      this.proc.stdout.setEncoding("utf8");
      this.proc.stdout.on("data", d => this._onData(d));
      this.proc.stderr.setEncoding("utf8");
      this.proc.stderr.on("data", d => {
        this.errBuf += d;
        let i;
        while ((i = this.errBuf.indexOf("\n")) >= 0) {
          const l = this.errBuf.slice(0, i).trim();
          this.errBuf = this.errBuf.slice(i + 1);
          if (l) this.errLines.push(l);
        }
      });
      this.proc.on("exit", () => { this.proc = null; });
    }
  }
  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      for (const w of [...this.waiters]) {
        w.lines.push(line);
        if (w.match(line)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(w.lines);
        }
      }
    }
  }
  // 等待引擎输出行；必须带超时——否则一条畸形请求（如 position fen undefined 永远等不到
  // bestmove）会把该引擎的串行队列永久卡死，所有用户全部无响应（实测踩过的坑）
  _waitFor(pred, timeoutMs, what) {
    return new Promise((res, rej) => {
      const w = { match: pred, resolve: res, lines: [] };
      this.waiters.push(w);
      if (!timeoutMs) return;
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        rej(new Error(what + " 超时"));
      }, timeoutMs);
      const orig = w.resolve;
      w.resolve = lines => { clearTimeout(t); orig(lines); };
    });
  }
  _send(cmd) { this.proc.stdin.write(cmd + "\n"); }
  run(fn) {
    this._ensureAlive();
    this.lastUse = Date.now();
    const p = this.queue.then(() => fn());
    this.queue = p.catch(() => {});
    return p;
  }
  // 空闲回收：UCI 引擎常驻内存可观（stockfish ~250MB），闲置太久发 quit 并兜底 kill。
  // 只在 lastUse 距今超过阈值时被定时器调用，不存在搜索中途被杀的窗口。
  stop() {
    if (!this.proc) return;
    const p = this.proc;
    try { p.stdin.write("quit\n"); } catch (e) {}
    setTimeout(() => { try { p.kill(); } catch (e) {} }, 1500);
    this.proc = null;
    this._uci = false;
    // 引擎被停时清理残留 waiter：避免 stop 后旧请求的 Promise 永远挂死，
    // 之前代码只清 proc/waiters 仍可能让 timeout 触发后访问空 proc 抛异常
    const stale = this.waiters;
    this.waiters = [];
    this.buf = "";
    for (const w of stale) {
      try {
        if (typeof w.resolve === "function") w.resolve([]);
      } catch (e) {}
    }
  }
  async init() {
    if (!this._uci) {
      const uci = this._waitFor(l => l === "uciok", 10000, "uci 握手");
      this._send("uci");
      await uci;
      this._uci = true;
      // 引擎级 UCI 选项（如 NNUE 引擎的 Eval=nnue）
      for (const o of this.options) {
        this._send(`setoption name ${o.name} value ${o.value}`);
      }
    }
    const ready = this._waitFor(l => l === "readyok", 10000, "isready");
    this._send("isready");
    await ready;
  }
  // 计算最佳走法；同时返回 Top 走法候选（供"推荐下一步"展示）
  async bestMove(fen, { elo = null, movetime = 800, multipv = 3, supportsElo = true } = {}) {
    return this.run(async () => {
      await this.init();
      if (supportsElo && elo) {
        this._send("setoption name UCI_LimitStrength value true");
        this._send(`setoption name UCI_Elo value ${elo}`);
      } else if (supportsElo) {
        this._send("setoption name UCI_LimitStrength value false");
      }
      this._send(`setoption name MultiPV value ${multipv}`);
      this._send(`position fen ${fen}`);
      const done = this._waitFor(l => l.startsWith("bestmove"), movetime + 15000, "bestmove");
      this.errLines = [];   // 本轮搜索前清空 stderr 收集（自研引擎 info 在 stderr）
      this._send(`go movetime ${movetime}`);
      const lines = await done;
      // 合并 stderr 的 info 行（BiaoZi 自研引擎 info 走 stderr）：稍等残留输出
      await new Promise(r => setTimeout(r, 30));
      const allLines = [...lines, ...this.errLines.filter(l => l.startsWith("info"))];
      const bestmove = (allLines.find(l => l.startsWith("bestmove")) || "").split(/\s+/)[1] || null;
      // 解析多条 PV（MultiPV）：score + 走法
      const candidates = [];
      let cur = null;
      for (const l of allLines) {
        if (l.startsWith("info") && l.includes("multipv")) {
          const pvN = +(l.match(/multipv (\d+)/) || [])[1] || 0;
          const s = l.match(/score cp (-?\d+)/);
          const m = l.match(/score mate (-?\d+)/);
          const pv = (l.match(/ pv (.+)$/) || [])[1] || "";
          cur = { pv: pv.split(/\s+/).slice(0, 4), depth: +(l.match(/depth (\d+)/) || [])[1] || 0, evalCp: null, mate: null };
          if (s) { cur.evalCp = +s[1]; cur.mate = null; }
          if (m) { cur.mate = +m[1]; cur.evalCp = null; }
          candidates[pvN - 1] = cur;
        }
      }
      // 无 multipv 的引擎（自研 my-engine）降级解析 info/pv（取最后一个=最深层）
      if (!candidates.filter(Boolean).length) {
        let l = null;
        for (const x of allLines) {
          if (x.startsWith("info") && x.includes(" pv ")) l = x;
        }
        if (l) {
          const s = l.match(/score cp (-?\d+)/);
          const m = l.match(/score mate (-?\d+)/);
          const pv = (l.match(/ pv (.+)$/) || [])[1] || "";
          cur = { pv: pv.split(/\s+/).slice(0, 4), depth: +(l.match(/depth (\d+)/) || [])[1] || 0, evalCp: null, mate: null };
          if (s) { cur.evalCp = +s[1]; }
          if (m) { cur.mate = +m[1]; }
          candidates.push(cur);
        }
      }
      return { bestmove, candidates: candidates.filter(Boolean) };
    });
  }
}

/* ===================== 围棋：KataGo (analysis JSON) + GTP 引擎 ===================== */
function writeGoConfig(backend, logDir) {
  const cfg = path.join(GO_TMP, `analysis-${backend}.cfg`);
  const body = [
    `logDir = ${logDir}`,
    "logAllRequests = false", "logAllResponses = false", "logSearchInfo = false", "logToStderr = false",
    "numAnalysisThreads = 1", "numSearchThreads = 2",
    "nnMaxBatchSize = 4", "nnCacheSizePowerOfTwo = 19", "nnMutexPoolSizePowerOfTwo = 15",
    `nnBackend = ${backend}`, "openclUseAllDevices = false",
    "reportAnalysisWinratesAs = SIDETOMOVE",
    "analysisPVLen = 10", "rootSymmetryPruning = true",
  ].join("\n");
  fs.mkdirSync(GO_TMP, { recursive: true });
  fs.writeFileSync(cfg, body);
  return cfg;
}

class KataGoEngine {
  constructor(cfg) {
    this.cfg = cfg;
    this.proc = null;
    this.buf = "";
    this.pending = new Map();
    this.counter = 0;
    this.dead = false;
    this.backend = "";
    this.startLock = null;   // 并发 start 共享同一 Promise，避免两次重建互杀（goAnalyze / setInterval 都会触发）
  }
  async start() {
    if (this.startLock) return this.startLock;
    this.startLock = (async () => {
      try {
        fs.mkdirSync(path.join(GO_TMP, "logs"), { recursive: true });
        let lastErr = "";
        for (const [backend, timeout] of [["eigen", 120], ["opencl", 120]]) {
          try {
            await this._spawnAndReady(backend, timeout);
            this.backend = backend;
            return;
          } catch (e) { lastErr = String(e); this._kill(); }
        }
        throw new Error("KataGo 启动失败: " + lastErr);
      } finally {
        this.startLock = null;
      }
    })();
    return this.startLock;
  }
  _spawnAndReady(backend, timeout) {
    return new Promise((resolve, reject) => {
      const cfg = writeGoConfig(backend, path.join(GO_TMP, "logs"));
      this.proc = spawn(this.cfg.binary, ["analysis", "-model", this.cfg.model, "-config", cfg], { stdio: ["pipe", "pipe", "pipe"] });
      this.buf = "";
      this.proc.stdout.setEncoding("utf8");
      this.proc.stdout.on("data", d => this._onData(d));
      let errBuf = "";
      let settled = false;
      const fail = (msg) => { if (!settled) { settled = true; reject(new Error(msg)); } };
      this.proc.stderr.setEncoding("utf8");
      this.proc.stderr.on("data", d => {
        errBuf += d;
        if (errBuf.length > 60000) errBuf = errBuf.slice(-30000);
        if (/ready to begin|Started, ready/.test(errBuf) && !settled) {
          settled = true;
          resolve();
        }
      });
      this.proc.on("exit", () => { this.proc = null; fail("KataGo 进程退出: " + errBuf.slice(-400)); });
      setTimeout(() => fail("KataGo 启动超时: " + errBuf.slice(-400)), timeout * 1000);
    });
  }
  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        const slot = this.pending.get(m.id);
        if (slot) { this.pending.delete(m.id); slot(m); }
      } catch (e) { /* non-JSON line */ }
    }
  }
  _kill() {
    if (this.proc) { try { this.proc.stdin.end(); this.proc.kill(); } catch (e) {} this.proc = null; }
    this.dead = true;   // 回收即标记：避免复用空进程导致首次请求失败
  }
  analyze(stones, side, opts = {}) {
    return new Promise((resolve, reject) => {
      if (!this.proc) { this.dead = true; return reject(new Error("KataGo 未运行")); }
      const id = "g" + (++this.counter);
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("KataGo 超时")); }, opts.timeout || 120000);
      this.pending.set(id, m => { clearTimeout(timer); resolve(m); });
      const req = {
        id, moves: [],
        initialStones: stones.map(s => [s[0], s[1]]),
        initialPlayer: side,
        rules: "chinese", komi: opts.komi ?? 7.5,
        boardXSize: opts.boardSize || 19, boardYSize: opts.boardSize || 19,
        maxVisits: opts.maxVisits || 200,
        includeOwnership: false, includePolicy: false,
      };
      this.proc.stdin.write(JSON.stringify(req) + "\n");
    });
  }
  stop() { this._kill(); }
}

const GTP_LETTERS = "ABCDEFGHJKLMNOPQRST"; // GTP 列（无 I）
function gtpMoveToCoord(move, N) {
  if (!move || move === "pass" || move === "resign") return "pass";
  const col = GTP_LETTERS.indexOf(move[0]);
  const row = parseInt(move.slice(1), 10);
  if (col < 0 || isNaN(row)) return "pass";
  return move;
}

class GtpEngine {
  constructor(cfg) {
    this.cfg = cfg;
    this.proc = null;
    this.buf = "";
    this.readyQ = [];
    this.busy = false;
    this.dead = false;
    this.counter = 0;
    this.startLock = null;   // 并发 start 共享同一 Promise，避免两次握手互杀
  }
  async start() {
    if (this.startLock) return this.startLock;
    this.startLock = (async () => {
      const me = this;
      return new Promise((resolve, reject) => {
        this.proc = spawn(this.cfg.cmd, this.cfg.args || [], { stdio: ["pipe", "pipe", "pipe"] });
        this.buf = "";
        this.proc.stdout.setEncoding("utf8");
        this.proc.stdout.on("data", d => this._onData(d));
        let errBuf = "";
        this.proc.stderr.setEncoding("utf8");
        this.proc.stderr.on("data", d => errBuf += d);
        const fail = (m) => { this.dead = true; reject(new Error(m + " " + errBuf.slice(-200))); };
        this.proc.on("error", e => fail("GTP 启动失败: " + e.message));
        this.proc.on("exit", () => { this.proc = null; if (!this._ready) this.dead = true; });
        setTimeout(() => fail("GTP 启动超时: " + errBuf.slice(-200)), 15000);
        // 握手：protocol_version 应答 = x 即就绪
        this._cmdRaw("protocol_version").then(() => { this._ready = true; resolve(); }).catch(fail);
      });
    })();
    try { return await this.startLock; } finally { this.startLock = null; }
  }
  _onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (this.readyQ.length && this._lineComplete(line)) {
        const w = this.readyQ.shift();
        w(line);
      }
    }
  }
  _lineComplete(line) {
    const t = line.trim();
    return t === "" || t.startsWith("= ") || t.startsWith("? ") || t.startsWith("=") || t.startsWith("?");
  }
  _cmdRaw(cmd) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error("gtp not running"));
      const timer = setTimeout(() => { this.dead = true; reject(new Error("GTP 命令超时: " + cmd)); }, 60000);
      this.readyQ.push(line => {
        clearTimeout(timer);
        const t = line.trim();
        if (t.startsWith("?") && !t.startsWith("= ")) return reject(new Error("GTP 错误: " + t));
        resolve(t.replace(/^= ?/, ""));
      });
      this.proc.stdin.write(cmd + "\n");
    });
  }
  async cmd(cmd) {
    // 串行化命令
    const prev = this._chain || Promise.resolve();
    const run = prev.then(() => this._cmdRaw(cmd));
    this._chain = run.catch(() => {});
    return run;
  }
  async analyze(stones, side, opts = {}) {
    const N = opts.boardSize || 19;
    await this.cmd(`boardsize ${N}`);
    await this.cmd("clear_board");
    await this.cmd(`komi ${opts.komi ?? 7.5}`);
    for (const [color, mv] of stones) {
      await this.cmd(`play ${color} ${mv}`);
    }
    const mv = await this.cmd(`genmove ${side}`);
    let lead = null;
    if (this.cfg.scoreCmd) {
      try {
        const sc = await this.cmd(this.cfg.scoreCmd);
        lead = parseScore(sc);
      } catch (e) { /* 无分差 */ }
    }
    const move = gtpMoveToCoord(mv, N);
    // 由分差估算胜率（黑方视角 lead → 当前行棋方视角）
    let winrate = 0.5;
    if (lead != null) {
      const leadStm = side === "B" ? lead : -lead;
      winrate = 1 / (1 + Math.pow(10, -leadStm / 15));
      winrate = Math.min(0.99, Math.max(0.01, winrate));
    }
    return {
      moveInfos: [{ move, winrate, scoreLead: lead == null ? null : (side === "B" ? lead : -lead), visits: 1, order: 0, pv: [move] }],
      rootInfo: { winrate, scoreLead: lead == null ? null : (side === "B" ? lead : -lead) },
    };
  }
  stop() {
    if (this.proc) { try { this.proc.stdin.write("quit\n"); setTimeout(() => { try { this.proc.kill(); } catch (e) {} }, 500); } catch (e) {} this.proc = null; }
    this.dead = true;   // 已回收：下次请求走重建路径，而非复用死进程连环失败
  }
}

function parseScore(s) {
  // "B+12.5" / "W+3.5" / "-1.5"（黑负）→ 黑方视角目差
  const m = /([BW])\+([\d.]+)/.exec(s || "");
  if (m) return m[1] === "B" ? parseFloat(m[2]) : -parseFloat(m[2]);
  const n = parseFloat(s);
  if (!isNaN(n)) return n;
  return null;
}

// 引擎池：懒启动 + 空闲回收（4 核 pi 内存有限，不能同时驻留多个 KataGo）
const goPool = new Map();
const GO_IDLE_MS = 10 * 60 * 1000;
async function goAnalyze(engineKey, stones, side, opts) {
  const cfg = GO_ENGINES[engineKey];
  if (!cfg) throw new Error("未知围棋引擎: " + engineKey);
  let pool = goPool.get(engineKey);
  if (!pool || pool.eng.dead) {
    // 换模型前先回收其它驻留引擎——每个 KataGo 常驻 100~500MB，全留着切换几轮就能吃掉数 GB
    for (const [k, p] of goPool) {
      if (k !== engineKey) { try { p.eng.stop(); } catch (e) {} goPool.delete(k); }
    }
    const eng = cfg.type === "kata" ? new KataGoEngine(cfg) : new GtpEngine(cfg);
    pool = { eng, lastUse: Date.now() };
    goPool.set(engineKey, pool);
    await eng.start();
  }
  pool.lastUse = Date.now();
  return pool.eng.analyze(stones, side, opts);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, p] of goPool) {
    if (now - p.lastUse > GO_IDLE_MS) { try { p.eng.stop(); } catch (e) {} goPool.delete(k); }
  }
}, 60 * 1000);

/* ===================== 启动 + WebSocket ===================== */
const chessEngines = {};
Object.entries(ENGINES).forEach(([key, cfg]) => {
  chessEngines[key] = new ChessEngine(cfg.path, cfg.options || []);
});
// 国际象棋引擎空闲回收：12 个引擎全驻留可达数 GB（实测 stockfish 单个 ~250MB），必须定期清
const CHESS_IDLE_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, eng] of Object.entries(chessEngines)) {
    if (eng.proc && now - eng.lastUse > CHESS_IDLE_MS) eng.stop();
  }
}, 60 * 1000);
function engineFor(name) {
  const key = ENGINES[name] ? name : "stockfish";
  return { key, cfg: ENGINES[key], eng: chessEngines[key] };
}
const go = { available: GO_KEYS.length > 0, list: Object.entries(GO_ENGINES).map(([k, c]) => ({ key: k, label: c.label })) };

const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });   // 拒绝巨型帧（Pi 内存有限）

// WS 引擎消息速率限制（防单机/单 IP 把 CPU 资源全吃光）：chess 30/min · go 10/min（围棋更贵）
const wsRate = new Map();
function wsRateCheck(key, max, windowMs) {
  const now = Date.now();
  const arr = (wsRate.get(key) || []).filter(t => now - t < windowMs);
  arr.push(now);
  wsRate.set(key, arr);
  return arr.length <= max;
}
// 定期清理 10 分钟未使用的桶，防止 Map 无限增长
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of wsRate) {
    const f = arr.filter(t => now - t < 600000);
    if (f.length) wsRate.set(k, f); else wsRate.delete(k);
  }
}, 5 * 60 * 1000).unref();

wss.on("connection", (ws, req) => {
  // 连接级错误兜底：客户端异常断开/写失败不应冒泡成未捕获异常
  ws.on("error", () => {});
  ws._ip = clientIp(req);
  // 保存 cookie：每条分析请求据此重新校验会话（账号被停用/改角色后旧连接立即失效）
  ws._cookie = (req.headers && req.headers.cookie) || "";
  // 鉴权态在连接建立时一次性快照：避免每条消息重新读 cookie / sessions.json；
  // mustChange 仍按当前账号快照判断（强制改密期内建立新连接会被即时拒绝）
  let session = null;
  try { session = admin.getSession(req); } catch (e) { session = null; }
  ws._session = session;
  ws._mustChange = !!(session && (() => {
    try {
      const acc = admin.getAccounts().find(a => a.id === session.userId);
      return !!(acc && acc.mustChange);
    } catch { return false; }
  })());
  console.log("[ws] client", ws._ip, session ? ("u=" + session.username + (ws._mustChange ? " mc=1" : "")) : "anon");
  ws.on("message", async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const t = msg && msg.type;

    // 速率限制：chess 30/min · go 10/min（围棋 KataGo 分析一次数百毫秒到数秒，限额更紧）
    if (t === "chess") {
      if (!wsRateCheck("wsch:" + ws._ip, 30, 60000))
        return ws.send(JSON.stringify({ type: "error", id: msg.id, message: "请求过于频繁", code: "RATE_LIMIT" }));
    } else if (t === "go") {
      if (!wsRateCheck("wsgo:" + ws._ip, 10, 60000))
        return ws.send(JSON.stringify({ type: "error", id: msg.id, message: "请求过于频繁", code: "RATE_LIMIT" }));
    }

    // 元信息查询无需登录
    if (t === "engines") {
      const list = Object.entries(ENGINES).map(([k, c]) => ({ key: k, available: c.available, elo: c.elo }));
      ws.send(JSON.stringify({ type: "engines", id: msg.id, engines: list }));
      return;
    }
    if (t === "goengines") {
      ws.send(JSON.stringify({ type: "goengines", id: msg.id, engines: go.list, available: go.available }));
      return;
    }

    // 引擎分析（chess / go）必须登录且未处于强制改密期
    if (t === "chess" || t === "go") {
      // 每条请求重新校验会话：停用/降权/登出后，已建立的旧 WS 连接不得继续调用引擎
      let fresh = null;
      try { fresh = admin.getSession({ headers: { cookie: ws._cookie } }); } catch (e) { fresh = null; }
      if (!fresh) {
        ws._session = null;
        return ws.send(JSON.stringify({
          type: "error", id: msg.id, code: "AUTH_REQUIRED",
          message: "未登录",
        }));
      }
      ws._session = fresh;
      if (ws._mustChange) {
        return ws.send(JSON.stringify({
          type: "error", id: msg.id, code: "MUST_CHANGE", mustChange: true,
          message: "请先修改密码后再继续操作",
        }));
      }
    }

    if (t === "chess") {
      // 参数白名单化：非法直接回错误，绝不把未净化的字符串送进引擎 stdin
      const fen = validFen(msg.fen);
      if (!fen) {
        ws.send(JSON.stringify({ type: "error", id: msg.id, message: "非法 FEN" }));
        return;
      }
      const { key, cfg, eng } = engineFor(msg.engine);
      try {
        const r = await eng.bestMove(fen, {
          elo: msg.elo == null ? null : clampInt(msg.elo, 800, 2850, null),
          movetime: clampInt(msg.movetime ?? 800, 100, 5000, 800),
          multipv: clampInt(msg.multipv ?? 3, 1, 10, 3),
          supportsElo: cfg.elo,
        });
        ws.send(JSON.stringify({ type: "chess", id: msg.id, engine: key, ...r }));
        admin.logGame({ type: "chess", engine: key, movetime: clampInt(msg.movetime ?? 800, 100, 5000, 800), ip: ws._ip });
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", id: msg.id, message: String(e) }));
      }
    } else if (t === "go") {
      try {
        const engKey = GO_ENGINES[msg.engine] ? msg.engine : (GO_DEFAULT || null);
        if (!engKey) return ws.send(JSON.stringify({ type: "error", id: msg.id, message: "未部署围棋引擎" }));
        // stones：[色, 着点] 白名单校验（GTP 路径的 mv 会拼进 stdin 命令）
        const stones = Array.isArray(msg.stones) ? msg.stones.slice(0, 361).map(s =>
          Array.isArray(s) && (s[0] === "B" || s[0] === "W")
          && (s[1] === "pass" || /^[a-hA-Hj-zJ-Z]([1-9]|1\d|2[0-5])$/.test(String(s[1])))
            ? [s[0], String(s[1])] : null
        ).filter(Boolean) : [];
        if (stones.length !== (msg.stones || []).length) {
          return ws.send(JSON.stringify({ type: "error", id: msg.id, message: "非法着点" }));
        }
        const side = msg.side === "W" ? "W" : "B";
        const r = await goAnalyze(engKey, stones, side, {
          komi: clampInt(msg.komi ?? 7.5, -500, 500, 7.5),
          boardSize: clampInt(msg.boardSize || 19, 2, 25, 19),
          maxVisits: clampInt(msg.maxVisits || 200, 1, 10000, 200),
          timeout: 120000,
        });
        ws.send(JSON.stringify({ ...r, type: "go", id: msg.id, engine: engKey }));
        admin.logGame({ type: "go", engine: engKey, movetime: 0, ip: ws._ip });
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", id: msg.id, message: String(e) }));
      }
    }
  });
});

// ---- 后台管理系统挂载 ----
function engineStatus() {
  const chess = Object.entries(ENGINES).map(([k, c]) => ({
    key: k, kind: "chess", available: c.available,
    alive: !!(chessEngines[k] && chessEngines[k].proc),
  }));
  const go = Object.entries(GO_ENGINES).map(([k]) => {
    const pool = goPool.get(k);
    return { key: k, kind: "go", available: true, alive: !!(pool && pool.eng && !pool.eng.dead) };
  });
  return [...chess, ...go];
}
function controlEngine(key, action) {
  if (action === "stop") {
    if (chessEngines[key]) chessEngines[key].stop();
    const pool = goPool.get(key);
    if (pool) { try { pool.eng.stop(); } catch (e) {} goPool.delete(key); }
    return true;
  }
  if (action === "start") {
    if (chessEngines[key]) { chessEngines[key].init().catch(() => {}); return true; }
    const pool = goPool.get(key);
    if (pool && pool.eng.dead) goPool.delete(key);
    return true;
  }
  return false;
}
admin.init({ publicDir: PUBLIC_DIR, engineStatus, controlEngine });

// 进程级兜底：仅记录，不让单个异常拖垮整个服务（连接级错误另有 ws.on("error") 兜底）
process.on("uncaughtException", e => console.error("[fatal]", e));
process.on("unhandledRejection", e => console.error("[reject]", e));

server.listen(PORT, () => {
  console.log(`S.T.A.R. AI 推荐已启动: http://localhost:${PORT}`);
  console.log(`  国际象棋引擎: ${Object.keys(ENGINES).join(" / ")}`);
  console.log(`  围棋引擎: ${GO_KEYS.length ? GO_KEYS.join(" / ") : "(无，检查 models/ 目录)"}`);
});
