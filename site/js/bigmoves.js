/* Big moves: the list at the top of the Lines tab of spreads and totals that moved more than N points
   in N days (the same moves the phone alerts send), each one alerted once. "Got it" marks a move seen;
   it comes back only if the line goes at least another point. What's been seen is saved in the private
   ledger repository (seen.json), so it's the same on every connected device, and on this device too. */
(function () {
  "use strict";
  var A = window.APP, H = window.LINE_HISTORY, LS = window.LS, L = window.LEDGER;
  var $ = A.$, esc = A.esc, store = A.store;
  var SEEN_URL = A.LEDGER_API + "/contents/seen.json";
  var LOCAL = "ls.seenMoves";
  var whenFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

  // ---------- what's been seen ----------
  // { "gameId:market:book": the line when it was marked seen }
  var seen = {};
  try { var saved = JSON.parse(store.get(LOCAL) || "{}"); if (saved && typeof saved === "object") seen = saved; } catch (e) { /* start empty */ }
  var sha = null;       // seen.json's version on GitHub, once read
  var unsaved = {};     // keys marked here and not yet saved to GitHub

  function publish() {
    try { store.set(LOCAL, JSON.stringify(seen)); } catch (e) { /* still fine for this visit */ }
    A.setSeenMoves(seen);
  }

  // Only games still in the line history are worth keeping.
  function pruned(map) {
    var h = A.history(), out = {};
    Object.keys(map).forEach(function (k) { if (!h || !h.games || h.games[k.split(":")[0]]) out[k] = map[k]; });
    return out;
  }
  function formatSeen(map) {
    var keys = Object.keys(map).sort();
    return '{"version":1,"seen":{' + (keys.length ? "\n" + keys.map(function (k) { return JSON.stringify(k) + ":" + map[k]; }).join(",\n") + "\n" : "") + "}}\n";
  }

  async function fetchSeen() {
    var tok = A.token();
    if (!tok) return null;
    var res = await A.gh("GET", SEEN_URL + "?ref=main", tok);
    if (res.status === 404) return { seen: {}, sha: null };
    if (!res.ok) throw new Error("HTTP " + res.status);
    var j = await res.json();
    var d = JSON.parse(L.fromBase64(j.content));
    return { seen: (d && d.seen && typeof d.seen === "object") ? d.seen : {}, sha: j.sha };
  }

  // Takes GitHub's copy, keeping anything marked here that hasn't been saved yet.
  function adopt(remote) {
    var next = {};
    Object.keys(remote.seen).forEach(function (k) { next[k] = remote.seen[k]; });
    Object.keys(seen).forEach(function (k) { if (!(k in next)) unsaved[k] = true; });
    Object.keys(unsaved).forEach(function (k) { if (k in seen) next[k] = seen[k]; });
    seen = next;
    sha = remote.sha;
  }

  var chain = Promise.resolve();
  function queueSave() { chain = chain.then(save, save); }
  async function save(attempt) {
    attempt = typeof attempt === "number" ? attempt : 0;
    if (!Object.keys(unsaved).length || !A.token()) return;
    try {
      if (sha === null && attempt === 0) { var first = await fetchSeen(); if (first) adopt(first); }
      var keep = pruned(seen);
      var body = { message: "Seen " + Object.keys(unsaved).length + " big move" + (Object.keys(unsaved).length === 1 ? "" : "s"),
        content: L.toBase64(formatSeen(keep)), branch: "main" };
      if (sha) body.sha = sha;
      var done = unsaved;
      unsaved = {};
      var res = await A.gh("PUT", SEEN_URL, A.token(), body);
      if (res.ok) { var j = await res.json(); sha = j.content && j.content.sha; return; }
      Object.keys(done).forEach(function (k) { unsaved[k] = true; });
      if ((res.status === 409 || res.status === 422) && attempt < 3) {
        var latest = await fetchSeen();
        if (latest) { adopt(latest); publish(); }
        return save(attempt + 1);
      }
    } catch (e) { /* kept on this device; saved with the next change or visit */ }
  }

  function load() {
    fetchSeen().then(function (remote) {
      if (!remote) return;
      adopt(remote);
      publish();
      if (Object.keys(unsaved).length) queueSave();
    }, function () { /* this device's copy stands */ });
  }

  function markSeen(groups) {
    groups.forEach(function (g) {
      g.moves.forEach(function (m) { var k = H.moveKey(g.id, m); seen[k] = m.to.point; unsaved[k] = true; });
    });
    publish();
    queueSave();
  }

  // ---------- the list ----------
  var current = [];
  function groupsNow() {
    var h = A.history();
    return h && H ? H.bigMoveGroups(h, Date.now()) : [];
  }
  function rowHtml(g, fresh) {
    var game = g.game;
    var books = g.moves.map(function (m) {
      return A.bookShort(m.book) + " " + H.pointsText(m.move) + " " + H.spanText(m, function (t) { return whenFmt.format(new Date(t)); });
    }).join(" · ");
    return '<li class="bm' + (fresh ? " fresh" : "") + '" data-i="' + current.indexOf(g) + '">' +
      '<div class="bm-main"><div class="bm-title">' + esc(H.groupTitle(g)) + "</div>" +
      '<div class="bm-sub">' + esc(books) + "</div>" +
      '<div class="bm-sub">' + esc(LS.shortTeam(game.away) + " @ " + LS.shortTeam(game.home) + " · " + whenFmt.format(new Date(game.start))) + "</div></div>" +
      '<div class="bm-ctl"><button type="button" class="btn small" data-act="show">Show</button>' +
      (fresh ? '<button type="button" class="btn small" data-act="seen">Got it</button>' : "") + "</div></li>";
  }

  var SHOW = 5, expanded = false;   // a long list shows five at first
  var scrollWanted = false;
  function render() {
    var sec = $("bigmoves");
    current = groupsNow();
    if (!current.length) { sec.hidden = true; finishLink(); return; }
    sec.hidden = false;
    var fresh = current.filter(function (g) { return H.groupIsNew(seen, g); });
    var old = current.filter(function (g) { return !H.groupIsNew(seen, g); });
    $("bm-meta").textContent = fresh.length ? fresh.length + " new" + (old.length ? " · " + old.length + " seen" : "") : "All seen";
    $("bm-all").hidden = fresh.length < 2;
    $("bm-list").hidden = !fresh.length;
    var shown = expanded || fresh.length <= SHOW + 1 ? fresh : fresh.slice(0, SHOW);
    $("bm-list").innerHTML = shown.map(function (g) { return rowHtml(g, true); }).join("") +
      (shown.length < fresh.length ? '<li class="bm-more"><button type="button" class="btn small" id="bm-more">Show ' + (fresh.length - shown.length) + " more</button></li>" : "");
    $("bm-old").hidden = !old.length;
    $("bm-old-count").textContent = old.length + " seen";
    $("bm-old-list").innerHTML = old.map(function (g) { return rowHtml(g, false); }).join("");
    $("bm-note").textContent = A.token() ? "" : "Marked seen on this device only. Connect it to GitHub (Ledger tab) to keep every device in step.";
    $("bm-note").hidden = !!A.token();
    finishLink();
  }

  // A link to #alerts (the welcome alert) scrolls here once the list is ready.
  function readLink() { if (location.hash === "#alerts") scrollWanted = true; }
  function finishLink() {
    if (!scrollWanted || !A.history()) return;
    scrollWanted = false;
    try { history.replaceState(null, "", location.pathname + location.search + "#lines"); } catch (e) { /* fine */ }
    if (!$("bigmoves").hidden) $("bigmoves").scrollIntoView({ block: "start" });
  }

  $("bigmoves").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    if (b.id === "bm-all") { markSeen(current.filter(function (g) { return H.groupIsNew(seen, g); })); return; }
    if (b.id === "bm-more") { expanded = true; render(); return; }
    var li = b.closest(".bm");
    var g = li && current[Number(li.dataset.i)];
    if (!g) return;
    if (b.dataset.act === "show") A.showGame(g.id);
    else if (b.dataset.act === "seen") markSeen([g]);
  });

  readLink();
  window.addEventListener("hashchange", function () { readLink(); render(); });
  A.onSeen(render);
  A.onHistory(function () { render(); if (Object.keys(unsaved).length) queueSave(); });
  A.onDevice(function (has) { if (has) load(); render(); }); // runs at start, and when a device connects
  publish();
})();
