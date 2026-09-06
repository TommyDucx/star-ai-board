/* 共享棋谱库：公共目录 + 账号研读架。所有写操作仍由 server 端 userId 决定。 */
(function () {
  "use strict";
  var root, state = { page:1, category:"all", sort:"new", q:"", me:null, seq:0, notice:"" };
  var categories = [];
  function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]; }); }
  function date(value) { try { return new Intl.DateTimeFormat("zh-CN", { month:"short", day:"numeric" }).format(new Date(value)); } catch (e) { return "--"; } }
  function category(id) { return categories.filter(function (x) { return x.id === id; })[0] || { name:"未分类", mark:"--" }; }
  function request(url, options) {
    return fetch(url, options).then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { res:res, data:data }; }); });
  }
  function notice(message) { state.notice = message || ""; var target = root && root.querySelector(".library-status"); if (target) target.textContent = state.notice; }
  function authRequired() {
    if (state.me) return true;
    notice("登录后可收藏、投稿和讨论。");
    return false;
  }
  function shell() {
    return '<section class="library-shell">' +
      '<div class="library-hero"><div><div class="library-kicker">SHARED GAME LIBRARY / 第四模块</div><h1>共享棋谱库</h1><p>把一盘棋的关键判断留成可检索的索引。找得到、读得懂，也能收藏到自己的研读架。</p></div><div class="library-index">DIR / 分类检索<br>PGN / 可复制下载<br>NOTE / 交流与投稿</div></div>' +
      '<div id="library-body"></div></section>';
  }
  function card(entry) {
    var c = category(entry.category);
    return '<button class="library-card" type="button" data-entry="' + esc(entry.id) + '" data-mark="' + esc(c.mark) + '">' +
      '<div class="library-card-top"><span>' + esc(c.name) + '</span><span>' + date(entry.createdAt) + '</span></div>' +
      '<h3>' + esc(entry.title) + '</h3><p>' + esc(entry.summary) + '</p>' +
      '<div class="library-card-foot"><div class="library-tags">' + (entry.tags || []).slice(0,3).map(function (t) { return '<span class="library-tag">' + esc(t) + '</span>'; }).join("") + '</div><span>☆ ' + entry.stars + '　▣ ' + entry.copies + '</span></div></button>';
  }
  function directoryTemplate(data) {
    categories = data.categories || categories;
    var filters = [{ id:"all", name:"全部目录", mark:"ALL" }].concat(categories).map(function (item) {
      return '<button type="button" data-category="' + esc(item.id) + '" class="' + (state.category === item.id ? "active" : "") + '">' + esc(item.name) + '</button>';
    }).join("");
    var items = data.entries.length ? data.entries.map(card).join("") : '<div class="library-empty"><strong>这一格索引还没有棋谱</strong><small>换个关键词，或成为第一位投稿者。</small></div>';
    return '<div class="library-controls"><input id="library-query" class="library-search" value="' + esc(state.q) + '" placeholder="检索标题、标签或主题…" aria-label="检索共享棋谱">' +
      '<select id="library-sort" class="library-select" aria-label="排序"><option value="new"' + (state.sort === "new" ? " selected" : "") + '>最新收录</option><option value="hot"' + (state.sort === "hot" ? " selected" : "") + '>最多收藏</option><option value="copies"' + (state.sort === "copies" ? " selected" : "") + '>最多研读</option></select>' +
      '<button class="library-action" type="button" data-action="mine">我的研读架</button><button class="library-action" type="button" data-action="publish">投稿棋谱 ＋</button></div>' +
      '<div class="library-directory">' + filters + '</div><div class="library-results-head"><span>' + (state.q ? '“' + esc(state.q) + '” 的检索结果' : "目录索引") + '</span><span class="library-count">' + data.total + ' ENTRIES · PAGE ' + data.page + '/' + data.pages + '</span></div>' +
      '<div class="library-grid">' + items + '</div><div class="library-pager"><button type="button" data-page="prev"' + (data.page <= 1 ? " disabled" : "") + '>← 上一页</button><span>' + data.page + ' / ' + data.pages + '</span><button type="button" data-page="next"' + (data.page >= data.pages ? " disabled" : "") + '>下一页 →</button></div><div class="library-status" aria-live="polite">' + esc(state.notice) + '</div>';
  }
  function loadDirectory() {
    if (!root) return;
    var seq = ++state.seq, params = new URLSearchParams({ page:String(state.page), pageSize:"8", sort:state.sort, category:state.category });
    if (state.q) params.set("q", state.q);
    root.querySelector("#library-body").innerHTML = '<div class="library-empty"><strong>正在整理索引柜…</strong><small>读取共享棋谱目录</small></div>';
    request("/api/library/entries?" + params.toString()).then(function (r) {
      if (seq !== state.seq) return;
      if (!r.res.ok) throw new Error(r.data.error || "资料库暂不可用");
      root.querySelector("#library-body").innerHTML = directoryTemplate(r.data);
    }).catch(function (e) { if (seq === state.seq) root.querySelector("#library-body").innerHTML = '<div class="library-empty"><strong>目录暂时无法读取</strong><small>' + esc(e.message) + '</small></div>'; });
  }
  function entryActions(entry) {
    var fav = entry.starred ? "已收藏 ★" : "收藏 ☆";
    var collect = entry.collected ? "移出研读架" : "加入研读架";
    return '<div class="library-detail-actions"><button class="library-action" type="button" data-action="favorite" data-id="' + esc(entry.id) + '">' + fav + '</button><button class="library-action" type="button" data-action="collect" data-id="' + esc(entry.id) + '">' + collect + '</button><button class="library-action" type="button" data-action="copy-pgn" data-id="' + esc(entry.id) + '">复制 PGN</button><button class="library-action" type="button" data-action="download" data-id="' + esc(entry.id) + '">下载 .pgn</button>' + (entry.owned ? '<button class="library-action" type="button" data-action="delete" data-id="' + esc(entry.id) + '">撤下投稿</button>' : "") + '</div>';
  }
  function detailTemplate(entry) {
    var c = category(entry.category), comments = entry.commentList || [];
    var commentHtml = comments.length ? comments.map(function (item) { return '<article class="library-comment"><b>' + esc(item.author) + '</b><span>' + date(item.createdAt) + '</span>' + (item.owned ? '<button class="library-action" type="button" data-action="delete-comment" data-entry-id="' + esc(entry.id) + '" data-comment-id="' + esc(item.id) + '">删除</button>' : "") + '<p>' + esc(item.text) + '</p></article>'; }).join("") : '<div class="library-empty"><strong>还没有讨论</strong><small>读完后留下一条具体的棋局感受。</small></div>';
    return '<div class="library-detail"><button type="button" class="library-action library-back" data-action="back">← 返回目录</button><article class="library-detail-paper"><header class="library-detail-head"><div class="library-kicker">' + esc(c.mark) + ' / ' + esc(c.name) + ' · ' + esc(entry.author) + '</div><h1>' + esc(entry.title) + '</h1><p>' + esc(entry.summary) + '</p><div class="library-meta">☆ ' + entry.stars + ' 收藏　▣ ' + entry.copies + ' 次加入研读架　◌ ' + entry.comments + ' 条讨论</div></header>' + entryActions(entry) + '<h2>棋谱文本</h2><pre class="library-pgn" id="library-pgn">' + esc(entry.pgn) + '</pre><section class="library-comments"><h2>研读笔记</h2>' + (state.me ? '<form id="library-comment-form" class="library-comment-form"><input name="comment" maxlength="300" placeholder="写下一个具体判断或问题…" required><button class="library-action">发布</button></form>' : '<p class="library-form-hint">登录后可以为这份棋谱留下研读笔记。</p>') + '<div id="library-comment-list">' + commentHtml + '</div></section></article><div class="library-status" aria-live="polite">' + esc(state.notice) + '</div></div>';
  }
  function showDetail(id) {
    if (!root) return;
    root.querySelector("#library-body").innerHTML = '<div class="library-empty"><strong>打开棋谱中…</strong><small>正在取出档案</small></div>';
    request("/api/library/entries/" + encodeURIComponent(id)).then(function (r) {
      if (!r.res.ok) throw new Error(r.data.error || "棋谱不存在");
      root.querySelector("#library-body").innerHTML = detailTemplate(r.data.entry);
    }).catch(function (e) { root.querySelector("#library-body").innerHTML = '<div class="library-empty"><strong>无法打开这份资料</strong><small>' + esc(e.message) + '</small><button class="library-action" type="button" data-action="back">返回目录</button></div>'; });
  }
  function publishTemplate() {
    var options = categories.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join("");
    return '<div class="library-detail"><button type="button" class="library-action library-back" data-action="back">← 返回目录</button><article class="library-detail-paper"><div class="library-kicker">CONTRIBUTE / 投稿棋谱</div><h1>把你的研读留在资料库</h1><p class="library-form-hint">请只投稿你拥有分享权的原创笔记、公开棋谱或自己的分析；不要上传他人的私密对局。</p><form id="library-publish-form" class="library-form"><label>标题<input name="title" maxlength="60" placeholder="例如：后翼弃兵中的 c 兵推进时机" required></label><label>分类<select name="category">' + options + '</select></label><label>摘要<textarea name="summary" maxlength="420" placeholder="这份棋谱解决什么问题？读者应关注哪一个判断？" required></textarea></label><label>标签<input name="tags" maxlength="120" placeholder="开局, 兵形, 中局计划（逗号分隔，最多 6 个）"></label><label>PGN 或棋谱文本<textarea class="pgn-input" name="pgn" maxlength="16000" placeholder="[Event \"我的研读\"]\n\n1. e4 e5 2. Nf3 Nc6 ..." required></textarea></label><button class="library-action" type="submit">发布到共享棋谱库</button></form><div class="library-status" aria-live="polite">' + esc(state.notice) + '</div></article></div>';
  }
  function showPublish() {
    if (!authRequired()) return;
    root.querySelector("#library-body").innerHTML = publishTemplate();
  }
  function mineTemplate(data) {
    function mini(entry, mine) { return '<article class="library-mini"><div><b>' + esc(entry.title) + '</b><div class="library-form-hint">' + esc(category(entry.category).name) + ' · ☆ ' + entry.stars + ' · ' + date(entry.createdAt) + '</div></div><div><button type="button" class="library-action" data-entry="' + esc(entry.id) + '">打开</button>' + (mine ? '<button type="button" class="library-action" data-action="delete" data-id="' + esc(entry.id) + '">撤下</button>' : "") + '</div></article>'; }
    return '<div class="library-detail library-mine"><button type="button" class="library-action library-back" data-action="back">← 返回目录</button><article class="library-detail-paper"><div class="library-kicker">MY SHELF / 账号同步</div><h1>我的研读架</h1><div class="library-mine-columns"><section><h2>已收藏的棋谱</h2><div class="library-mini-list">' + (data.collected.length ? data.collected.map(function (e) { return mini(e, false); }).join("") : '<p class="library-form-hint">还没有收藏。找到值得重读的棋谱，放进这里。</p>') + '</div></section><section><h2>我的投稿</h2><div class="library-mini-list">' + (data.submitted.length ? data.submitted.map(function (e) { return mini(e, true); }).join("") : '<p class="library-form-hint">还没有投稿。把一条真正有用的判断写进资料库。</p>') + '</div></section></div></article><div class="library-status" aria-live="polite">' + esc(state.notice) + '</div></div>';
  }
  function showMine() {
    if (!authRequired()) return;
    root.querySelector("#library-body").innerHTML = '<div class="library-empty"><strong>整理你的研读架…</strong><small>读取账号同步资料</small></div>';
    request("/api/library/me").then(function (r) { if (!r.res.ok) throw new Error(r.data.error || "读取失败"); root.querySelector("#library-body").innerHTML = mineTemplate(r.data); }).catch(function (e) { notice(e.message); loadDirectory(); });
  }
  function sendAction(action, id) {
    if (!authRequired()) return;
    request("/api/library/entries/" + encodeURIComponent(id) + "/" + action, { method:"POST", headers:{"Content-Type":"application/json"}, body:"{}" }).then(function (r) {
      if (!r.res.ok) throw new Error(r.data.error || "操作未完成");
      notice(action === "favorite" ? "收藏状态已更新。" : (r.data.collected ? "已加入研读架。" : "已移出研读架。")); showDetail(id);
    }).catch(function (e) { notice(e.message); });
  }
  function removeEntry(id) {
    if (!authRequired() || !window.confirm("确认撤下这份投稿？它会从公共目录和所有研读架移除。")) return;
    request("/api/library/entries/" + encodeURIComponent(id), { method:"DELETE" }).then(function (r) { if (!r.res.ok) throw new Error(r.data.error || "撤下失败"); notice("投稿已撤下。"); loadDirectory(); }).catch(function (e) { notice(e.message); });
  }
  function removeComment(entryId, commentId) {
    if (!authRequired() || !window.confirm("删除这条研读笔记？")) return;
    request("/api/library/entries/" + encodeURIComponent(entryId) + "/comments/" + encodeURIComponent(commentId), { method:"DELETE" }).then(function (r) { if (!r.res.ok) throw new Error(r.data.error || "删除失败"); state.notice = "研读笔记已删除。"; showDetail(entryId); }).catch(function (e) { notice(e.message); });
  }
  function copyPgn() {
    var text = (root.querySelector("#library-pgn") || {}).textContent || "";
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { notice("PGN 已复制。"); }).catch(function () { notice("浏览器未允许剪贴板访问，请手动复制。"); });
    else notice("浏览器不支持自动复制，请手动复制。");
  }
  function downloadPgn() {
    var text = (root.querySelector("#library-pgn") || {}).textContent || "";
    if (!text) return;
    var a = document.createElement("a"), blob = new Blob([text], {type:"application/x-chess-pgn"});
    a.href = URL.createObjectURL(blob); a.download = "star-study.pgn"; a.click(); URL.revokeObjectURL(a.href); notice("PGN 下载已开始。");
  }
  function handleClick(event) {
    var el = event.target.closest("[data-entry],[data-action],[data-category],[data-page]"); if (!el || !root.contains(el)) return;
    if (el.dataset.entry) return showDetail(el.dataset.entry);
    if (el.dataset.category) { state.category = el.dataset.category; state.page = 1; return loadDirectory(); }
    if (el.dataset.page) { state.page += el.dataset.page === "next" ? 1 : -1; return loadDirectory(); }
    var action = el.dataset.action, id = el.dataset.id;
    if (action === "back") return loadDirectory();
    if (action === "publish") return showPublish();
    if (action === "mine") return showMine();
    if (action === "favorite" || action === "collect") return sendAction(action, id);
    if (action === "delete") return removeEntry(id);
    if (action === "delete-comment") return removeComment(el.dataset.entryId, el.dataset.commentId);
    if (action === "copy-pgn") return copyPgn();
    if (action === "download") return downloadPgn();
  }
  function handleInput(event) { if (event.target.id === "library-query") { state.q = event.target.value.trim(); state.page = 1; clearTimeout(handleInput.timer); handleInput.timer = setTimeout(loadDirectory, 220); } }
  function handleChange(event) { if (event.target.id === "library-sort") { state.sort = event.target.value; state.page = 1; loadDirectory(); } }
  function handleSubmit(event) {
    if (event.target.id === "library-publish-form") {
      event.preventDefault(); if (!authRequired()) return;
      var form = new FormData(event.target), tags = String(form.get("tags") || "").split(/[，,]/).map(function (x) { return x.trim(); }).filter(Boolean);
      request("/api/library/entries", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ title:form.get("title"), category:form.get("category"), summary:form.get("summary"), tags:tags, pgn:form.get("pgn") }) }).then(function (r) { if (!r.res.ok) throw new Error(r.data.error || "投稿失败"); state.notice = "已发布到共享棋谱库。"; showDetail(r.data.entry.id); }).catch(function (e) { notice(e.message); });
    }
    if (event.target.id === "library-comment-form") {
      event.preventDefault(); if (!authRequired()) return;
      var detail = root.querySelector("[data-action='favorite']"), id = detail && detail.dataset.id, text = new FormData(event.target).get("comment");
      if (!id) return;
      request("/api/library/entries/" + encodeURIComponent(id) + "/comments", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ text:text }) }).then(function (r) { if (!r.res.ok) throw new Error(r.data.error || "评论未发布"); state.notice = "研读笔记已发布。"; showDetail(id); }).catch(function (e) { notice(e.message); });
    }
  }
  function mount(target) {
    root = target; state.notice = ""; root.innerHTML = shell();
    root.removeEventListener("click", handleClick); root.removeEventListener("input", handleInput); root.removeEventListener("change", handleChange); root.removeEventListener("submit", handleSubmit);
    root.addEventListener("click", handleClick); root.addEventListener("input", handleInput); root.addEventListener("change", handleChange); root.addEventListener("submit", handleSubmit);
    request("/api/me").then(function (r) { state.me = r.res.ok ? r.data : null; }).catch(function () { state.me = null; }).then(loadDirectory);
  }
  window.SharedLibrary = { mount:mount };
}());
