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

// ---- 围棋引擎（KataGo）配置 ----
const KATAGO = process.env.KATAGO || "/usr/local/bin/katago";
const GO_MODEL = process.env.GO_MODEL ||
  "/Users/tommydu/WorkBuddy/2026-08-01-22-35-01/goeye/models/g170e-b10c128.txt.gz";
const GO_TMP = path.join(os.tmpdir(), "star-katago");

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
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

/* ===================== 国际象棋：Stockfish (UCI) ===================== */
class ChessEngine {
  constructor() {
    this.proc = null;
    this.buf = "";
    this.waiters = [];
    this.queue = Promise.resolve();
    this._uci = false;
  }
  _ensureAlive() {
    if (!this.proc || this.proc.exitCode !== null) {
      this.proc = spawn(STOCKFISH, [], { stdio: ["pipe", "pipe", "ignore"] });
      this.buf = "";
      this._uci = false;
      this.proc.stdout.setEncoding("utf8");
      this.proc.stdout.on("data", d => this._onData(d));
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
    }
    const ready = this._waitFor(l => l === "readyok");
    this._send("isready");
    await ready;
  }
  // 计算最佳走法；同时返回 Top 走法候选（供"推荐下一步"展示）
  async bestMove(fen, { elo = null, movetime = 800, multipv = 3 } = {}) {
    return this.run(async () => {
      await this.init();
      if (elo) {
        this._send("setoption name UCI_LimitStrength value true");
        this._send(`setoption name UCI_Elo value ${elo}`);
      } else {
        this._send("setoption name UCI_LimitStrength value false");
      }
      this._send(`setoption name MultiPV value ${multipv}`);
      this._send(`position fen ${fen}`);
      const done = this._waitFor(l => l.startsWith("bestmove"));
      this._send(`go movetime ${movetime}`);
      const lines = await done;
      const bestmove = (lines.find(l => l.startsWith("bestmove")) || "").split(/\s+/)[1] || null;
      // 解析多条 PV（MultiPV）：score + 走法
      const candidates = [];
      let cur = null;
      for (const l of lines) {
        if (l.startsWith("info") && l.includes("multipv")) {
          const pvN = +(l.match(/multipv (\d+)/) || [])[1] || 0;
          const s = l.match(/score cp (-?\d+)/);
          const m = l.match(/score mate (-?\d+)/);
          const pv = (l.match(/ pv (.+)$/) || [])[1] || "";
          cur = { pv: pv.split(/\s+/).slice(0, 2), depth: +(l.match(/depth (\d+)/) || [])[1] || 0 };
          if (s) { cur.evalCp = +s[1]; cur.mate = null; }
          if (m) { cur.mate = +m[1]; cur.evalCp = null; }
          candidates[pvN - 1] = cur;
        }
      }
      return { bestmove, candidates: candidates.filter(Boolean) };
    });
  }
}

/* ===================== 围棋：KataGo (analysis JSON) ===================== */
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

class GoEngine {
  constructor() {
    this.proc = null;
    this.buf = "";
    this.pending = new Map();
    this.counter = 0;
    this.backend = "";
  }
  async start() {
    fs.mkdirSync(path.join(GO_TMP, "logs"), { recursive: true });
    let lastErr = "";
    // 本机（Intel 无 GPU 加速）直接用 eigen(CPU)；加载成功即视为可用
    for (const [backend, timeout] of [["eigen", 90]]) {
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
      this.proc = spawn(KATAGO, ["analysis", "-model", GO_MODEL, "-config", cfg], { stdio: ["pipe", "pipe", "pipe"] });
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
        // 就绪行出现即可用（已用独立进程实测：就绪后可正常分析）
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
      if (!this.proc) return reject(new Error("engine not running"));
      const id = "g" + (++this.counter);
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("KataGo 超时")); }, opts.timeout || 30000);
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

/* ===================== 启动 + WebSocket ===================== */
const chess = new ChessEngine();
const go = new GoEngine();

(async () => {
  try { await go.start(); console.log("[go] KataGo 就绪 (" + go.backend + ")"); }
  catch (e) { console.error("[go] " + e.message); }
})();

const wss = new WebSocketServer({ server });
wss.on("connection", ws => {
  console.log("[ws] client");
  ws.on("message", async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "chess") {
      console.log("[chess] req", msg.id);
      try {
        const r = await chess.bestMove(msg.fen, {
          elo: msg.elo || null,
          movetime: Math.min(Math.max(msg.movetime || 800, 100), 5000),
          multipv: msg.multipv || 3,
        });
        ws.send(JSON.stringify({ type: "chess", id: msg.id, ...r }));
        console.log("[chess] resp", msg.id, r.bestmove);
      } catch (e) {
        console.log("[chess] err", String(e));
        ws.send(JSON.stringify({ type: "error", id: msg.id, message: String(e) }));
      }
    } else if (msg.type === "go") {
      console.log("[go] req", msg.id);
      try {
        const r = await go.analyze(msg.stones || [], msg.side || "B", {
          komi: msg.komi, boardSize: msg.boardSize || 19, maxVisits: msg.maxVisits || 200, timeout: 30000,
        });
        ws.send(JSON.stringify({ ...r, type: "go", id: msg.id, backend: go.backend }));
        console.log("[go] resp", msg.id, (r.moveInfos || []).length);
      } catch (e) {
        console.log("[go] err", String(e));
        ws.send(JSON.stringify({ type: "error", id: msg.id, message: String(e) }));
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`S.T.A.R. AI 推荐已启动: http://localhost:${PORT}`);
  console.log(`  围棋分析引擎: ${KATAGO}`);
  console.log(`  国际象棋引擎: ${STOCKFISH}`);
});
