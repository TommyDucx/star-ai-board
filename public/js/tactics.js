// tactics.js v4 — 账号绑定的关卡闯关、连胜、称号同步
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
    middlegame: "中局", opening: "开局", oneMove: "单步", equality: "均势",
    advantage: "优势", master: "大师", trade: "兑子", endgameKnight: "马残局",
  };
  function cn(t) { return THEME_CN[t] || t; }
  function qs(s, r) { return (r || document).querySelector(s); }

  var board = null, game = null, puzzles = [], tier = "beginner", tab = "level";
  var cur = null, moveIdx = 0, daily = {}, prog = null, LEVELS = 50;
  var guest = false, attemptId = null, attemptLevel = 0, submitting = false, solvedCurrent = false;

  var boardEl = qs("#board"), tiersEl = qs("#tiers"), progEl = qs("#prog"), pinfo = qs("#pinfo");
  var ptitle = qs("#ptitle"), themesEl = qs("#themes"), statusEl = qs("#status"), explainEl = qs("#explain");
  var dinfoEl = qs("#dinfo"), dailyOnly = qs("#daily-only"), levelOnly = qs("#level-only");
  var titlesBar = qs("#titles-bar"), streakCur = qs("#streak-cur"), streakBest = qs("#streak-best"), totalPassEl = qs("#total-pass");

  function titleDefs() {
    return [
      { id: "t10", type: "total_pass", target: 10, name: "战术新兵", desc: "累计过关 10 关" },
      { id: "t50", type: "total_pass", target: 50, name: "战术精兵", desc: "累计过关 50 关" },
      { id: "t100", type: "total_pass", target: 100, name: "战术士官", desc: "累计过关 100 关" },
      { id: "t200", type: "total_pass", target: 200, name: "战术军官", desc: "累计过关 200 关" },
      { id: "c3", type: "best_streak", target: 3, name: "三连胜", desc: "任意档达成 3 连胜" },
      { id: "c5", type: "best_streak", target: 5, name: "五连胜", desc: "任意档达成 5 连胜" },
      { id: "c10", type: "best_streak", target: 10, name: "十连胜", desc: "任意档达成 10 连胜" },
      { id: "g1", type: "tier_clear", tier: "beginner", target: 50, name: "入门毕业", desc: "通关「入门」全部 50 关" },
      { id: "g2", type: "tier_clear", tier: "elementary", target: 50, name: "初级毕业", desc: "通关「初级」全部 50 关" },
      { id: "g3", type: "tier_clear", tier: "intermediate", target: 50, name: "中级毕业", desc: "通关「中级」全部 50 关" },
      { id: "g4", type: "tier_clear", tier: "advanced", target: 50, name: "高级宗师", desc: "通关「高级」全部 50 关" },
    ];
  }
  function defaultTier() {
    return { currentLevel: 1, passedLevels: [], failedLevels: [], passed: 0, totalPassed: 0, currentStreak: 0, bestStreak: 0, combo: 0, bestCombo: 0, fails: 0 };
  }
  function emptyProg() {
    var tiers = {};
    TIERS.forEach(function (x) { tiers[x.key] = defaultTier(); });
    return { schemaVersion: 2, selectedTier: "beginner", tiers: tiers, titles: {}, stats: {}, titleDefs: titleDefs(), levelsPerTier: LEVELS };
  }
  function tierProg(k) {
    if (!prog) prog = emptyProg();
    if (!prog.tiers) prog.tiers = {};
    if (!prog.tiers[k]) prog.tiers[k] = defaultTier();
    return prog.tiers[k];
  }
  function passedCount(k) {
    var t = tierProg(k);
    return Array.isArray(t.passedLevels) ? t.passedLevels.length : +(t.totalPassed || t.passed || 0);
  }
  function currentLevel(k) {
    var t = tierProg(k);
    return Math.max(1, Math.min(LEVELS + 1, +(t.currentLevel || passedCount(k) + 1)));
  }
  function totalPass() {
    if (prog && prog.stats && prog.stats.totalPassedAllTiers != null) return +prog.stats.totalPassedAllTiers || 0;
    return TIERS.reduce(function (s, x) { return s + passedCount(x.key); }, 0);
  }
  function bestStreak() {
    if (prog && prog.stats && prog.stats.bestStreakAllTiers != null) return +prog.stats.bestStreakAllTiers || 0;
    return Math.max.apply(null, TIERS.map(function (x) { return +(tierProg(x.key).bestStreak || tierProg(x.key).bestCombo || 0); }));
  }
  function currentStreak() {
    var t = tierProg(tier);
    return +(t.currentStreak || t.combo || 0);
  }
  function titleState(id) {
    if (!prog || !prog.titles) return null;
    if (Array.isArray(prog.titles)) return { unlocked: prog.titles.indexOf(id) >= 0 };
    return prog.titles[id] || null;
  }
  function calcTitleProgress(rule) {
    if (rule.type === "total_pass" || rule.need === "pass") return Math.min(totalPass(), rule.target || rule.at || 0);
    if (rule.type === "best_streak" || rule.need === "combo") return Math.min(bestStreak(), rule.target || rule.at || 0);
    if (rule.type === "tier_clear") return Math.min(passedCount(rule.tier), rule.target || LEVELS);
    if (rule.need === "tier") return passedCount(TIERS[rule.at] && TIERS[rule.at].key) >= LEVELS ? 1 : 0;
    return 0;
  }

  function dateKey(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function hashInt(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }
  function dailyPuzzle() {
    var pool = puzzles.filter(function (p) { return p.tier === "beginner" || p.tier === "elementary"; });
    return pool.length ? pool[hashInt("d:" + dateKey()) % pool.length] : null;
  }

  function apiFetch(path, opts) {
    return fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {})).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    });
  }
  function loadLocal() {
    try {
      var v = JSON.parse(localStorage.getItem("tactics.progress") || "null");
      if (v && v.tiers) { prog = v; return; }
    } catch (e) {}
    prog = emptyProg();
  }
  function saveLocal() {
    try { localStorage.setItem("tactics.progress", JSON.stringify(prog)); } catch (e) {}
  }
  function syncFromServer() {
    return apiFetch("/api/tactics/progress").then(function (r) {
      if (r.ok && r.data.progress) {
        prog = r.data.progress;
        LEVELS = prog.levelsPerTier || LEVELS;
        if (prog.tiersDef && prog.tiersDef.length) TIERS = prog.tiersDef;
        tier = prog.selectedTier || tier;
        guest = false;
        return true;
      }
      guest = true;
      loadLocal();
      return false;
    });
  }

  function localPuzzleForTier(k) {
    var level = currentLevel(k);
    if (level > LEVELS) return null;
    var pool = puzzles.filter(function (p) { return p.tier === k; });
    return pool[Math.min(level - 1, pool.length - 1)] || null;
  }
  function localUnlockTitles(before) {
    var newly = [];
    (prog.titleDefs || titleDefs()).forEach(function (rule) {
      var st = titleState(rule.id) || {};
      var target = rule.target || rule.at || 1;
      var progress = calcTitleProgress(rule);
      if (!prog.titles || Array.isArray(prog.titles)) prog.titles = {};
      prog.titles[rule.id] = Object.assign(st, { progress: progress, target: target, condition: rule.desc });
      if (!st.unlocked && progress >= target) {
        prog.titles[rule.id].unlocked = true;
        prog.titles[rule.id].unlockedAt = Date.now();
      }
      if (!(before[rule.id]) && prog.titles[rule.id].unlocked) newly.push(rule.id);
    });
    return newly;
  }
  function applyLocal(solved) {
    var t = tierProg(tier);
    var level = currentLevel(tier);
    var before = {};
    Object.keys(prog.titles || {}).forEach(function (id) {
      var st = titleState(id);
      before[id] = st && st.unlocked;
    });
    if (solved) {
      if (!Array.isArray(t.passedLevels)) t.passedLevels = [];
      if (t.passedLevels.indexOf(level) < 0) t.passedLevels.push(level);
      t.totalPassed = t.passed = t.passedLevels.length;
      t.currentLevel = Math.min(LEVELS + 1, level + 1);
      t.currentStreak = (t.currentStreak || t.combo || 0) + 1;
      t.bestStreak = Math.max(t.bestStreak || t.bestCombo || 0, t.currentStreak);
      t.combo = t.currentStreak; t.bestCombo = t.bestStreak;
    } else {
      if (!Array.isArray(t.failedLevels)) t.failedLevels = [];
      if (t.failedLevels.indexOf(level) < 0) t.failedLevels.push(level);
      t.fails = (t.fails || 0) + 1;
      t.currentStreak = 0; t.combo = 0;
    }
    prog.stats = null;
    prog.stats = { totalPassedAllTiers: totalPass(), bestStreakAllTiers: bestStreak() };
    var newly = localUnlockTitles(before);
    saveLocal();
    return newly;
  }

  function setStatus(txt, cls) {
    statusEl.textContent = txt;
    statusEl.className = cls || "";
  }
  function renderTiers() {
    tiersEl.innerHTML = TIERS.map(function (x) {
      var passed = passedCount(x.key);
      var done = passed >= LEVELS;
      return '<button class="tier-btn' + (x.key === tier ? " active" : "") + '" data-t="' + x.key + '" title="' + x.desc + '">' +
        x.label + '<span class="lv">' + (done ? "全通" : passed + " / " + LEVELS) + "</span></button>";
    }).join("");
    tiersEl.querySelectorAll(".tier-btn").forEach(function (b) {
      b.onclick = function () {
        tier = b.dataset.t;
        if (prog) prog.selectedTier = tier;
        attemptId = null;
        renderAll();
        loadActivePuzzle();
      };
    });
  }
  function renderTitles() {
    var defs = prog.titleDefs || titleDefs();
    titlesBar.innerHTML = defs.map(function (rule) {
      var st = titleState(rule.id) || {};
      var unlocked = !!st.unlocked;
      var target = rule.target || rule.at || 1;
      var progress = st.progress != null ? st.progress : calcTitleProgress(rule);
      return '<span class="title-chip' + (unlocked ? " unlocked" : "") + '" title="' + (rule.desc || st.condition || "") + '">' +
        (unlocked ? "★ " : "") + rule.name + (unlocked ? "" : '<span class="mini">' + Math.min(progress, target) + "/" + target + "</span>") +
        "</span>";
    }).join("");
  }
  function renderStats() {
    var t = tierProg(tier);
    streakCur.textContent = currentStreak();
    streakBest.textContent = Math.max(bestStreak(), +(t.bestStreak || t.bestCombo || 0));
    totalPassEl.textContent = totalPass();
    progEl.style.width = Math.min(100, passedCount(tier) / LEVELS * 100) + "%";
    var level = currentLevel(tier);
    pinfo.textContent = (level > LEVELS ? "本档全部通关" : "第 " + level + " / " + LEVELS + " 关") +
      " · 失败 " + (t.fails || 0) + " 次 · " + (guest ? "游客本机记录" : "账号同步");
  }
  function renderAll() {
    renderTiers();
    renderStats();
    renderTitles();
  }

  function loadActivePuzzle() {
    if (tab === "daily") { renderDaily(); return; }
    renderAll();
    if (currentLevel(tier) > LEVELS) { loadPuzzle(null, true); return; }
    if (guest) {
      attemptId = "guest-" + Date.now();
      attemptLevel = currentLevel(tier);
      loadPuzzle(localPuzzleForTier(tier));
      return;
    }
    setStatus("读取账号进度…", "");
    apiFetch("/api/tactics/attempt/start", { method: "POST", body: JSON.stringify({ tier: tier }) }).then(function (r) {
      if (!r.ok) {
        setStatus(r.data.error || "无法开始当前关", "bad");
        if (r.data.progress) { prog = r.data.progress; renderAll(); }
        return;
      }
      prog = r.data.progress;
      LEVELS = prog.levelsPerTier || LEVELS;
      attemptId = r.data.attemptId;
      attemptLevel = r.data.levelNo;
      solvedCurrent = false;
      renderAll();
      loadPuzzle(r.data.puzzle);
    }).catch(function (e) { setStatus("读取关卡失败：" + e, "bad"); });
  }

  function renderDaily() {
    var p = dailyPuzzle();
    if (!p) { setStatus("题库为空", "bad"); return; }
    var doneToday = daily[p.id] === dateKey();
    dinfoEl.textContent = dateKey() + " · " + (doneToday ? "今日已完成" : "今日未完成") + " · 难度分 " + p.rating;
    loadPuzzle(p, false, true);
  }
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
  function loadPuzzle(p, isTierDone, isDaily) {
    cur = p; moveIdx = 0; solvedCurrent = false;
    qs("#btn-next").disabled = false;
    qs("#btn-next").textContent = isDaily ? "返回闯关" : "下一关";
    if (isTierDone) {
      game = null;
      if (board) board.destroy();
      board = Chessboard("board", { draggable: false, position: "start", pieceTheme: "img/chesspieces/wikipedia/{piece}.png" });
      ptitle.textContent = "本档通关";
      themesEl.innerHTML = "";
      setStatus("已通关「" + TIERS.filter(function (x) { return x.key === tier; })[0].label + "」全部 " + LEVELS + " 关，可切换其他难度继续。", "good");
      explainEl.textContent = "";
      return;
    }
    if (!p) { setStatus("题库为空", "bad"); return; }
    game = new Chess(p.fen);
    var orient = game.turn() === "w" ? "white" : "black";
    if (board) board.destroy();
    board = Chessboard("board", {
      draggable: true, position: p.fen, orientation: orient,
      pieceTheme: "img/chesspieces/wikipedia/{piece}.png",
      onDrop: onDrop,
    });
    ptitle.textContent = (isDaily ? "今日残局 · " : "第 " + currentLevel(tier) + " 关 · ") + cn(p.theme);
    themesEl.innerHTML = (p.themes || []).slice(0, 6).map(function (t) { return '<span class="tag">' + cn(t) + "</span>"; }).join("");
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
  function legalUci(source, target) {
    var moves = game.moves({ verbose: true }).filter(function (m) { return m.from === source && m.to === target; });
    return moves.length ? moves[0].from + moves[0].to + (moves[0].promotion || "") : "";
  }
  function onDrop(source, target) {
    if (!cur || solvedCurrent || submitting) return "snapback";
    var expected = cur.moves[moveIdx];
    var played = legalUci(source, target);
    if (!played) return "snapback";
    var ok = played === expected;
    if (!ok && (cur.themes || []).indexOf("mateIn1") >= 0 && moveIdx === 0) {
      var probe = new Chess(game.fen());
      var pm = probe.move({ from: source, to: target, promotion: "q" });
      if (pm && probe.in_checkmate()) ok = true;
    }
    if (!ok) {
      if (tab === "level") submitAttempt(false, [played]);
      else setStatus("不对，再想想（" + cn(cur.theme) + "）", "bad");
      explainEl.textContent = "提示：当前轮到" + (game.turn() === "w" ? "白方" : "黑方") + "，点击「提示」可高亮正确走法。";
      return "snapback";
    }
    clearHl();
    applyUci(expected);
    moveIdx++;
    if (game.in_checkmate()) { finish(); return "snapback"; }
    setStatus("正确，继续…", "good");
    var reply = cur.moves[moveIdx];
    if (reply) {
      moveIdx++;
      setTimeout(function () {
        applyUci(reply);
        setStatus("轮到" + (game.turn() === "w" ? "白方" : "黑方") + "，继续", "");
      }, 420);
    } else finish();
    return "snapback";
  }
  function titleNames(ids) {
    var defs = prog.titleDefs || titleDefs();
    return (ids || []).map(function (id) {
      var d = defs.filter(function (x) { return x.id === id; })[0];
      return d ? d.name : id;
    }).join("、");
  }
  function submitAttempt(solved, moves) {
    if (submitting || solvedCurrent) return;
    submitting = true;
    setStatus(solved ? "判定中…" : "走错了，本关失败，连胜清零。", solved ? "" : "bad");
    var done = function (newly) {
      submitting = false;
      renderAll();
      var t = tierProg(tier);
      var titleNote = newly && newly.length ? " 新称号：★ " + titleNames(newly) : "";
      if (solved) {
        solvedCurrent = true;
        setStatus((currentLevel(tier) > LEVELS ? "本档通关！" : "第 " + attemptLevel + " 关通过，连胜 " + (t.currentStreak || t.combo || 0)) + titleNote, "good");
        explainEl.innerHTML = "<b style='color:var(--signal)'>题型讲解</b><br>本题主题：" +
          (cur.themes || []).map(function (x) { return cn(x); }).join("、") +
          "<br><span style='color:var(--faint)'>难度分 " + cur.rating + "</span><br><br>" +
          (guest ? "<span style='color:var(--faint)'>当前未登录，进度仅保存在本机。登录后可跨设备同步。</span>" : "进度、连胜和称号已同步到账号。");
      } else {
        loadPuzzle(cur);
      }
    };
    if (guest) {
      done(applyLocal(solved));
      return;
    }
    apiFetch("/api/tactics/attempt/submit", {
      method: "POST",
      body: JSON.stringify({ attemptId: attemptId, tier: tier, levelNo: attemptLevel, moves: solved ? cur.moves : moves }),
    }).then(function (r) {
      if (r.ok && r.data.progress) {
        prog = r.data.progress;
        done(r.data.newly || []);
      } else {
        submitting = false;
        setStatus((r.data && r.data.error) || "提交失败", "bad");
      }
    }).catch(function (e) {
      submitting = false;
      setStatus("提交失败：" + e, "bad");
    });
  }
  function finish() {
    if (tab === "daily") {
      daily[cur.id] = dateKey();
      try { localStorage.setItem("tactics.daily", JSON.stringify(daily)); } catch (e) {}
      setStatus("今日残局完成", "good");
      explainEl.innerHTML = "<b style='color:var(--signal)'>题型讲解</b><br>本题主题：" +
        (cur.themes || []).map(function (t) { return cn(t); }).join("、") +
        "<br><span style='color:var(--faint)'>难度分 " + cur.rating + "</span><br><br>来源：lichess 题库";
      qs("#btn-next").textContent = "返回闯关";
      return;
    }
    submitAttempt(true, cur.moves);
  }
  function bindTabs() {
    document.querySelectorAll(".tab").forEach(function (b) {
      b.onclick = function () {
        tab = b.dataset.tab;
        document.querySelectorAll(".tab").forEach(function (x) { x.classList.toggle("active", x === b); });
        levelOnly.style.display = tab === "level" ? "flex" : "none";
        dailyOnly.style.display = tab === "daily" ? "flex" : "none";
        if (tab === "daily") renderDaily(); else loadActivePuzzle();
      };
    });
  }
  qs("#btn-hint").onclick = function () {
    if (!cur || !game) return;
    var next = cur.moves[moveIdx];
    highlightMove(next);
    explainEl.innerHTML = "<b>提示</b><br>题型：" + cn(cur.theme) +
      "<br>轮到" + (game.turn() === "w" ? "白方" : "黑方") + "，棋盘上已高亮正确走法（蓝=起点，黄=终点）。" +
      "<br><span style='color:var(--faint)'>下一步：" + (next || "即将完成") + "</span>";
  };
  qs("#btn-retry").onclick = function () {
    if (cur) loadPuzzle(cur, false, tab === "daily");
  };
  qs("#btn-next").onclick = function () {
    if (tab === "daily") {
      document.querySelector('.tab[data-tab="level"]').click();
      return;
    }
    attemptId = null;
    loadActivePuzzle();
  };

  fetch("data/puzzles.json").then(function (r) { return r.json(); }).then(function (d) {
    puzzles = d.puzzles || [];
    if (!puzzles.length) { setStatus("题库为空", "bad"); return; }
    return apiFetch("/api/tactics/config").then(function (cfg) {
      if (cfg.ok) {
        TIERS = (cfg.data.tiers || TIERS).map(function (t) { return { key: t.key, label: t.label, desc: t.desc || "", levels: t.levels || LEVELS }; });
        LEVELS = cfg.data.levelsPerTier || LEVELS;
      }
      return apiFetch("/api/me").then(function (me) {
        if (me.ok) return syncFromServer();
        guest = true;
        loadLocal();
        return false;
      });
    });
  }).then(function () {
    try { daily = JSON.parse(localStorage.getItem("tactics.daily") || "{}"); } catch (e) { daily = {}; }
    bindTabs();
    renderAll();
    loadActivePuzzle();
  }).catch(function (e) { setStatus("初始化失败：" + e, "bad"); });
})();
