/* Shared pieces: storage, the book list, GitHub access, the "connect this device" panel and the tabs. */
(function () {
  "use strict";

  var REPO = "plerner16/cfb-line-shop";          // the site and the lines (public)
  var API = "https://api.github.com/repos/" + REPO;
  var LEDGER_REPO = "plerner16/cfb-bet-ledger";  // your bets (private)
  var LEDGER_API = "https://api.github.com/repos/" + LEDGER_REPO;
  // GitHub fills in the new-token form from these (the repository still has to be picked by hand).
  var NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new?name=" + encodeURIComponent("Line Shop") +
    "&description=" + encodeURIComponent("Refresh lines and save bets from the CFB Line Shop site") +
    "&expires_in=366&actions=write&contents=write";

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) {
      try { if (v == null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ }
    }
  };

  var moneyFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function money(n, signed) {
    var v = Math.round(Number(n) * 100) / 100;
    var s = "$" + moneyFmt.format(Math.abs(v)).replace(/\.00$/, "");
    if (v < 0) return "−" + s;
    return signed && v > 0 ? "+" + s : s;
  }

  // ---------- books ----------
  var books = window.LS.cleanBooks(null);
  var bookListeners = [];
  function setBooks(list) {
    var next = window.LS.cleanBooks(list);
    if (JSON.stringify(next) === JSON.stringify(books)) return;
    books = next;
    bookListeners.forEach(function (fn) { fn(books); });
  }
  function bookName(key) {
    for (var i = 0; i < books.length; i++) if (books[i].key === key) return books[i].name;
    return key;
  }
  function bookShort(key) {
    for (var i = 0; i < books.length; i++) if (books[i].key === key) return books[i].short;
    return key;
  }

  // ---------- line history ----------
  // data/history.json, loaded with the lines (board.js) and read by the board and the ledger.
  var history = null;
  var historyListeners = [];
  function setHistory(h) {
    history = h;
    historyListeners.forEach(function (fn) { fn(h); });
  }

  // ---------- big moves marked seen ----------
  // Kept by bigmoves.js; the board reads it to tell new big moves from ones already seen.
  var seenMoves = {};
  var seenListeners = [];
  function setSeenMoves(map) {
    seenMoves = map || {};
    seenListeners.forEach(function (fn) { fn(seenMoves); });
  }

  // ---------- GitHub ----------
  function token() { return (store.get("ls.ghToken") || "").trim(); }
  function gh(method, url, tok, body) {
    var headers = { "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (tok) headers["Authorization"] = "Bearer " + tok;
    if (body) headers["Content-Type"] = "application/json";
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  }

  // ---------- connect this device ----------
  // Opens the one-time setup. `opts.reason` says why (shown at the top); `opts.after` runs once a token is saved.
  var pendingAfter = null;
  function connectMsg(text) { var m = $("connect-msg"); m.textContent = text || ""; m.hidden = !text; }
  function openConnect(opts) {
    opts = opts || {};
    pendingAfter = opts.after || null;
    $("connect").hidden = false;
    connectMsg(opts.reason || "");
    $("connect-error").hidden = true;
    try { $("connect").scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) { /* older browsers */ }
  }
  function closeConnect() {
    $("connect").hidden = true;
    pendingAfter = null;
    connectMsg("");
    $("connect-error").hidden = true;
    $("gh-token").value = "";
  }
  function connectError(text) { var m = $("connect-error"); m.textContent = text; m.hidden = !text; }

  function saveToken() {
    var t = $("gh-token").value.trim();
    if (!t) { connectError("Paste the token first."); return; }
    if (!/^(github_pat_|ghp_)/.test(t)) { connectError("That doesn't look like a GitHub token. It starts with github_pat_."); return; }
    var btn = $("save-token");
    var reset = function () { btn.disabled = false; btn.textContent = "Save"; };
    btn.disabled = true;
    btn.textContent = "Checking…";
    gh("GET", "https://api.github.com/user", t).then(function (res) {
      reset();
      if (res.status === 401) { connectError("GitHub didn't accept that token. It may have expired, or part of it didn't get copied."); return; }
      store.set("ls.ghToken", t);
      var after = pendingAfter;
      closeConnect();
      renderDevice();
      if (after) after();
    }, function () {
      reset();
      connectError("Couldn't reach GitHub. Check your connection and try again.");
    });
  }

  function forgetToken() {
    store.set("ls.ghToken", null);
    renderDevice();
  }
  function renderDevice() {
    var has = !!token();
    $("device-access").hidden = !has;
    $("device-none").hidden = has;
    deviceListeners.forEach(function (fn) { fn(has); });
  }
  var deviceListeners = [];

  // What a GitHub refusal means for this device, in plain words.
  function tokenProblem(status, what) {
    if (status === 401) return "This device's GitHub token has expired or was deleted. Make a new one below and paste it here.";
    if (what === "ledger") return "This device's GitHub token doesn't have access to your private ledger (it was made before the ledger moved). Make a new one below, picking both cfb-line-shop and cfb-bet-ledger, and paste it here; it replaces the old one.";
    return "This device's GitHub token can't start refreshes. Make a new one below and paste it here; it replaces the old one.";
  }

  // ---------- tabs ----------
  var views = ["lines", "ledger", "edges"];
  var viewListeners = [];
  function currentView() { return location.hash === "#ledger" ? "ledger" : location.hash === "#edges" ? "edges" : "lines"; }
  function showView() {
    var v = currentView();
    views.forEach(function (name) {
      $("view-" + name).hidden = name !== v;
      var tab = $("tab-" + name);
      tab.setAttribute("aria-current", name === v ? "page" : "false");
    });
    document.body.dataset.view = v;
    viewListeners.forEach(function (fn) { fn(v); });
  }
  window.addEventListener("hashchange", showView);

  // Scripts load with `defer`, so the page is already parsed here.
  $("new-token-link").href = NEW_TOKEN_URL;
  $("save-token").addEventListener("click", saveToken);
  $("gh-token").addEventListener("keydown", function (e) { if (e.key === "Enter") saveToken(); });
  $("close-connect").addEventListener("click", closeConnect);
  $("forget-token").addEventListener("click", forgetToken);
  $("connect-device").addEventListener("click", function () { openConnect({}); });

  // Called once every part of the page has hooked in.
  function start() {
    renderDevice();
    showView();
  }

  window.APP = {
    start: start,
    REPO: REPO, API: API, LEDGER_REPO: LEDGER_REPO, LEDGER_API: LEDGER_API,
    $: $, esc: esc, store: store, money: money,
    books: function () { return books; }, setBooks: setBooks, bookName: bookName, bookShort: bookShort,
    onBooks: function (fn) { bookListeners.push(fn); },
    history: function () { return history; }, setHistory: setHistory, onHistory: function (fn) { historyListeners.push(fn); },
    seenMoves: function () { return seenMoves; }, setSeenMoves: setSeenMoves, onSeen: function (fn) { seenListeners.push(fn); },
    token: token, gh: gh, tokenProblem: tokenProblem,
    openConnect: openConnect, closeConnect: closeConnect, onDevice: function (fn) { deviceListeners.push(fn); },
    currentView: currentView, onView: function (fn) { viewListeners.push(fn); }
  };
})();
