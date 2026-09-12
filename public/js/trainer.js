/* 背谱训练（Opening Memory）：从共享棋谱导入线路 → 逐手回忆 → Leitner 间隔重复。
   参考项目 Kylin 的 A-01；棋盘组件与共享棋谱库共用同一套懒加载三件套。 */
(function () {
  "use strict";
  var root, state = { view:"list", line:null, notice:"", seq:0, library:[], imported:{} };
  var viewer = null, libsPromise = null, gen = 0;
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]; }); }
  function request(url, options) { return fetch(url, options).then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { res:res, data:data }; }); }); }
  function notice(m) { state.notice = m || ""; var t = root && root.querySelector(".library-status"); if (t) t.textContent = state.notice; }

  /* 懒加载棋盘三件套（与 shared-library 相同来源，避免主页面常驻加载） */
  function ensureChessLibs() {
    if (window.Chess && window.Chessboard) return Promise.resolve();
    if (libsPromise) return libsPromise;
    libsPromise = new Promise(function (resolve, reject) {
      var link = document.createElement("link");
      link.rel = "stylesheet"; link.href = "css/chessboard.min.css";
      // 必须等 CSS 真正生效：chessboard 初始化时要按容器宽度切格子，CSS 未加载会得到 0 宽棋盘
      var cssOk = new Promise(function (res) { link.onload = res; link.onerror = res; setTimeout(res, 3000); });
      document.head.appendChild(link);
      var seq = ["js/lib/jquery.min.js", "js/lib/chess.min.js", "js/lib/chessboard.min.js"];
      var scripts = new Promise(function (resolve2, reject2) {
        (function next(i) {
          if (i >= seq.length) return resolve2();
          var s = document.createElement("script");
          s.src = seq[i]; s.onload = function () { next(i + 1); };
          s.onerror = function () { libsPromise = null; reject2(new Error("棋盘组件加载失败")); };
          document.head.appendChild(s);
        })(0);
      });
      Promise.all([cssOk, scripts]).then(function () {
        // 再等两帧布局，确保容器宽度已计算
        requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(); }); });
      }).catch(reject);
    });
    return libsPromise;
  }

  function shell() {
    return '<section class="library-shell trainer-shell">' +
      '<div class="library-hero"><div><div class="library-kicker">OPENING MEMORY / 背谱训练</div><h1>背谱训练</h1><p>从共享棋谱库导入一条线路，在棋盘上凭记忆走出来。全对则记忆盒 +1、复习间隔变长；走错则退一盒，明天再来。← → 方向键也可用来回看演示。</p></div>' +
      '<div class="library-hero-side"><button class="library-action library-create" type="button" data-tr="import">＋ 从棋谱库导入</button><div class="library-index">SRS / 间隔重复<br>BOX / 六格记忆<br>AUTO / 对手自动应手</div></div></div>' +
      '<div id="trainer-body"></div></section>';
  }
  function dueText(l) {
    if (l.due) return "今天该复习";
    if (!l.dueAt) return "新导入";
    var days = Math.ceil((l.dueAt - Date.now()) / 864e5);
    return days + " 天后复习";
  }
  function boxMeter(l) {
    var on = "▮".repeat(l.box), off = "▯".repeat(Math.max(0, l.boxMax - l.box));
    return '<span class="tr-box" title="记忆盒 ' + l.box + '/' + l.boxMax + '">' + on + off + '</span>';
  }
  function lineRow(l, i) {
    return '<div class="lib-row tr-row"><span class="lib-row-no" aria-hidden="true">' + String(i + 1).padStart(2, "0") + '</span>' +
      '<span class="lib-row-main"><span class="lib-row-top"><span class="lib-code">' + esc(l.code || l.key.slice(-4).toUpperCase()) + '</span><span class="lib-cat">' + l.moves + ' 手</span><span class="lib-date">' + dueText(l) + '</span></span>' +
      '<span class="lib-row-title">' + esc(l.title) + (l.due ? '<b class="lib-stars">该复习</b>' : "") + '</span>' +
      '<span class="lib-row-foot"><span>连续正确 ' + l.streak + ' · 最佳 ' + l.bestStreak + ' · 已练 ' + l.sessions + ' 次 · 错 ' + l.errors + '</span><span>' + boxMeter(l) + '</span></span></span>' +
      '<span class="lib-row-rail"><button type="button" class="library-action" data-tr="train" data-key="' + esc(l.key) + '">开始训练</button><button type="button" class="library-action tr-dim" data-tr="remove" data-key="' + esc(l.key) + '">移除</button></span></div>';
  }
  function listTemplate(data) {
    state.imported = {};
    data.lines.forEach(function (l) { state.imported[l.sourceId] = true; });
    var rows = data.lines.length ? data.lines.map(lineRow).join("") : '<div class="library-empty"><strong>还没有训练线路</strong><small>从共享棋谱库导入一份，凭记忆把整条线路走出来。</small></div>';
    return '<div class="library-results-head"><span>训练计划</span><span class="library-count">' + data.lines.length + ' LINES · SRS 间隔 ' + data.intervals.join("/") + ' 天</span></div>' +
      '<div class="lib-list">' + rows + '</div><div class="library-status" aria-live="polite">' + esc(state.notice) + '</div>';
  }
  function loadList() {
    if (!root) return;
    var seq = ++state.seq;
    root.querySelector("#trainer-body").innerHTML = '<div class="library-empty"><strong>读取训练计划…</strong><small>从账号同步</small></div>';
    request("/api/trainer/lines").then(function (r) {
      if (seq !== state.seq) return;
      if (r.res.status === 401) throw new Error("请先登录（首页右上角）");
      if (!r.res.ok) throw new Error(r.data.error || "读取失败");
      state.lastLines = r.data.lines;
      root.querySelector("#trainer-body").innerHTML = listTemplate(r.data);
    }).catch(function (e) { if (seq === state.seq) root.querySelector("#trainer-body").innerHTML = '<div class="library-empty"><strong>暂时无法读取</strong><small>' + esc(e.message) + '</small></div>'; });
  }
  /* 导入选择器：列出共享棋谱库，逐份解析主线路并导入 */
  function showImport() {
    root.querySelector("#trainer-body").innerHTML = '<div class="library-empty"><strong>打开棋谱库目录…</strong><small>选择要背的线路</small></div>';
    request("/api/library/entries?pageSize=24").then(function (r) {
      if (!r.res.ok) throw new Error(r.data.error || "棋谱库不可用");
      state.library = r.data.entries || [];
      var rows = state.library.map(function (e) {
        var done = state.imported[e.id];
        return '<div class="lib-row tr-import"><span class="lib-row-no" aria-hidden="true">·</span><span class="lib-row-main"><span class="lib-row-top"><span class="lib-code">' + esc(e.code || "--") + '</span><span class="lib-cat">' + e.rounds + ' 回合</span></span><span class="lib-row-title">' + esc(e.title) + '</span><span class="lib-row-sum">' + esc(e.summary) + '</span></span><span class="lib-row-rail">' + (done ? '<span class="tr-dim">已在计划</span>' : '<button type="button" class="library-action" data-tr="doimport" data-id="' + esc(e.id) + '" data-title="' + esc(e.title) + '">导入</button>') + '</span></div>';
      }).join("");
      root.querySelector("#trainer-body").innerHTML = '<button type="button" class="library-action library-back" data-tr="back">← 返回计划</button><div class="library-results-head"><span>从共享棋谱库导入</span><span class="library-count">VISIBLE ' + state.library.length + '</span></div><div class="lib-list">' + rows + '</div><div class="library-status" aria-live="polite">' + esc(state.notice) + '</div>';
    }).catch(function (e) { notice(e.message); loadList(); });
  }
  function doImport(entryId, title) {
    notice("正在解析线路…");
    // 列表 API 不返回 PGN（只在详情返回），必须先取详情
    ensureChessLibs()
      .then(function () { return request("/api/library/entries/" + encodeURIComponent(entryId)).then(function (r) { if (!r.res.ok) throw new Error(r.data.error || "棋谱不可读"); return r.data.entry; }); })
      .then(function (entry) {
        var g = new Chess();
        if (!g.load_pgn(entry.pgn)) throw new Error("PGN 无法解析");
        var moves = g.history({ verbose: true }).map(function (m) { return m.from + m.to + (m.promotion || ""); });
        return request("/api/trainer/import", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ sourceId:entry.id, title:entry.title || title, moves:moves }) }).then(function (r) {
          if (!r.res.ok) throw new Error(r.data.error || "导入失败");
          state.notice = "已导入「" + (entry.title || title) + "」（" + moves.length + " 手）。";
          loadList();
        });
      })
      .catch(function (e) { notice(e.message); });
  }
  /* ---------- 训练视图 ---------- */
  function trainTemplate(line) {
    return '<button type="button" class="library-action library-back" data-tr="back">← 结束训练</button><div class="lib-viewer"><div class="lib-board-wrap"><div id="tr-board"></div></div>' +
      '<div class="lib-rail"><div class="lib-rail-head"><span class="lib-code">' + esc(line.key.slice(-4).toUpperCase()) + '</span><b>' + esc(line.title) + '</b><span class="lib-mv-pos" id="tr-pos">加载棋盘…</span><span class="lib-mv-count" id="tr-prog"></span></div>' +
      '<div class="tr-stats" id="tr-stats"></div><div class="lib-ctrls"><button type="button" data-tr="restart">从头再来</button><button type="button" data-tr="quit">结束训练</button></div></div></div><div class="library-status" aria-live="polite">' + esc(state.notice) + '</div>';
  }
  function train(line) {
    state.view = "train"; state.line = line;
    root.classList.add("tr-focus");   // 专注模式：隐藏大 hero，保证棋盘整盘落在首屏内
    root.querySelector("#trainer-body").innerHTML = trainTemplate(line);
    gen += 1;
    var myGen = gen;
    ensureChessLibs().then(function () {
      if (myGen !== gen || !root) return;
      var moves = line.moveList;
      var game = new Chess();               // 完整线路（用于校验）
      var pos = new Chess();                // 当前演示局面
      var color = pos.turn() === "w" ? "white" : "black";
      var idx = 0, errors = 0;
      var board = window.Chessboard("tr-board", {
        position: "start", draggable: true, orientation: color,
        pieceTheme: "img/chesspieces/wikipedia/{piece}.png",
        onDrop: onDrop,
      });
      var statsEl = root.querySelector("#tr-stats"), posEl = root.querySelector("#tr-pos"), progEl = root.querySelector("#tr-prog");
      function paint() {
        var done = idx >= moves.length;
        posEl.textContent = done ? "线路完成！" : "第 " + (Math.floor(idx / 2) + 1) + " 回合 · 请走 " + (pos.turn() === "w" ? "白方" : "黑方") + "着";
        progEl.textContent = "进度 " + idx + "/" + moves.length;
        statsEl.innerHTML = '<span>本次错误 ' + errors + '</span><span>记忆盒 ' + line.box + '/' + line.boxMax + '</span><span>连续正确 ' + line.streak + '</span>';
        statsEl.classList.toggle("tr-err", errors > 0);
      }
      function finish() {
        request("/api/trainer/lines/" + encodeURIComponent(line.key), { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ errors:errors, done:true }) }).then(function (r) {
          var nl = r.data.line || line, next = r.data.nextDays;
          statsEl.innerHTML = '<span class="tr-done">训练完成！记忆盒 ' + nl.box + '/' + nl.boxMax + '，' + (errors === 0 ? "全对，下次 " + next + " 天后复习" : "有 " + errors + " 次失误，明天再来一次") + '</span>';
          posEl.textContent = "线路完成！";
        }).catch(function () { statsEl.innerHTML = '<span class="tr-done">训练完成（进度未能同步，请检查网络）</span>'; });
      }
      function onDrop(source, target) {
        if (idx >= moves.length || myGen !== gen) return "snapback";
        var expected = moves[idx];
        var legal = game.moves({ verbose: true }).filter(function (m) { return m.from === source && m.to === target; });
        if (!legal.length) return "snapback";
        var match = legal.filter(function (m) { return m.from + m.to + (m.promotion || "") === expected; })[0];
        var played = (match || legal[0]).from + (match || legal[0]).to + ((match || legal[0]).promotion || "");
        if (played !== expected) {
          errors += 1; paint();
          posEl.textContent = "不对，再想想——应走第 " + (idx + 1) + " 手";
          return "snapback";
        }
        game.move({ from: played.slice(0, 2), to: played.slice(2, 4), promotion: played[4] });
        pos.move({ from: played.slice(0, 2), to: played.slice(2, 4), promotion: played[4] });
        board.position(pos.fen());
        idx += 1;
        if (idx >= moves.length) { paint(); finish(); return "snapback"; }
        // 对手应手自动演示
        var reply = moves[idx];
        setTimeout(function () {
          if (myGen !== gen) return;
          game.move({ from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply[4] });
          pos.move({ from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply[4] });
          board.position(pos.fen());
          idx += 1; paint();
        }, 420);
        paint();
        return "snapback";
      }
      paint();
      // “从头再来”与“结束训练”
      root.querySelector('[data-tr="restart"]').onclick = function () { train(line); };
      root.querySelector('[data-tr="quit"]').onclick = function () {
    root.classList.remove("tr-focus");
        if (idx > 0) request("/api/trainer/lines/" + encodeURIComponent(line.key), { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ errors:errors, done:false }) }).catch(function () {});
        state.view = "list"; loadList();
      };
    }).catch(function (e) { notice(e.message); loadList(); });
  }
  function removeLine(key) {
    if (!window.confirm("从训练计划移除这条线路？（棋谱库里的原文不受影响）")) return;
    request("/api/trainer/lines/" + encodeURIComponent(key), { method:"DELETE" }).then(function (r) { if (!r.res.ok) throw new Error(r.data.error || "移除失败"); notice("已移除。"); loadList(); }).catch(function (e) { notice(e.message); });
  }
  function handleClick(event) {
    var el = event.target.closest("[data-tr]"); if (!el || !root.contains(el)) return;
    var act = el.dataset.tr, key = el.dataset.key;
    if (act === "back") { root.classList.remove("tr-focus"); state.view = "list"; return loadList(); }
    if (act === "import") return showImport();
    if (act === "doimport") return doImport(el.dataset.id, el.dataset.title);
    if (act === "train") {
      var line = state.lastLines && state.lastLines.filter(function (l) { return l.key === key; })[0];
      return line ? train(line) : notice("线路数据未就绪，请刷新");
    }
    if (act === "remove") return removeLine(key);
    if (act === "restart" || act === "quit") return;   // 训练视图内按钮由 train() 自行绑定
  }
  function mount(target) {
    root = target; state.notice = ""; state.view = "list"; viewer = null;
    root.innerHTML = shell();
    root.removeEventListener("click", handleClick); root.addEventListener("click", handleClick);
    request("/api/me").then(function (r) { state.me = r.res.ok ? r.data : null; }).catch(function () { state.me = null; }).then(loadList);
  }
  window.Trainer = { mount:mount };
}());
