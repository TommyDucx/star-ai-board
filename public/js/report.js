/* S.T.A.R. 对局战报卡片
 * 依赖：public/js/lib/html2canvas.min.js、chess.min.js、chessboard.min.js、jquery
 * 用法：
 *   StarReport.open({
 *     room,            // { id, seats:{w:{name},b:{name}}, moves:[{from,to,san,by,ms}], result:{winner,reason}, startedAt, endedAt }
 *     mySeat,          // "w" | "b" | null
 *     pieceTheme,      // 棋子图片路径模板
 *   })
 *
 * 说明：精准度与评估曲线基于**客户端启发式评估**（子力 + 机动性），
 *      不是引擎级评分，仅用于回顾走势，UI 上也会如实标注。
 */
(function () {
  "use strict";
  var VALS = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

  /* 局面评估：正数=白优 */
  function evalChess(c) {
    var s = 0, board = c.board();
    for (var r = 0; r < 8; r++) for (var f = 0; f < 8; f++) {
      var sq = board[r][f]; if (!sq) continue;
      var v = VALS[sq.type] || 0;
      // 中心控制微加成（越靠中心越高）
      var cd = (3.5 - Math.abs(f - 3.5)) + (3.5 - Math.abs(r - 3.5));
      v += cd * 2;
      s += (sq.color === "w" ? 1 : -1) * v;
    }
    // 机动性
    try { s += (c.turn() === "w" ? 1 : -1) * c.moves().length * 1.5; } catch (e) {}
    return s;
  }

  /* 逐手分析：返回 { curve:[{ply,eval,white}], acc:{w,b}, turning:{ply,drop,fen,san}, plies } */
  function analyze(moves, startFen) {
    var c = new Chess();
    if (startFen) { try { c.load(startFen); } catch (e) {} }
    var curve = [{ ply: 0, fen: c.fen(), eval: evalChess(c), white: true }];
    var accW = [], accB = [], turning = null;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var before = evalChess(c), side = c.turn();
      var mv = null;
      try { mv = c.move({ from: m.from, to: m.to, promotion: "q" }); } catch (e) { mv = null; }
      if (!mv) break;
      var after = evalChess(c);
      // 从走子方视角的损失（正=亏）
      var drop = side === "w" ? (before - after) : (after - before);
      var acc = Math.max(0, Math.min(100, 100 - Math.max(0, drop) / 6));
      (side === "w" ? accW : accB).push(acc);
      if (!turning || Math.abs(drop) > Math.abs(turning.drop)) {
        turning = { ply: i + 1, drop: Math.round(drop), fen: c.fen(), san: mv.san, by: side };
      }
      curve.push({ ply: i + 1, fen: c.fen(), eval: Math.round(after), white: c.turn() === "b" });
    }
    var avg = function (a) { return a.length ? Math.round(a.reduce(function (x, y) { return x + y; }, 0) / a.length) : null; };
    return { curve: curve, acc: { w: avg(accW), b: avg(accB) }, turning: turning, plies: curve.length - 1 };
  }

  var REASON = { checkmate: "将杀", resign: "认输", timeout: "超时", abandon: "一方离线", stalemate: "逼和", insufficient: "子力不足和棋", draw: "和棋", repetition: "三次重复和棋" };
  var esc = function (t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]; }); };

  /* 评估曲线画到 canvas（正=白优，中线上红下绿按中国习惯：红=白方领先） */
  function drawCurve(canvas, curve) {
    var W = canvas.width, H = canvas.height, ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    var pad = 12, mid = H / 2;
    var maxAbs = Math.max(150, curve.reduce(function (m, p) { return Math.max(m, Math.abs(p.eval)); }, 0));
    // 网格
    ctx.strokeStyle = "rgba(239,242,232,.12)"; ctx.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(function (f) { ctx.beginPath(); ctx.moveTo(pad, H * f); ctx.lineTo(W - pad, H * f); ctx.stroke(); });
    // 中线
    ctx.strokeStyle = "rgba(239,242,232,.3)"; ctx.beginPath(); ctx.moveTo(pad, mid); ctx.lineTo(W - pad, mid); ctx.stroke();
    if (curve.length < 2) return;
    var x = function (i) { return pad + (W - pad * 2) * i / (curve.length - 1); };
    var y = function (v) { return mid - (H / 2 - pad) * Math.max(-1, Math.min(1, v / maxAbs)); };
    // 白方优势区（红）/黑方优势区填充
    ctx.beginPath(); ctx.moveTo(x(0), mid);
    curve.forEach(function (p, i) { ctx.lineTo(x(i), y(p.eval)); });
    ctx.lineTo(x(curve.length - 1), mid); ctx.closePath();
    ctx.fillStyle = "rgba(215,255,63,.14)"; ctx.fill();
    // 曲线
    ctx.beginPath(); ctx.lineWidth = 2; ctx.strokeStyle = "#d7ff3f";
    curve.forEach(function (p, i) { i ? ctx.lineTo(x(i), y(p.eval)) : ctx.moveTo(x(i), y(p.eval)); });
    ctx.stroke();
    // 转折点标记
    ctx.fillStyle = "#ff6d64";
    ctx.beginPath(); ctx.arc(x(curve.length - 1), y(curve[curve.length - 1].eval), 3, 0, Math.PI * 2); ctx.fill();
  }

  function buildModal(data) {
    var room = data.room || {};
    var seats = room.seats || {};
    var w = seats.w || { name: "白方" }, b = seats.b || { name: "黑方" };
    var res = room.result || {};
    var winner = res.winner;
    var resText = winner ? (winner === "w" ? "白方胜" : "黑方胜") + " · " + (REASON[res.reason] || res.reason) : "和棋 · " + (REASON[res.reason] || res.reason);
    var an = analyze(room.moves || []);
    var dur = room.endedAt && room.startedAt ? Math.round((room.endedAt - room.startedAt) / 1000) : 0;

    var el = document.createElement("div");
    el.className = "report-mask";
    el.innerHTML =
      '<div class="report-card" id="report-card">' +
        '<div class="rc-head"><span class="rc-kicker">S.T.A.R. / MATCH REPORT</span><em>' + new Date().toLocaleDateString("zh-CN") + '</em></div>' +
        '<div class="rc-title">' + esc(resText) + '</div>' +
        '<div class="rc-players">' +
          '<div class="rc-p ' + (winner === "w" ? "win" : "") + '"><span class="rc-av">' + esc(String(w.name || "W").slice(0, 1)) + '</span><b>' + esc(w.name || "白方") + '</b><small>白 · 精准度 ' + (an.acc.w == null ? "—" : an.acc.w + "%") + '</small></div>' +
          '<div class="rc-vs">VS</div>' +
          '<div class="rc-p ' + (winner === "b" ? "win" : "") + '"><span class="rc-av dark">' + esc(String(b.name || "B").slice(0, 1)) + '</span><b>' + esc(b.name || "黑方") + '</b><small>黑 · 精准度 ' + (an.acc.b == null ? "—" : an.acc.b + "%") + '</small></div>' +
        '</div>' +
        '<div class="rc-section"><span class="rc-label">关键转折点' + (an.turning ? " · 第 " + an.turning.ply + " 手 " + esc(an.turning.san) : "") + '</span>' +
          '<div class="rc-turnwrap"><div id="rc-mini-board"></div>' +
            '<div class="rc-turnmeta">' + (an.turning ? ('<b>' + (an.turning.by === "w" ? "白方" : "黑方") + '</b> 走出 <b>' + esc(an.turning.san) + '</b><br>局面评估波动 ' + (an.turning.drop > 0 ? "−" : "+") + Math.abs(an.turning.drop) + '（' + (an.turning.drop > 0 ? "失误" : "好手") + '）') : "无") + '</div></div></div>' +
        '<div class="rc-section"><span class="rc-label">局面评估曲线（启发式：子力 + 机动性）</span>' +
          '<canvas id="rc-curve" width="720" height="150"></canvas></div>' +
        '<div class="rc-stats">' +
          '<div><b>' + an.plies + '</b><span>总手数</span></div>' +
          '<div><b>' + Math.floor(dur / 60) + ":" + String(dur % 60).padStart(2, "0") + '</b><span>对局时长</span></div>' +
          '<div><b>' + esc((REASON[res.reason] || res.reason || "—")) + '</b><span>结束方式</span></div>' +
        '</div>' +
        '<div class="rc-foot"><span>S.T.A.R. 国际象棋 · 熟人邀战</span><em>' + esc(String(room.id || "").slice(0, 8)) + '</em></div>' +
      '</div>' +
      '<div class="rc-actions">' +
        '<button class="rc-btn primary" data-act="copy">复制图片</button>' +
        '<button class="rc-btn" data-act="download">下载 PNG</button>' +
        '<button class="rc-btn" data-act="share">分享</button>' +
        '<button class="rc-btn ghost" data-act="close">关闭</button>' +
      '</div>';
    document.body.appendChild(el);

    // 关键转折点棋盘
    if (an.turning && window.Chessboard) {
      var mb = Chessboard("rc-mini-board", { position: an.turning.fen, showNotation: false, pieceTheme: data.pieceTheme, draggable: false, appearSpeed: 0, moveSpeed: 0 });
      setTimeout(function () { try { mb.resize(); } catch (e) {} }, 30);
    }
    var cv = el.querySelector("#rc-curve"); if (cv) drawCurve(cv, an.curve);

    el.addEventListener("click", function (e) {
      var b2 = e.target.closest ? e.target.closest("[data-act]") : null;
      if (!b2) return;
      var act = b2.getAttribute("data-act");
      if (act === "close") return el.remove();
      var card = el.querySelector("#report-card");
      if (act === "copy" || act === "download" || act === "share") {
        b2.disabled = true; b2.textContent = "生成中…";
        (window.html2canvas
          ? html2canvas(card, { backgroundColor: "#0b0e0c", scale: 2, useCORS: true })
          : Promise.reject(new Error("html2canvas 未加载"))
        ).then(function (canvas) {
          canvas.toBlob(function (blob) {
            var url = URL.createObjectURL(blob);
            var fname = "star-report-" + String(room.id || "").slice(0, 8) + ".png";
            if (act === "download") {
              var a = document.createElement("a"); a.href = url; a.download = fname; a.click();
              return finish("已下载 " + fname);
            }
            if (act === "share" && navigator.share && navigator.canShare) {
              var file = new File([blob], fname, { type: "image/png" });
              return navigator.share({ files: [file], title: "S.T.A.R. 对局战报", text: resText })
                .then(function () { finish("已分享"); })
                .catch(function () { finish("已取消"); });
            }
            // 复制：优先剪贴板图片，其次复制文本摘要
            var ok = false;
            try {
              if (navigator.clipboard && window.ClipboardItem) {
                navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
                ok = true;
              }
            } catch (err) { ok = false; }
            if (!ok) {
              var ta = document.createElement("textarea");
              ta.value = "S.T.A.R. 对局战报：" + resText + "（" + an.plies + " 手）";
              document.body.appendChild(ta); ta.select();
              try { document.execCommand("copy"); } catch (err2) {}
              ta.remove();
              return finish("已复制文字摘要（浏览器不支持图片剪贴板）");
            }
            finish("战报图片已复制");
          }, "image/png");
          function finish(msg) { b2.disabled = false; b2.textContent = act === "copy" ? "复制图片" : act === "download" ? "下载 PNG" : "分享"; var t = document.createElement("div"); t.className = "rc-toast"; t.textContent = msg; el.appendChild(t); setTimeout(function () { t.remove(); }, 2400); }
        }).catch(function (err) { b2.disabled = false; b2.textContent = "重试"; var t = document.createElement("div"); t.className = "rc-toast err"; t.textContent = "生成失败：" + (err && err.message || err); el.appendChild(t); setTimeout(function () { t.remove(); }, 3000); });
      }
    });
    return el;
  }

  var CSS = '' +
    '.report-mask{position:fixed;inset:0;z-index:400;background:rgba(4,6,5,.86);backdrop-filter:blur(6px);display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:14px;padding:24px 16px;overflow:auto}' +
    '.report-card{width:min(760px,96vw);background:linear-gradient(160deg,#12171322,#0a0e0c),#0b0e0c;border:1px solid #d7ff3f26;border-radius:16px;padding:22px 24px;color:#eff2e8;box-shadow:0 30px 80px -30px #000}' +
    '.rc-head{display:flex;justify-content:space-between;font-size:10px;letter-spacing:.28em;color:#8a9288;text-transform:uppercase}' +
    '.rc-title{margin:10px 0 18px;font-size:clamp(22px,3vw,32px);font-weight:800;color:#d7ff3f;letter-spacing:.02em}' +
    '.rc-players{display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center;margin-bottom:20px}' +
    '.rc-p{display:grid;gap:4px;padding:12px 14px;border:1px solid #ffffff14;border-radius:12px;background:#ffffff06}' +
    '.rc-p.win{border-color:#d7ff3f66;background:#d7ff3f0f}' +
    '.rc-p b{font-size:16px}.rc-p small{color:#8a9288;font-size:11px}' +
    '.rc-av{width:30px;height:30px;border-radius:50%;background:#eff2e8;color:#0b0e0c;display:grid;place-items:center;font-weight:800}' +
    '.rc-av.dark{background:#2a3130;color:#eff2e8;border:1px solid #ffffff26}' +
    '.rc-vs{color:#8a9288;font-size:12px;letter-spacing:.2em}' +
    '.rc-section{margin-bottom:18px}.rc-label{display:block;font-size:10px;letter-spacing:.24em;color:#8a9288;text-transform:uppercase;margin-bottom:10px}' +
    '.rc-turnwrap{display:grid;grid-template-columns:220px 1fr;gap:16px;align-items:center}' +
    '.rc-turnmeta{font-size:13px;line-height:1.9;color:#c9cfc6}.rc-turnmeta b{color:#d7ff3f}' +
    '#rc-curve{width:100%;height:auto;background:#ffffff05;border:1px solid #ffffff12;border-radius:10px}' +
    '.rc-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:6px 0 16px}' +
    '.rc-stats>div{display:grid;gap:3px;padding:10px 12px;border:1px solid #ffffff12;border-radius:10px;background:#ffffff05}' +
    '.rc-stats b{font-size:18px;color:#eff2e8}.rc-stats span{font-size:10px;color:#8a9288;letter-spacing:.14em}' +
    '.rc-foot{display:flex;justify-content:space-between;font-size:10px;color:#6d756c;letter-spacing:.18em;border-top:1px solid #ffffff12;padding-top:12px}' +
    '.rc-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}' +
    '.rc-btn{border:1px solid #ffffff26;background:#ffffff0a;color:#eff2e8;border-radius:999px;padding:9px 20px;cursor:pointer;font-size:13px;transition:.18s}' +
    '.rc-btn:hover{border-color:#d7ff3f88;color:#d7ff3f}' +
    '.rc-btn.primary{background:#d7ff3f;border-color:#d7ff3f;color:#0b0e0c;font-weight:700}' +
    '.rc-btn.ghost{opacity:.7}.rc-btn:disabled{opacity:.5;cursor:default}' +
    '.rc-toast{position:fixed;left:50%;bottom:38px;transform:translateX(-50%);background:#1a201b;border:1px solid #d7ff3f55;color:#eff2e8;padding:10px 20px;border-radius:999px;font-size:13px;z-index:410}' +
    '.rc-toast.err{border-color:#ff6d6499}' +
    '@media(max-width:620px){.rc-turnwrap{grid-template-columns:1fr}.rc-players{grid-template-columns:1fr;gap:8px}.rc-vs{text-align:center}}';

  function open(data) {
    if (!document.getElementById("report-style")) {
      var st = document.createElement("style"); st.id = "report-style"; st.textContent = CSS; document.head.appendChild(st);
    }
    return buildModal(data || {});
  }

  window.StarReport = { open: open, analyze: analyze, evalChess: evalChess };
})();
