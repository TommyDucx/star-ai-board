// tactics.js — 国际象棋题型练习（难度阶梯 + 棋盘交互 + 进度存档）
(function () {
  "use strict";
  var TIERS = [
    { key: "beginner", label: "入门", desc: "一步杀 · 底线杀 · 双重攻击 · 牵制" },
    { key: "elementary", label: "初级", desc: "两步杀 · 骑士叉 · 闪击 · 牵制获利" },
    { key: "intermediate", label: "中级", desc: "串击 · 双将 · 消除防御 · 引离" },
    { key: "advanced", label: "高级", desc: "闷杀 · 三步杀 · 弃子攻杀 · 残局技术" },
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
    middlegame: "中局", opening: "开局", oneMove: "单步", equality: "均势", endgameKnight: "马残局",
  };
  function cn(t) { return THEME_CN[t] || t; }
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var board = null, game = null, puzzles = [], tier = "beginner";
  var solved = {}, cur = null, moveIdx = 0, total = 0;

  var boardEl = $("#board"), tiersEl = $("#tiers"), progEl = $("#prog"), pinfo = $("#pinfo");
  var ptitle = $("#ptitle"), themesEl = $("#themes"), statusEl = $("#status"), explainEl = $("#explain");

  function loadSolved() {
    try { solved = JSON.parse(localStorage.getItem("tactics." + tier) || "{}"); } catch (e) { solved = {}; }
  }
  function saveSolved() { try { localStorage.setItem("tactics." + tier, JSON.stringify(solved)); } catch (e) {} }
  function tierPuzzles() { return puzzles.filter(function (p) { return p.tier === tier; }); }
  function firstUnsolved() {
    var list = tierPuzzles();
    for (var i = 0; i < list.length; i++) if (!solved[list[i].id]) return list[i];
    return null;
  }
  function setStatus(msg, cls) { statusEl.textContent = msg; statusEl.className = cls || ""; }

  function renderTiers() {
    tiersEl.innerHTML = TIERS.map(function (t) {
      return '<button class="tier-btn' + (t.key === tier ? " active" : "") + '" data-t="' + t.key + '">' + t.label + "</button>";
    }).join("");
    tiersEl.querySelectorAll(".tier-btn").forEach(function (b) {
      b.onclick = function () { tier = b.dataset.t; loadSolved(); renderTiers(); render(); };
    });
  }

  function loadPuzzle(p) {
    cur = p; moveIdx = 0;
    game = new Chess(p.fen);
    var orient = game.turn() === "w" ? "white" : "black";
    if (board) board.destroy();
    board = Chessboard("board", {
      draggable: true, position: p.fen, orientation: orient,
      pieceTheme: "img/chesspieces/wikipedia/{piece}.png",
      onDrop: onDrop,
    });
    ptitle.textContent = "题型 · " + cn(p.theme);
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
    var uci = source + target;
    var legal = game.moves({ verbose: true }).filter(function (m) { return m.from === source && m.to === target; });
    if (!legal.length) return "snapback";
    var ok = legal.some(function (m) { return (m.from + m.to + (m.promotion || "")) === expected; });
    // mateIn1 允许任意将死着法
    if (!ok && (cur.themes || []).indexOf("mateIn1") >= 0 && moveIdx === 0) {
      var probe = new Chess(game.fen());
      var pm = probe.move({ from: source, to: target, promotion: "q" });
      if (pm && probe.in_checkmate()) ok = true;
    }
    if (!ok) {
      setStatus("不对，再想想（" + cn(cur.theme) + "）", "bad");
      explainEl.textContent = "提示：" + cn(cur.theme) + " — 当前轮到" + (game.turn() === "w" ? "白方" : "黑方") + "。";
      return "snapback";
    }
    applyUci(expected);
    moveIdx++;
    if (game.in_checkmate()) { finish(true); return; }
    setStatus("正确，继续…", "good");
    var reply = cur.moves[moveIdx];
    if (reply) { moveIdx++; setTimeout(function () { applyUci(reply); setStatus("轮到" + (game.turn() === "w" ? "白方" : "黑方") + "，继续", ""); }, 420); }
    else finish(true);
    return "snapback";
  }

  function finish() {
    solved[cur.id] = 1; saveSolved();
    var done = Object.keys(solved).filter(function (k) { return solved[k]; }).length;
    progEl.style.width = (total ? done / total * 100 : 0) + "%";
    pinfo.textContent = "已完成 " + done + " / " + total + " 题";
    var list = tierPuzzles();
    var remaining = list.filter(function (p) { return !solved[p.id]; }).length;
    setStatus("✔ 解题成功！" + (remaining ? " 本档还剩 " + remaining + " 题" : " 本档全部完成！"), "good");
    explainEl.innerHTML = "<b style='color:var(--signal)'>题型讲解</b><br>本题主题：" +
      (cur.themes || []).map(function (t) { return cn(t); }).join("、") +
      "<br><span style='color:var(--faint)'>难度分 " + cur.rating + "</span><br><br>来源：lichess 题库（解法为引擎验证的唯一最优解）";
    $("#btn-next").textContent = remaining ? "下一题 →" : "换档练习";
  }

  function render() {
    var list = tierPuzzles(); total = list.length;
    var done = Object.keys(solved).filter(function (k) { return solved[k]; }).length;
    progEl.style.width = (total ? done / total * 100 : 0) + "%";
    pinfo.textContent = "已完成 " + done + " / " + total + " 题";
    var p = firstUnsolved() || list[0];
    if (!p) { setStatus("本档暂无题目", "bad"); return; }
    loadPuzzle(p);
  }

  $("#btn-hint").onclick = function () {
    if (!cur) return;
    explainEl.innerHTML = "<b>提示</b><br>题型：" + cn(cur.theme) +
      "<br>轮到" + (game.turn() === "w" ? "白方" : "黑方") + "，寻找能扩大优势/将杀的着法。" +
      "<br><span style='color:var(--faint)'>下一步预期：" + (cur.moves[moveIdx] || "（即将完成）") + "</span>";
  };
  $("#btn-retry").onclick = function () { if (cur) loadPuzzle(cur); };
  $("#btn-next").onclick = function () {
    var list = tierPuzzles();
    var i = list.indexOf(cur);
    var next = null;
    for (var k = i + 1; k < list.length + i; k++) {
      var cand = list[k % list.length];
      if (!solved[cand.id]) { next = cand; break; }
    }
    if (next) loadPuzzle(next); else render();
  };

  fetch("data/puzzles.json").then(function (r) { return r.json(); }).then(function (d) {
    puzzles = d.puzzles || [];
    if (!puzzles.length) { setStatus("题库为空", "bad"); return; }
    loadSolved(); renderTiers(); render();
  }).catch(function (e) { setStatus("题库加载失败：" + e, "bad"); });
})();
