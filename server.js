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
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

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

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not Found"); }
    // 禁用浏览器缓存：改动频繁，用 HTML 的 ?v= 版本号控制刷新，避免命中旧资源
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(data);
  });
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
  _waitFor(pred) { return new Promise(res => this.waiters.push({ match: pred, resolve: res, lines: [] })); }
  _send(cmd) { this.proc.stdin.write(cmd + "\n"); }
  run(fn) {
    this._ensureAlive();
    const p = this.queue.then(() => fn());
    this.queue = p.catch(() => {});
    return p;
  }
  async init() {
    if (!this._uci) {
      const uci = this._waitFor(l => l === "uciok");
      this._send("uci");
      await uci;
      this._uci = true;
      // 引擎级 UCI 选项（如 NNUE 引擎的 Eval=nnue）
      for (const o of this.options) {
        this._send(`setoption name ${o.name} value ${o.value}`);
      }
    }
    const ready = this._waitFor(l => l === "readyok");
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
      const done = this._waitFor(l => l.startsWith("bestmove"));
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
          cur = { pv: pv.split(/\s+/).slice(0, 2), depth: +(l.match(/depth (\d+)/) || [])[1] || 0, evalCp: null, mate: null };
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
          cur = { pv: pv.split(/\s+/).slice(0, 2), depth: +(l.match(/depth (\d+)/) || [])[1] || 0, evalCp: null, mate: null };
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
  }
  async start() {
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
  }
  async start() {
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
function engineFor(name) {
  const key = ENGINES[name] ? name : "stockfish";
  return { key, cfg: ENGINES[key], eng: chessEngines[key] };
}
const go = { available: GO_KEYS.length > 0, list: Object.entries(GO_ENGINES).map(([k, c]) => ({ key: k, label: c.label })) };

const wss = new WebSocketServer({ server });
wss.on("connection", ws => {
  console.log("[ws] client");
  ws.on("message", async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "engines") {
      const list = Object.entries(ENGINES).map(([k, c]) => ({ key: k, available: c.available, elo: c.elo }));
      ws.send(JSON.stringify({ type: "engines", id: msg.id, engines: list }));
      return;
    }
    if (msg.type === "chess") {
      const { key, cfg, eng } = engineFor(msg.engine);
      try {
        const r = await eng.bestMove(msg.fen, {
          elo: msg.elo || null,
          movetime: Math.min(Math.max(msg.movetime || 800, 100), 5000),
          multipv: msg.multipv || 3,
          supportsElo: cfg.elo,
        });
        ws.send(JSON.stringify({ type: "chess", id: msg.id, engine: key, ...r }));
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", id: msg.id, message: String(e) }));
      }
    } else if (msg.type === "go") {
      try {
        const engKey = GO_ENGINES[msg.engine] ? msg.engine : (GO_DEFAULT || null);
        if (!engKey) return ws.send(JSON.stringify({ type: "error", id: msg.id, message: "未部署围棋引擎" }));
        const r = await goAnalyze(engKey, msg.stones || [], msg.side || "B", {
          komi: msg.komi, boardSize: msg.boardSize || 19, maxVisits: msg.maxVisits || 200, timeout: 120000,
        });
        ws.send(JSON.stringify({ ...r, type: "go", id: msg.id, engine: engKey }));
      } catch (e) {
        ws.send(JSON.stringify({ type: "error", id: msg.id, message: String(e) }));
      }
    } else if (msg.type === "goengines") {
      ws.send(JSON.stringify({ type: "goengines", id: msg.id, engines: go.list, available: go.available }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`S.T.A.R. AI 推荐已启动: http://localhost:${PORT}`);
  console.log(`  国际象棋引擎: ${Object.keys(ENGINES).join(" / ")}`);
  console.log(`  围棋引擎: ${GO_KEYS.length ? GO_KEYS.join(" / ") : "(无，检查 models/ 目录)"}`);
});
