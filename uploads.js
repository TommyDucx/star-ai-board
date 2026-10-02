"use strict";
/**
 * S.T.A.R. 通用附件上传（文学评论区 / 对局评论区共用）
 * ---------------------------------------------------------------
 * 存储
 *   · 文件落盘：public/uploads/<id><ext>（静态可访问，文件名不可猜）
 *   · 索引：admin/uploads.json { schemaVersion, files: { <id>: {id,name,ext,kind,mime,size,owner,ts,inline} } }
 *     owner = "u:<userId>"（登录用户，文学评论）或 "g:<guestId>"（访客，对局评论区）
 *
 * 安全策略
 *   · 单文件 ≤ 5MB；每条评论 ≤ 4 个附件；上传目录总量 ≤ 400MB（超限 507）
 *   · 危险类型（html/svg/js/xml/…）**一律以 octet-stream + attachment 下发**，杜绝存储型 XSS
 *   · 图片 / 音频 / 视频 / PDF / 纯文本 → inline 展示；其余（doc/zip/…）→ 下载
 *   · 归属校验：只有上传者本人（同 userId / 同 guestId）能把它挂到评论上
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ADMIN_DIR = path.join(__dirname, "admin");
const INDEX_FILE = path.join(ADMIN_DIR, "uploads.json");
const FILES_DIR = path.join(__dirname, "public", "uploads");

const LIMITS = {
  maxFile: 5 * 1024 * 1024,        // 单文件 5MB
  maxPerComment: 4,                 // 每条评论最多附件数
  totalQuota: 400 * 1024 * 1024,    // 上传目录总量上限 400MB
  maxName: 120,
};

/* ---------- 分类 ---------- */
const IMG = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico"];
const AUD = ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba"];
const VID = ["mp4", "webm", "mov", "m4v", "ogv"];
const TXT = ["txt", "md", "markdown", "csv", "tsv", "log", "json", "yml", "yaml", "ini", "conf", "srt", "vtt"];
const CODE = ["js", "ts", "jsx", "tsx", "py", "rs", "c", "h", "cpp", "hpp", "java", "go", "rb", "sh", "sql", "css", "lua", "kt", "swift", "php", "pl"];
const DOC = ["pdf"];
const RISKY = ["html", "htm", "xhtml", "shtml", "svg", "xml", "xsl", "mhtml", "hta", "jar", "apk", "exe", "dll", "so", "dylib", "bat", "cmd", "com", "scr", "msi", "vbs", "ps1", "app", "dmg", "deb", "rpm"];

function kindOf(ext) {
  if (IMG.includes(ext)) return "image";
  if (AUD.includes(ext)) return "audio";
  if (VID.includes(ext)) return "video";
  if (TXT.includes(ext)) return "text";
  if (CODE.includes(ext)) return "code";
  if (DOC.includes(ext)) return "pdf";
  if (ext === "zip" || ext === "rar" || ext === "7z" || ext === "tar" || ext === "gz") return "archive";
  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "epub", "mobi"].includes(ext)) return "doc";
  return "other";
}
/* 可安全内联展示（配合 nosniff）：其余一律强制下载 */
function isInline(ext, kind) {
  if (RISKY.includes(ext)) return false;
  return ["image", "audio", "video", "text", "pdf"].includes(kind);
}
const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif", ico: "image/x-icon",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", opus: "audio/opus", weba: "audio/webm",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4", ogv: "video/ogg",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", markdown: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8", log: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8", yml: "text/yaml; charset=utf-8", yaml: "text/yaml; charset=utf-8",
  ini: "text/plain; charset=utf-8", conf: "text/plain; charset=utf-8", srt: "text/plain; charset=utf-8", vtt: "text/vtt; charset=utf-8",
};
function mimeOf(ext, kind) {
  if (MIME[ext]) return MIME[ext];
  if (RISKY.includes(ext)) return "application/octet-stream";
  if (kind === "code") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/* ---------- 索引 ---------- */
function loadIndex() {
  try {
    const v = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    if (v && v.files && typeof v.files === "object") return v;
  } catch {}
  return { schemaVersion: 1, files: {} };
}
function saveIndex(v) {
  try {
    if (!fs.existsSync(ADMIN_DIR)) fs.mkdirSync(ADMIN_DIR, { recursive: true });
    const tmp = INDEX_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, INDEX_FILE);
  } catch {}
}
function totalSize() {
  const idx = loadIndex();
  let n = 0;
  for (const k of Object.keys(idx.files)) n += (idx.files[k].size || 0);
  return n;
}
function stats() {
  const idx = loadIndex();
  const ids = Object.keys(idx.files);
  return { count: ids.length, bytes: totalSize(), quota: LIMITS.totalQuota, dir: FILES_DIR };
}

/* ---------- 文件名 ---------- */
function cleanExt(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "bin";
}
function cleanName(name) {
  return String(name == null ? "" : name)
    .replace(/[\u0000-\u001f\u007f/\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITS.maxName) || "未命名文件";
}

/* ---------- 保存 ---------- */
/**
 * @param {{name:string, base64:string, owner:string}} p
 * @returns {{error?:string, code?:number, file?:object}}
 */
function save(p) {
  const name = cleanName(p.name);
  const ext = cleanExt(name);
  let buf;
  let raw = String(p.base64 || "");
  const m = /^data:[^,]*;base64,(.*)$/s.exec(raw);          // 兼容 dataURL
  if (m) raw = m[1];
  raw = raw.replace(/\s+/g, "");
  if (!raw) return { error: "文件内容为空", code: 400 };
  try { buf = Buffer.from(raw, "base64"); } catch { return { error: "文件内容无法解析", code: 400 }; }
  if (!buf.length) return { error: "文件内容为空", code: 400 };
  if (buf.length > LIMITS.maxFile) return { error: "单个文件不能超过 " + Math.round(LIMITS.maxFile / 1024 / 1024) + "MB", code: 413 };
  if (totalSize() + buf.length > LIMITS.totalQuota) return { error: "服务器附件空间已满，请联系作者清理", code: 507 };

  const kind = kindOf(ext);
  const inline = isInline(ext, kind);
  const id = crypto.randomBytes(12).toString("hex");
  const stored = id + "." + ext;
  try {
    if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
    fs.writeFileSync(path.join(FILES_DIR, stored), buf, { mode: 0o644 });
  } catch (e) { return { error: "服务器写入失败", code: 500 }; }

  const file = {
    id, name, ext, kind, size: buf.length,
    mime: mimeOf(ext, kind), inline,
    url: "/uploads/" + stored,
    stored,
    owner: String(p.owner || ""),
    ts: Date.now(),
  };
  const idx = loadIndex();
  idx.files[id] = file;
  saveIndex(idx);
  return { file };
}

/* ---------- 读取 / 归属 / 删除 ---------- */
function get(id) { return loadIndex().files[String(id || "")] || null; }
function owns(id, owner) {
  const f = get(id);
  return !!(f && owner && f.owner === owner);
}
function remove(id) {
  const idx = loadIndex();
  const f = idx.files[String(id || "")];
  if (!f) return false;
  try { fs.unlinkSync(path.join(FILES_DIR, f.stored)); } catch {}
  delete idx.files[f.id];
  saveIndex(idx);
  return true;
}
/* 归一化一组待挂载的附件：校验存在 + 归属 + 数量上限；返回精简元数据 */
function normalizeAtts(list, owner) {
  if (!Array.isArray(list) || !list.length) return { atts: [] };
  const picked = [];
  for (const it of list.slice(0, LIMITS.maxPerComment)) {
    const id = String((it && it.id) || it || "");
    if (!id) continue;
    const f = get(id);
    if (!f) return { error: "附件不存在或已过期" };
    if (!owner || f.owner !== owner) return { error: "附件不属于当前用户" };
    if (picked.some(x => x.id === f.id)) continue;
    picked.push({ id: f.id, name: f.name, size: f.size, mime: f.mime, kind: f.kind, url: f.url, inline: f.inline });
  }
  return { atts: picked };
}

/* 孤儿清理：索引里存在、但没有任何评论引用、且已上传超过 minAgeMs 的附件——直接删除。
   两个来源：① 用户上传后没发表评论就离开；② 评论/房间被回收但附件元数据遗留。
   （评论删除时已即时清理；这里是兜底。） */
function sweepUnreferenced(refIds, minAgeMs) {
  const keep = new Set(Array.isArray(refIds) ? refIds : []);
  const idx = loadIndex();
  const now = Date.now();
  const age = minAgeMs == null ? 24 * 60 * 60 * 1000 : minAgeMs;
  let n = 0;
  for (const id of Object.keys(idx.files)) {
    const f = idx.files[id];
    if (keep.has(id)) continue;
    if (now - (f.ts || 0) < age) continue;
    try { fs.unlinkSync(path.join(FILES_DIR, f.stored)); } catch {}
    delete idx.files[id];
    n++;
  }
  if (n) saveIndex(idx);
  return n;
}

module.exports = { LIMITS, FILES_DIR, save, get, owns, remove, normalizeAtts, stats, kindOf, mimeOf, cleanName, sweepUnreferenced, loadIndex };
