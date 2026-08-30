// tactics.js — 国际象棋题型练习 v2
//   题库练习：难度阶梯 + 主题/评分筛选 + 进度存档
//   每日残局：按日期哈希从题库确定性取题（每天 00:00 自动换题，离线可用）
//   连击 streak：localStorage 记录连续做题天数 + 徽章（3/7/14/30 天）
//   提示：在棋盘上高亮当前应走的起止格
(function () {
  "use strict";
  var TIERS = [
    { key: "beginner", label: "入门", desc: "一步杀 · 底线杀 · 双重攻击 · 牵制" },
    { key: "elementary", label: "初级", desc: "两步杀 · 骑士叉 · 闪击 · 牵制获利" },
    { key: "intermediate", label: "中级", desc: "串击 · 双将 · 消除防御 · 引离" },
    { key: "advanced", label: "高级", desc: "闷杀 · 三步杀 · 弃子攻杀 · 残局技术" },
  ];
  var BADGES = [
    { d: 3, n: "铜·起步" }, { d: 7, n: "银·坚持" },
    { d: 14, n: "金·入流" }, { d: 30, n: "钻·大师" },
  ];
  var THEME_CN = {
    mateIn1: "一步杀", mateIn2: "两步杀", mateIn3: "三步杀", mateIn4: "四步杀", mateIn5: "五步杀",
    mate: "将杀", backRankMate: "底线杀", smotheredMate: "闷杀", fork: "双重攻击",
    pin: "牵制", skewer: "串击", discoveredAttack: "闪击", doubleCheck: "双将",
    deflection: "引离", capturingDefender: "消除防御", sacrifice: "弃子", attraction: "引入",
    promotion: "升变", endgame: "残局", pawnEndgame: "兵残局", rookEndgame: "车残局",
    knightEndgame: "马残局", bishopEndgame: "象残局", quietMove: "闲着", trappedPiece: "困子",
    hangingPiece: "白吃吊子", xRayAttack: "透视攻击", interference: "堵塞", zugzwang: "楚茨文克",
    intermezzo: "中间着", defensiveMove: "防守着", advancedPawn: "通路兵", enPassant: "吃过路兵",
    underpromotion: "变子升变", doubleBishopMate: "双象杀", kingsideAttack: "王翼进攻",
    queensideAttack: "后翼进攻", horizontalLine: "底线双车", dovetailMate: "燕尾杀",
    crushing: "压倒性", long: "长组合", veryLong: "超长组合", short: "短组合",
    middlegame: "中局", opening: "开局", oneMove: "单步", equality: "均势",
    advantage: "优势", master: "大师", trade: "兑子", endgameKnight: "马残局",
  };
  function cn(t) { return THEME_CN[t] || t; }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var board = null, game = null, puzzles = [], tier = "beginner";
  var solved = {}, cur = null, moveIdx = 0, total = 0, tab = "pool";
  var filterSel = new Set(), rMin = null, rMax = null;
  var streak = { cur: 0, best: 0, last: "" }, daily = {};

  var boardEl = $("#board"), tiersEl = $("#tiers"), progEl = $("#prog"), pinfo = $("#pinfo");
  var ptitle = $("#ptitle"), themesEl = $("#themes"), statusEl = $("#status"), explainEl = $("#explain");
  var dinfoEl = $("#dinfo"), dailyOnly = $("#daily-only"), poolOnly = $("#pool-only");

  /* ---------- 日期工具 ---------- */
  function dateKey(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function yesterdayKey() { return dateKey(new Date(Date.now() - 864e5)); }
  function hashInt(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  /* 每日残局：按日期哈希从题库确定性取题（每天不同；题库不变则每天唯一） */
  function dailyPuzzle() {
    var pool = puzzles.filter(function (p) { return p.tier === "beginner" || p.tier === "elementary"; });
    if (!pool.length) return null;
    var idx = hashInt("d:" + dateKey()) % pool.length;
    return pool[idx];
  }

  /* ---------- 连击 streak ---------- */
  function loadStreak() {
    try { streak = JSON.parse(localStorage.getItem("tactics.streak")) || { cur: 0, best: 0, last: "" }; } catch (e) { streak = { cur: 0, best: 0, last: "" }; }
    // 若上次做题不是昨天/今天，视为断签
    var today = dateKey(), yest = yesterdayKey();
    if (streak.last && streak.last !== today && streak.last !== yest) streak.cur = 0;
  }
  function saveStreak() { try { localStorage.setItem("tactics.streak", JSON.stringify(streak)); } catch (e) {} }
  function bumpStreak() {
    var today = dateKey();
    if (streak.last === today) return;   // 今天已计
    streak.cur = (streak.last === yesterdayKey()) ? streak.cur + 1 : 1;
    streak.best = Math.max(streak.best, streak.cur);
    streak.last = today;
    saveStreak();
  }
  function renderStreak() {
    $("#streak-cur").textContent = streak.cur;
    $("#streak-best").textContent = streak.best;
    $("#badges").innerHTML = BADGES.map(function (b) {
      return '<span class="badge' + (streak.best >= b.d ? " unlocked" : "") + '">' + b.n + " " + b.d + "天</span>";
    }).join("");
  }

  /* ---------- 题库过滤 ---------- */
  function tierRaw() { return puzzles.filter(function (p) { return p.tier === tier; }); }
  function tierPuzzles() {
    var list = tierRaw();
    if (filterSel.size) list = list.filter(function (p) { return p.themes.some(function (t) { return filterSel.has(t); }); });
    if (rMin != null) list = list.filter(function (p) { return p.rating >= rMin; });
    if (rMax != null) list = list.filter(function (p) { return p.rating <= rMax; });
    return list;
  }
  function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = cls || ""; }

  /* ---------- 渲染 ---------- */
  function renderTiers() {
    tiersEl.innerHTML = TIERS.map(function (t) {
      return '<button class="tier-btn' + (t.key === tier ? " active" : "") + '" data-t="' + t.key + '">' + t.label + "</button>";
    }).join("");
    tiersEl.querySelectorAll(".tier-btn").forEach(function (b) {
      b.onclick = function () { tier = b.dataset.t; loadSolved(); renderTiers(); buildChips(); render(); };
    });
  }
  function buildChips() {
    var counts = {};
    tierRaw().forEach(function (p) {
      p.themes.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var top = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 14);
    var el = document.getElementById("theme-chips"); if (!el) return;
    el.innerHTML = top.map(function (t) {
      var act = filterSel.has(t) ? " active" : "";
      return '<span class="theme-chip' + act + '" data-th="' + t + '">' + cn(t) + '<span class="cnt">' + counts[t] + "</span></span>";
    }).join("");
    el.querySelectorAll(".theme-chip").forEach(function (c) {
      c.onclick = function () {
        var t = c.dataset.th;
        if (filterSel.has(t)) filterSel.delete(t); else filterSel.add(t);
        buildChips(); render();
      };
    });
  }

  function render() {
    if (tab === "daily") { renderDaily(); return; }
    var raw = tierRaw().length;
    var list = tierPuzzles(); total = list.length;
    var done = Object.keys(solved).filter(function (k) { return solved[k]; }).length;
    progEl.style.width = (total ? done / total * 100 : 0) + "%";
    pinfo.textContent = "已完成 " + done + " / " + total + " 题" +
      (raw !== total ? "（筛选后，共 " + raw + "）" : "") + " · 评分 " +
      (total ? Math.min.apply(null, list.map(function (x) { return x.rating; })) : "?") + "-" +
      (total ? Math.max.apply(null, list.map(function (x) { return x.rating; })) : "?");
    if (!list.length) { setStatus("当前筛选无结果，请放宽条件", "bad"); return; }
    loadPuzzle(firstUnsolved() || list[0]);
  }

  function renderDaily() {
    var p = dailyPuzzle();
    if (!p) { setStatus("题库为空", "bad"); return; }
    var done = daily[p.id] ? "✔ 今日已完成" : "今日未完成";
    dinfoEl.textContent = dateKey() + " · " + done + " · 难度分 " + p.rating;
    loadPuzzle(p);
  }

  function loadSolved() {
    try { solved = JSON.parse(localStorage.getItem("tactics." + tier) || "{}"); } catch (e) { solved = {}; }
    try { daily = JSON.parse(localStorage.getItem("tactics.daily") || "{}"); } catch (e) { daily = {}; }
  }
  function saveSolved() {
    try { localStorage.setItem("tactics." + tier, JSON.stringify(solved)); } catch (e) {}
    try { localStorage.setItem("tactics.daily", JSON.stringify(daily)); } catch (e) {}
  }
  function firstUnsolved() {
    var list = tierPuzzles();
    for (var i = 0; i < list.length; i++) if (!solved[list[i].id]) return list[i];
    return null;
  }

  /* ---------- 棋盘 ---------- */
  function clearHl() {
    boardEl.querySelectorAll(".tac-hl-from, .tac-hl-to").forEach(function (el) {
      el.classList.remove("tac-hl-from", "tac-hl-to");
    });
  }
  function highlightMove(uci) {
    clearHl();
    if (!uci) return;
    var f = boardEl.querySelector('[data-square="' + uci.slice(0, 2) + '"]');
    var t = boardEl.querySelector('[data-square="' + uci.slice(2, 4) + '"]');
    if (f) f.classList.add("tac-hl-from");
    if (t) t.classList.add("tac-hl-to");
  }
  function loadPuzzle(p) {
    cur = p; moveIdx = 0;
    game = new Chess(p.fen);
    var orient = game.turn() === "w" ? "white" : "black";
    if (board) board.destroy();
    clearHl();
    board = Chessboard("board", {
      draggable: true, position: p.fen, orientation: orient,
      pieceTheme: "img/chesspieces/wikipedia/{piece}.png",
      onDrop: onDrop,
    });
    ptitle.textContent = tab === "daily" ? "今日残局 · " + cn(p.theme) : "题型 · " + cn(p.theme);
    themesEl.innerHTML = (p.themes || []).slice(0, 6).map(function (t) {
      return '<span class="tag">' + cn(t) + "</span>";
    }).join("");
    setStatus(orient === "white" ? "白方先走，找出最佳着法" : "黑方先走，找出最佳着法", "");
    explainEl.textContent = "";
  }

  function applyUci(uci) {
    var m = { from: uci.slice(0, 2), to: uci.slice(2, 4) };
    if (uci.length > 4) m.promotion = uci[4];
    var mv = game.move(m);
    if (mv) board.position(game.fen());
    return mv;
  }

  function onDrop(source, target) {
    var expected = cur.moves[moveIdx];
    var legal = game.moves({ verbose: true }).filter(function (m) { return m.from === source && m.to === target; });
    if (!legal.length) return "snapback";
    var ok = legal.some(function (m) { return (m.from + m.to + (m.promotion || "")) === expected; });
    if (!ok && (cur.themes || []).indexOf("mateIn1") >= 0 && moveIdx === 0) {
      var probe = new Chess(game.fen());
      var pm = probe.move({ from: source, to: target, promotion: "q" });
      if (pm && probe.in_checkmate()) ok = true;
    }
    if (!ok) {
      setStatus("不对，再想想（" + cn(cur.theme) + "）", "bad");
      explainEl.textContent = "提示：当前轮到" + (game.turn() === "w" ? "白方" : "黑方") + "，点击「提示」可高亮正确走法。";
      return "snapback";
    }
    clearHl();
    applyUci(expected);
    moveIdx++;
    if (game.in_checkmate()) { finish(true); return; }
    setStatus("正确，继续…", "good");
    var reply = cur.moves[moveIdx];
    if (reply) {
      moveIdx++;
      setTimeout(function () {
        applyUci(reply);
        setStatus("轮到" + (game.turn() === "w" ? "白方" : "黑方") + "，继续", "");
      }, 420);
    } else finish(true);
    return "snapback";
  }

  function finish() {
    var isDaily = tab === "daily";
    if (isDaily) daily[cur.id] = dateKey(); else solved[cur.id] = 1;
    saveSolved();
    bumpStreak(); renderStreak();
    var main = cn(cur.theme);
    var extra = isDaily ? " 连击 +1 🔥" : "";
    setStatus("✔ 解题成功！" + extra, "good");
    explainEl.innerHTML = "<b style='color:var(--signal)'>题型讲解</b><br>本题主题：" +
      (cur.themes || []).map(function (t) { return cn(t); }).join("、") +
      "<br><span style='color:var(--faint)'>难度分 " + cur.rating + "</span><br><br>来源：lichess 题库（解法为引擎验证的唯一最优解）" +
      (isDaily ? "<br>每日残局按日期换题，明天再来一题。" : "");
    $("#btn-next").textContent = isDaily ? "下一题（题库）" : "下一题 →";
  }

  /* ---------- 事件 ---------- */
  function bindTabs() {
    document.querySelectorAll(".tab").forEach(function (b) {
      b.onclick = function () {
        tab = b.dataset.tab;
        document.querySelectorAll(".tab").forEach(function (x) { x.classList.toggle("active", x === b); });
        poolOnly.style.display = tab === "pool" ? "flex" : "none";
        dailyOnly.style.display = tab === "daily" ? "flex" : "none";
        render();
      };
    });
  }
  $("#btn-hint").onclick = function () {
    if (!cur) return;
    var next = cur.moves[moveIdx];
    highlightMove(next);
    explainEl.innerHTML = "<b>提示</b><br>题型：" + cn(cur.theme) +
      "<br>轮到" + (game.turn() === "w" ? "白方" : "黑方") + "，棋盘上已高亮正确走法（蓝色=起点，黄色=终点）。" +
      "<br><span style='color:var(--faint)'>下一步：" + (next || "（即将完成）") + "</span>";
  };
  $("#btn-retry").onclick = function () { if (cur) loadPuzzle(cur); };
  $("#btn-next").onclick = function () {
    if (tab === "daily") {
      // 切到题库并出下一题
      document.querySelector('.tab[data-tab="pool"]').click();
      render();
      return;
    }
    var list = tierPuzzles();
    var i = list.indexOf(cur);
    var next = null;
    for (var k = i + 1; k < list.length + i; k++) {
      var cand = list[k % list.length];
      if (!solved[cand.id]) { next = cand; break; }
    }
    if (next) loadPuzzle(next); else render();
  };

  /* ---------- 初始化 ---------- */
  fetch("data/puzzles.json").then(function (r) { return r.json(); }).then(function (d) {
    puzzles = d.puzzles || [];
    if (!puzzles.length) { setStatus("题库为空", "bad"); return; }
    loadSolved(); loadStreak(); renderStreak(); bindTabs(); renderTiers(); buildChips(); render();
  }).catch(function (e) { setStatus("题库加载失败：" + e, "bad"); });
})();
