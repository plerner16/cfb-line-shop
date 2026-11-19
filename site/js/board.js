/* The Lines tab: the best line for every bet across the books, your card, and the Refresh button. */
(function () {
  "use strict";
  var A = window.APP, LS = window.LS, L = window.LEDGER, H = window.LINE_HISTORY;
  var $ = A.$, esc = A.esc, store = A.store;

  var state = {
    source: "loading", games: [], loadedAt: null, credits: null, lastError: null, stamp: null, events: null,
    weather: null, weatherAt: null, weatherStamp: null,
    history: null, historyStamp: null, movesOpen: {},
    windowMode: store.get("ls.window") === "all" ? "all" : "week",
    market: "all", sort: "time", onlyDiff: false, q: ""
  };

  var timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  var dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long" });
  var shortDay = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  var dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  var weekdayTime = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  var dateTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  var MARKET_NAME = { spread: "Spread", total: "Total", ml: '<span class="wide-only">Moneyline</span><span class="narrow-only">ML</span>' };

  // ---------- loading ----------
  // Lines come from data/odds.json, which a scheduled job on GitHub rewrites on each refresh.
  var DATA_URL = "data/odds.json";
  var POLL_MS = 5 * 60 * 1000;          // how often an open page checks for a newer file
  var STALE_MS = 4 * 24 * 60 * 60 * 1000; // longer than the weekend gap in the refresh schedule
  var reachable = true;

  function setGames(events, source, at) {
    var now = new Date();
    state.events = events;
    state.games = LS.normalize(events, now, A.books()).map(function (g) { return { g: g, a: LS.analyze(g) }; });
    state.source = source;
    state.loadedAt = at || now;
    render();
    if (source === "live") openLinkedGame();
  }

  function showNotice(text) { var n = $("notice"); n.textContent = text; n.hidden = false; }
  function hideNotice() { $("notice").hidden = true; }

  function whenText(d) {
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
    if (now - d < 6 * 864e5) return weekdayTime.format(d);
    return dateTime.format(d);
  }

  function windowGames() {
    if (state.windowMode === "all") return state.games;
    var end = LS.weekEnd(new Date()).getTime();
    return state.games.filter(function (it) { return it.g.start.getTime() <= end; });
  }

  function dataNotice() {
    var err = state.lastError && state.lastError.message;
    if (state.source === "sample") {
      if (err) return "Real lines haven't loaded yet. The last refresh said: " + err;
      if (!reachable) return "Couldn't reach the site to get the latest lines. Check your connection; the page tries again on its own.";
      return "";
    }
    if (err) return "The last refresh didn't work, so these lines are from " + whenText(state.loadedAt) + ". It said: " + err;
    if (Date.now() - state.loadedAt.getTime() > STALE_MS) {
      return "These lines haven't refreshed since " + whenText(state.loadedAt) + ". The refresh job on GitHub may have stopped.";
    }
    if (!windowGames().length) {
      return state.windowMode === "week"
        ? "No college football games are posted for this week yet. Books usually post the next week's lines on Sunday. Try All listed."
        : "No college football games are posted right now.";
    }
    return "";
  }

  function showSampleIfEmpty() {
    if (state.source === "loading") setGames(window.LS_SAMPLE(new Date()), "sample");
  }

  // Kickoff forecasts, refreshed every hour by the same GitHub job.
  var WEATHER_URL = "data/weather.json";
  function checkWeather() {
    return fetch(WEATHER_URL + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.games || !data.updatedAt || data.updatedAt === state.weatherStamp) return;
        state.weatherStamp = data.updatedAt;
        state.weather = data.games;
        state.weatherAt = new Date(data.updatedAt);
        if (state.source !== "loading") renderBoard();
      }, function () { /* no weather this time; the board works without it */ });
  }

  // How each line moved this week, added to on every refresh by the same job.
  var HISTORY_URL = "data/history.json";
  function checkHistory() {
    return fetch(HISTORY_URL + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.games || data.updatedAt === state.historyStamp) return;
        state.historyStamp = data.updatedAt;
        state.history = data;
        A.setHistory(data);
        if (state.source !== "loading") renderBoard();
        openLinkedGame();
      }, function () { /* no history this time; the board works without it */ });
  }

  // A line alert links to #game=<id>: show that game with its line moves open.
  var linkedGame = null;
  function readLink() {
    var m = location.hash.match(/^#game=([A-Za-z0-9_-]+)$/);
    if (m) linkedGame = m[1];
  }
  function openLinkedGame() {
    if (!linkedGame || state.source !== "live" || !state.history) return;
    var id = linkedGame;
    linkedGame = null;
    var item = state.games.filter(function (it) { return it.g.id === id; })[0];
    try { history.replaceState(null, "", location.pathname + location.search + "#lines"); } catch (e) { /* fine */ }
    if (!item) return; // already kicked off and gone from the board
    if (windowGames().indexOf(item) < 0) state.windowMode = "all";
    if (visibleGames().indexOf(item) < 0) {
      state.onlyDiff = false; $("only-diff").checked = false;
      state.q = ""; $("team-search").value = "";
    }
    state.movesOpen[id] = true;
    render();
    var btn = $("board").querySelector('.moves-btn[data-game="' + id + '"]');
    if (btn) btn.closest(".game").scrollIntoView({ block: "start" });
  }
  readLink();
  window.addEventListener("hashchange", function () { readLink(); openLinkedGame(); });

  var inflight = null;
  // Resolves once the newest odds.json has been read (or the read failed).
  function checkForLines() {
    checkWeather();
    checkHistory();
    if (inflight) return inflight;
    inflight = fetch(DATA_URL + "?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        reachable = true;
        data = data || {};
        if (Array.isArray(data.books)) A.setBooks(data.books);
        state.lastError = data.lastError && data.lastError.message ? data.lastError : null;
        state.credits = typeof data.creditsRemaining === "number" ? data.creditsRemaining : null;
        if (!data.updatedAt || !Array.isArray(data.events)) { showSampleIfEmpty(); renderStatus(); return; }
        if (data.updatedAt === state.stamp) { renderStatus(); return; }
        state.stamp = data.updatedAt;
        setGames(data.events, "live", new Date(data.updatedAt));
      })
      .catch(function () {
        reachable = false;
        showSampleIfEmpty();
        renderStatus();
      })
      .then(function () { inflight = null; });
    return inflight;
  }

  // ---------- refresh button ----------
  // Starts the refresh job on GitHub with this device's token, then waits for the new lines.
  var WORKFLOW_API = A.API + "/actions/workflows/refresh-odds.yml";
  var WAIT_MS = 5 * 60 * 1000, WAIT_POLL_MS = 8000;
  var waiting = null;

  function refreshMsg(text, isErr) {
    var m = $("refresh-msg");
    m.textContent = text || "";
    m.className = "refresh-msg" + (isErr ? " err" : "");
    m.hidden = !text;
  }
  function renderRefresh() {
    var btn = $("refresh-btn");
    btn.disabled = !!waiting;
    btn.textContent = waiting ? "Refreshing…" : "Refresh";
  }
  function stopWaiting() {
    if (waiting && waiting.timer) clearTimeout(waiting.timer);
    waiting = null;
    renderRefresh();
  }
  function waitForRefresh(message) {
    if (waiting && waiting.timer) clearTimeout(waiting.timer);
    waiting = waiting || { stamp: state.stamp, errAt: state.lastError ? state.lastError.at : null, began: Date.now() };
    waiting.timer = setTimeout(pollRefresh, WAIT_POLL_MS);
    renderRefresh();
    refreshMsg(message);
  }
  function pollRefresh() {
    if (!waiting) return;
    checkForLines().then(function () {
      if (!waiting) return;
      var errAt = state.lastError ? state.lastError.at : null;
      if (state.stamp !== waiting.stamp) {
        stopWaiting();
        refreshMsg("Lines refreshed.");
        setTimeout(function () { if (!waiting && $("refresh-msg").textContent === "Lines refreshed.") refreshMsg(""); }, 8000);
        return;
      }
      if (errAt && errAt !== waiting.errAt) { stopWaiting(); refreshMsg(""); return; } // the notice above the board explains it
      if (Date.now() - waiting.began > WAIT_MS) {
        stopWaiting();
        refreshMsg("This refresh is taking longer than usual. The page will update on its own when the new lines land.");
        return;
      }
      waiting.timer = setTimeout(pollRefresh, WAIT_POLL_MS);
    });
  }

  function startRefresh() {
    var token = A.token();
    if (waiting || !token) return;
    waiting = { stamp: state.stamp, errAt: state.lastError ? state.lastError.at : null, began: Date.now() };
    renderRefresh();
    refreshMsg("Starting a refresh…");
    A.gh("POST", WORKFLOW_API + "/dispatches", token, { ref: "main", inputs: { force: true } }).then(function (res) {
      if (res.ok) { waitForRefresh("Refreshing. New lines usually show up in about a minute."); return; }
      stopWaiting();
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        refreshMsg("");
        A.openConnect({ reason: A.tokenProblem(res.status, "refresh"), after: startRefresh });
      } else {
        refreshMsg("GitHub answered with error " + res.status + ". Try again in a minute.", true);
      }
    }, function () {
      stopWaiting();
      refreshMsg("Couldn't reach GitHub. Check your connection and try again.", true);
    });
  }

  function onRefreshClick() {
    if (A.token()) startRefresh();
    else A.openConnect({ reason: "To refresh from this device, connect it to GitHub. You only do this once on each device.", after: startRefresh });
  }

  // ---------- my card ----------
  var card = [];
  var busy = {};
  var cardPendingRender = false;
  var dayTime = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

  function cardKey(gameId, market, row) {
    return String(gameId).replace(/[^A-Za-z0-9_]/g, "") + "-" + market + "-" + row;
  }
  function cardById(id) {
    for (var i = 0; i < card.length; i++) if (card[i].id === id) return card[i];
    return null;
  }
  function cardStatus(text) { var s = $("card-status"); s.textContent = text || ""; s.hidden = !text; }
  function saveLocalCard() { store.set("ls.card", JSON.stringify(card)); }
  function loadLocalCard() {
    var v;
    try { v = JSON.parse(store.get("ls.card") || "[]"); } catch (e) { v = []; }
    card = [];
    (Array.isArray(v) ? v : []).forEach(function (it) {
      if (!it || !it.gameId || it.sentAt) return; // bets the old copy-and-paste step already sent to the ledger
      it.id = cardKey(it.gameId, it.market, it.row);
      if (!cardById(it.id)) card.push(it);
    });
  }
  function putItem(item) {
    card = card.filter(function (x) { return x.id !== item.id; }).concat([item]);
    saveLocalCard();
  }
  function patchItem(id, fields) {
    var it = cardById(id);
    if (!it) return;
    for (var k in fields) it[k] = fields[k];
    saveLocalCard();
  }
  function removeItem(id) {
    card = card.filter(function (x) { return x.id !== id; });
    saveLocalCard();
  }

  // Another tab on this device changed the card: pick it up.
  window.addEventListener("storage", function (e) {
    if (e.key !== "ls.card") return;
    loadLocalCard();
    renderCard(); renderBoard();
  });

  function defaultStake() {
    var v = parseFloat(store.get("ls.stake"));
    return v > 0 ? v : 7.5;
  }
  function findGame(id) {
    for (var i = 0; i < state.games.length; i++) if (state.games[i].g.id === id) return state.games[i].g;
    return null;
  }

  function togglePick(btn) {
    if (state.source !== "live") {
      showNotice("These are sample lines, so they can't go on your card. Real lines show up after the first refresh.");
      return;
    }
    hideNotice();
    var id = btn.dataset.key;
    if (cardById(id)) {
      if (busy[id]) return;
      removeItem(id);
      cardStatus("");
      renderCard(); renderBoard();
      return;
    }
    var g = findGame(btn.dataset.game);
    if (!g) return;
    var m = btn.dataset.market, r = btn.dataset.row;
    var best = LS.bestLine(g, m, r);
    if (!best.o) return;
    putItem({
      id: id, gameId: g.id, market: m, row: r, book: best.books[0],
      away: g.away, home: g.home,
      teams: LS.shortTeam(g.away) + " @ " + LS.shortTeam(g.home),
      startISO: g.start.toISOString(),
      point: best.o.point, price: best.o.price,
      pick: LS.pickText(m, r, best.o, g.away, g.home),
      odds: best.o.price, amount: defaultStake(),
      addedAt: Date.now()
    });
    cardStatus("");
    renderCard(); renderBoard();
  }

  function currentLine(it) {
    var g = findGame(it.gameId);
    return g ? LS.side(g, it.book, it.market, it.row) : null;
  }

  function movedHtml(it) {
    if (state.source !== "live") return "";
    var o = currentLine(it);
    if (!o || it.point == null && it.price == null) return "";
    if (o.point === it.point && o.price === it.price) return "";
    return '<p class="moved">Line moved at ' + esc(A.bookName(it.book)) + ": now " + esc(LS.fmtLine(it.market, it.row, o)) +
      ", you added it at " + esc(LS.fmtLine(it.market, it.row, { point: it.point, price: it.price })) + ".</p>";
  }

  function bookSelect(it) {
    var keys = A.books().map(function (b) { return b.key; });
    if (keys.indexOf(it.book) < 0) keys.push(it.book);
    return keys.map(function (k) {
      return '<option value="' + esc(k) + '"' + (k === it.book ? " selected" : "") + ">" + esc(A.bookName(k)) + "</option>";
    }).join("");
  }

  function itemHtml(it) {
    var pid = "p-" + it.id, amt = Number(it.amount), saving = !!busy[it.id];
    var dis = saving ? " disabled" : "";
    return '<li class="pick' + (saving ? " saving" : "") + '" data-id="' + esc(it.id) + '">' +
      '<div class="pick-game"><span class="kick">' + esc(dayTime.format(new Date(it.startISO))) + "</span>" +
      '<span class="teams">' + esc(it.teams) + "</span></div>" +
      '<div class="pick-fields">' +
      '<label class="f-pick"><span class="mini">Pick</span><input class="input" id="' + pid + '-pick" data-f="pick" value="' + esc(it.pick) + '"' + dis + "></label>" +
      '<label class="f-book"><span class="mini">Book</span><select class="input" id="' + pid + '-book" data-f="book"' + dis + ">" + bookSelect(it) + "</select></label>" +
      '<label class="f-odds"><span class="mini">Odds</span><input class="input" id="' + pid + '-odds" data-f="odds" inputmode="numeric" value="' + esc(LS.fmtPrice(Number(it.odds)).replace("−", "-")) + '"' + dis + "></label>" +
      '<label class="f-amt"><span class="mini">Stake $</span><input class="input" id="' + pid + '-amount" data-f="amount" inputmode="decimal" value="' + esc(isFinite(amt) ? amt.toFixed(2) : "") + '"' + dis + "></label>" +
      '<div class="f-act"><button type="button" class="btn primary" data-act="log"' + dis + ">" + (saving ? "Saving…" : "Add to ledger") + "</button>" +
      '<button type="button" class="btn icon" data-act="remove" aria-label="Remove ' + esc(it.pick) + ' from your card"' + dis + ">✕</button></div>" +
      "</div>" + movedHtml(it) + "</li>";
  }

  function renderCard() {
    var sec = $("card");
    var ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "SELECT") && sec.contains(ae)) { cardPendingRender = true; return; }
    cardPendingRender = false;
    var items = card.slice().sort(function (a, b) {
      if (a.startISO !== b.startISO) return a.startISO < b.startISO ? -1 : 1;
      return (a.addedAt || 0) - (b.addedAt || 0);
    });
    $("card-meta").textContent = items.length ? items.length + (items.length === 1 ? " pick" : " picks") : "Empty";
    $("card-list").innerHTML = items.length ? items.map(itemHtml).join("")
      : '<li class="card-empty">Tap any price on the board to add that bet here. Once you’ve placed it in the sportsbook app, fix the odds or stake if they changed and press Add to ledger.</li>';
    var idle = items.filter(function (it) { return !busy[it.id]; });
    var all = $("log-all");
    all.hidden = idle.length < 2;
    all.textContent = "Add all " + idle.length + " to ledger";
  }

  function toLedgerBet(it) {
    var start = new Date(it.startISO);
    return {
      id: L.newId(),
      week: LS.cfbWeek(start),
      book: A.bookName(it.book),
      teams: it.teams,
      pick: it.pick,
      amount: Number(it.amount),
      odds: Number(it.odds),
      startTime: LS.localStamp(start),
      result: "pending",
      createdAt: Date.now(),
      importKey: it.id + ":" + (it.addedAt || 0),
      // Pressing Add to ledger right after betting makes this when the bet was placed.
      placedAt: LS.localStamp(new Date()),
      // Lets the morning grader find the game exactly.
      eventId: it.gameId,
      market: it.market,
      side: it.row
    };
  }

  function logItems(items) {
    items = items.filter(function (it) { return cardById(it.id) && !busy[it.id]; });
    if (!items.length) return;
    var go = function () {
      items = items.filter(function (it) { return cardById(it.id); });
      if (!items.length) return;
      var list = items.map(toLedgerBet);
      var message = items.length === 1
        ? "Ledger: add " + list[0].pick + " (" + A.money(list[0].amount) + " at " + list[0].book + ")"
        : "Ledger: add " + items.length + " bets from the card";
      items.forEach(function (it) { busy[it.id] = true; });
      cardStatus("");
      renderCard();
      A.ledger.add(list, message).then(function (res) {
        items.forEach(function (it) { delete busy[it.id]; removeItem(it.id); });
        var text = items.length === 1 ? "Added " + list[0].pick + " to your ledger." : "Added " + items.length + " bets to your ledger.";
        if (res && res.skipped) text += " " + (res.skipped === 1 ? "One was" : res.skipped + " were") + " already there.";
        cardStatus(text);
        renderCard(); renderBoard();
      }, function (err) {
        items.forEach(function (it) { delete busy[it.id]; });
        cardStatus(A.ledger.explain(err, go));
        renderCard();
      });
    };
    if (!A.token()) {
      A.openConnect({ reason: "To save bets from this device, connect it to GitHub. You only do this once on each device.", after: go });
      return;
    }
    go();
  }

  function onCardChange(e) {
    var inp = e.target;
    if (!inp.dataset || !inp.dataset.f) return;
    var li = inp.closest(".pick"), id = li && li.dataset.id, it = id && cardById(id);
    if (!it) return;
    var f = inp.dataset.f, v = inp.value.trim();
    if (f === "pick") {
      if (!v) { inp.value = it.pick; cardStatus("A pick needs a description, like “Iowa +4.5”."); return; }
      patchItem(id, { pick: v });
    } else if (f === "book") {
      // Betting it somewhere else: switch to that book's current line when it has one.
      var fields = { book: v };
      var g = findGame(it.gameId), o = g && LS.side(g, v, it.market, it.row);
      if (o) {
        fields.point = o.point; fields.price = o.price; fields.odds = o.price;
        fields.pick = LS.pickText(it.market, it.row, o, g.away, g.home);
      }
      patchItem(id, fields);
      cardPendingRender = true;
    } else if (f === "odds") {
      var n = L.parseOdds(v);
      if (n == null) { inp.value = LS.fmtPrice(Number(it.odds)).replace("−", "-"); cardStatus("Odds should look like -110 or +150."); return; }
      patchItem(id, { odds: n });
    } else if (f === "amount") {
      var a = L.parseAmount(v);
      if (a == null) { inp.value = Number(it.amount).toFixed(2); cardStatus("Stake should be a dollar amount above zero."); return; }
      patchItem(id, { amount: a });
      store.set("ls.stake", String(a));
      inp.value = a.toFixed(2);
    }
    cardStatus("");
    if (f === "book") { inp.blur(); renderCard(); }
  }

  function onCardClick(e) {
    var btn = e.target.closest("button[data-act]");
    if (!btn) return;
    var id = btn.closest(".pick").dataset.id, it = cardById(id);
    if (!it) return;
    if (btn.dataset.act === "remove") { removeItem(id); cardStatus(""); renderCard(); renderBoard(); }
    else if (btn.dataset.act === "log") logItems([it]);
  }

  // ---------- board ----------
  function lineLabel(market, row, o) {
    if (market === "spread") return '<span class="pt">' + LS.fmtSpread(o.point) + '</span><span class="pr">' + LS.fmtPrice(o.price) + "</span>";
    if (market === "total") return '<span class="pt">' + (row === "away" ? "O " : "U ") + LS.fmtNum(o.point) + '</span><span class="pr">' + LS.fmtPrice(o.price) + "</span>";
    return '<span class="pt">' + LS.fmtPrice(o.price) + "</span>";
  }

  // ---------- line moves ----------
  var moveTime = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric" });
  function historyFor(g) {
    if (state.source !== "live" || !state.history || !H) return null;
    var h = state.history.games[g.id];
    return h && h.lines && Object.keys(h.lines).length ? h : null;
  }
  function moveValue(market, o) {
    if (market === "spread") return LS.fmtSpread(o.point);
    if (market === "total") return LS.fmtNum(o.point);
    return LS.fmtPrice(o.price);
  }
  // The best line when the week opened, if it's a different number now (or a moneyline 10+ cents away).
  function openedFor(g, market, row, best) {
    var h = historyFor(g);
    var open = h && best.o ? H.opened(h, g.bookKeys, market, row) : null;
    return open && H.moved(market, open.o, best.o) ? open : null;
  }

  // One cell: the best line for this bet, and the book (or books) that have it.
  function cellHtml(g, market, row, best) {
    if (!best.o) return '<td class="cell empty" data-m="' + market + '">—</td>';
    var key = cardKey(g.id, market, row);
    var picked = !!cardById(key);
    var better = best.kind === "price" || best.kind === "line";
    var cls = "cell" + (better ? " best" : "") + (picked ? " picked" : "");
    var who = best.books.map(A.bookShort).join(" · ");
    var every = best.offers.map(function (x) { return A.bookName(x.book) + " " + LS.fmtLine(market, row, x.o); }).join(" · ");
    var open = openedFor(g, market, row, best);
    var title = every + ". " + (open ? "The best line opened at " + LS.fmtLine(market, row, open.o) + " (" + A.bookName(open.book) + ", " + moveTime.format(new Date(open.o.t)) + "). " : "") +
      (picked ? "Tap to take it off your card." : "Tap to add it to your card.");
    return '<td class="' + cls + '" data-m="' + market + '"><button type="button" class="pick-btn" data-key="' + esc(key) +
      '" data-game="' + esc(g.id) + '" data-market="' + market + '" data-row="' + row +
      '" aria-pressed="' + picked + '" title="' + esc(title) + '"><span class="num">' + lineLabel(market, row, best.o) + "</span>" +
      '<span class="who">' + esc(who) + "</span>" +
      (open ? '<span class="was">opened ' + esc(moveValue(market, open.o)) + "</span>" : "") + "</button></td>";
  }

  // Under the game: every change at each book, at the refresh that first saw it.
  function thinPath(market, list) {
    if (market !== "ml" || list.length < 3) return list;
    var out = [list[0]];
    for (var i = 1; i < list.length - 1; i++) if (LS.centsGap(list[i].price, out[out.length - 1].price) >= 5) out.push(list[i]);
    out.push(list[list.length - 1]);
    return out;
  }
  function movesHtml(g, h) {
    var keys = g.bookKeys.filter(function (k) { return h.lines[k] && h.lines[k].length; });
    var first = Math.min.apply(null, keys.map(function (k) { return h.lines[k][0][0] * 1000; }));
    var sets = [["spread", "Spread · " + LS.shortTeam(g.away)], ["total", "Total"], ["ml", "Moneyline · " + LS.shortTeam(g.away)]];
    var body = sets.map(function (s) {
      var m = s[0];
      var books = keys.map(function (k) {
        var p = thinPath(m, H.path(h, k, m, "away"));
        if (!p.length) return "";
        return '<div class="mv-book"><span class="mv-name">' + esc(A.bookShort(k)) + '</span><ol class="mv-path">' + p.map(function (c) {
          return "<li><b>" + esc(moveValue(m, c)) + "</b><small>" + esc(moveTime.format(new Date(c.t))) + "</small></li>";
        }).join("") + "</ol></div>";
      }).join("");
      return books ? '<div class="mv-mkt" data-m="' + m + '"><h4>' + esc(s[1]) + "</h4>" + books + "</div>" : "";
    }).join("");
    return '<div class="moves"><p class="mv-note">Every change at each book since ' + esc(moveTime.format(new Date(first))) +
      ", as of each refresh." + (g.live ? "" : " The last one before kickoff is the closing line.") + "</p>" + body + "</div>";
  }

  function sideLabel(g, market, row, o) {
    if (market === "total") return (row === "away" ? "Over " : "Under ") + LS.fmtNum(o.point);
    var team = row === "away" ? g.away : g.home;
    return market === "spread" ? team + " " + LS.fmtSpread(o.point) : team + " " + LS.fmtPrice(o.price);
  }
  function listJoin(items) {
    if (items.length <= 1) return items.join("");
    return items.slice(0, -1).join(", ") + " or " + items[items.length - 1];
  }

  // Middles and arbs pair two different books, so they're spelled out under the game.
  function notesHtml(item) {
    var g = item.g, out = [];
    item.a.opps.forEach(function (o) {
      var aw = sideLabel(g, o.market, "away", o.away) + (o.market === "ml" ? "" : " " + LS.fmtPrice(o.away.price));
      var hm = sideLabel(g, o.market, "home", o.home) + (o.market === "ml" ? "" : " " + LS.fmtPrice(o.home.price));
      var legs = aw + " at " + A.bookName(o.awayBook) + " and " + hm + " at " + A.bookName(o.homeBook);
      if (o.type === "middle") {
        var when;
        if (o.market === "total") when = "the final total is " + listJoin(o.hits.map(String));
        else {
          var homeWins = o.hits.filter(function (n) { return n > 0; });
          var awayWins = o.hits.filter(function (n) { return n < 0; }).map(function (n) { return -n; });
          var parts = [];
          if (homeWins.length) parts.push(g.home + " wins by " + listJoin(homeWins.map(String)));
          if (awayWins.length) parts.push(g.away + " wins by " + listJoin(awayWins.map(String)));
          when = parts.join(", or ");
        }
        out.push('<p class="flag"><span class="tag">Middle</span>' + esc(legs) + " both win if " + esc(when) + ".</p>");
      } else {
        out.push('<p class="flag"><span class="tag">Arb</span>' + esc(legs) + " add up to under 100% implied (" +
          (o.margin * 100).toFixed(1) + "% edge). Confirm both prices in the apps first; these rarely last.</p>");
      }
    });
    return out.length ? '<div class="notes">' + out.join("") + "</div>" : "";
  }

  // ---------- weather ----------
  var SKY = { clear: "Clear", partly: "Partly cloudy", cloudy: "Cloudy", fog: "Fog", drizzle: "Drizzle", rain: "Rain", snow: "Snow", storm: "Storms" };
  var WINDY = { wind: 15, gust: 25 };
  function weatherFor(g) {
    if (state.source !== "live" || !state.weather || g.live) return null;
    return state.weather[g.id] || null;
  }
  function isWindy(w) { return !!w && w.temp != null && ((w.wind || 0) >= WINDY.wind || (w.gust || 0) >= WINDY.gust); }
  function weatherText(w) {
    if (w.roof === "dome") return "Dome";
    if (w.roof === "retractable") return "Retractable roof";
    if (w.later || w.temp == null) return "Forecast closer to kickoff";
    var parts = [w.temp + "°"];
    if (w.precip != null && w.precip >= 20) parts.push((w.sky === "storm" ? "Storms" : w.snow ? "Snow" : "Rain") + " " + w.precip + "%");
    else if (w.sky && SKY[w.sky]) parts.push(SKY[w.sky]);
    if (w.wind != null) parts.push("Wind " + w.wind + " mph" + (w.gust != null && w.gust >= w.wind + 8 ? ", gusts " + w.gust : ""));
    return parts.join(" · ");
  }
  function weatherHtml(g) {
    var w = weatherFor(g);
    if (!w) return "";
    var where = [w.venue, w.city].filter(Boolean).join(", ") + (w.neutral ? " (neutral site)" : "");
    var title = where + (w.temp != null ? ". Forecast for kickoff and the next three hours, updated " + whenText(state.weatherAt) + "." : ".");
    return '<span class="wx' + (isWindy(w) ? " windy" : "") + '" title="' + esc(title) + '">' + esc(weatherText(w)) + "</span>";
  }

  function gameHtml(item, showDay) {
    var g = item.g, a = item.a, chips = [];
    if (state.source === "sample") chips.push('<span class="chip">Sample</span>');
    if (g.live) chips.push('<span class="chip live">In progress</span>');
    if (a.only) chips.push('<span class="chip">' + esc(A.bookName(a.only)) + " only</span>");
    var mids = a.opps.filter(function (o) { return o.type === "middle"; }).length;
    if (a.opps.length - mids) chips.push('<span class="chip flag">Arb</span>');
    if (mids) chips.push('<span class="chip flag">Middle</span>');
    if (isWindy(weatherFor(g))) chips.push('<span class="chip flag">Windy</span>');

    var hist = historyFor(g), open = hist && !!state.movesOpen[g.id];
    var big = hist && !g.live ? H.bigMoves(hist, g.bookKeys, Date.now()) : [];
    if (big.length) {
      var why = big.map(function (m) {
        return H.moveText(g, m) + " at " + A.bookName(m.book) + ", " + H.pointsText(m.move) + " since " + moveTime.format(new Date(m.since));
      }).join(". ");
      chips.push('<span class="chip big" title="' + esc(why + ". More than 1 point in a day, 2 in two days, and so on, is a big move.") + '">Big move</span>');
    }
    if (hist) {
      chips.push('<button type="button" class="chip moves-btn" data-game="' + esc(g.id) + '" aria-expanded="' + open + '">' +
        (open ? "Hide moves" : "Line moves") + "</button>");
    }
    var kick = (showDay ? shortDay.format(g.start) + " " : "") + timeFmt.format(g.start);
    var head = '<div class="game-head"><span class="kick">' + esc(kick) + "</span>" + weatherHtml(g) +
      '<span class="chips">' + chips.join("") + "</span></div>";
    var thead = '<thead><tr><th class="team-h"><span class="th-label">Rot &middot; Team</span></th>' +
      ["spread", "total", "ml"].map(function (m) { return '<th data-m="' + m + '">' + MARKET_NAME[m] + "</th>"; }).join("") + "</tr></thead>";
    var rows = ["away", "home"].map(function (r) {
      var rot = r === "away" ? g.awayRot : g.homeRot;
      var team = r === "away" ? g.away : g.home;
      var cells = ["spread", "total", "ml"].map(function (m) { return cellHtml(g, m, r, a.rows[m][r]); }).join("");
      var short = LS.shortTeam(team);
      var name = short && short !== team
        ? '<span class="wide-only">' + esc(team) + '</span><span class="narrow-only" title="' + esc(team) + '">' + esc(short) + "</span>"
        : esc(team);
      return '<tr><th scope="row" class="team"><span class="rot">' + (rot == null ? "" : esc(rot)) + "</span>" +
        name + (r === "home" ? ' <span class="home-tag">home</span>' : "") + "</th>" + cells + "</tr>";
    }).join("");
    return '<article class="game">' + head + '<table class="board">' + thead + "<tbody>" + rows + "</tbody></table>" +
      (open ? movesHtml(g, hist) : "") + notesHtml(item) + "</article>";
  }

  function renderStatus() {
    var st = $("status"), t = $("status-text");
    var stateName = state.source;
    if (state.source === "loading") t.textContent = "Loading lines…";
    else if (state.source === "sample") t.textContent = "Sample board";
    else {
      if (state.lastError || Date.now() - state.loadedAt.getTime() > STALE_MS) stateName = "stale";
      var s = "Updated " + whenText(state.loadedAt);
      if (state.credits != null && !isNaN(state.credits)) s += " · " + state.credits + " credits left";
      t.textContent = s;
    }
    st.dataset.state = stateName;
    st.title = state.loadedAt && state.source === "live" ? "Lines pulled " + state.loadedAt.toLocaleString() : "";
    $("sample-banner").hidden = state.source !== "sample";
    var msg = state.source === "loading" ? "" : dataNotice();
    var dn = $("data-notice");
    dn.textContent = msg;
    dn.hidden = !msg;
  }

  function renderTally() {
    if (state.source === "loading") { $("tally").innerHTML = ""; return; }
    var s = LS.summarize(windowGames());
    var cells = [
      [s.games, "Games"],
      [s.differ, "Books differ"],
      [s.lines, "Different lines"],
      [s.middles, "Middles", s.middles > 0],
      [s.arbs, "Arbs", s.arbs > 0]
    ];
    $("tally").innerHTML = cells.map(function (c) {
      return "<div" + (c[2] ? ' class="hot"' : "") + "><b>" + c[0] + "</b><span>" + c[1] + "</span></div>";
    }).join("");
  }

  function visibleGames() {
    var q = state.q.toLowerCase();
    var list = windowGames().filter(function (it) {
      if (state.onlyDiff && !(it.a.differs || it.a.opps.length)) return false;
      if (q && (it.g.away + " " + it.g.home).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    list.sort(function (x, y) {
      if (state.sort === "gap" && y.a.gap !== x.a.gap) return y.a.gap - x.a.gap;
      return x.g.start - y.g.start;
    });
    return list;
  }

  function renderBoard() {
    var board = $("board");
    board.dataset.market = state.market;
    var list = visibleGames();
    if (!list.length) {
      board.innerHTML = '<p class="empty-state">' + (state.source === "loading" ? "Loading lines…"
        : windowGames().length ? "No games match. Clear the team search or untick “Only games where the books differ.”"
        : state.games.length ? "No games posted for this week yet. Try All listed."
        : "No games on the board yet. They show up on the next refresh.") + "</p>";
      return;
    }
    if (state.sort === "gap") {
      board.innerHTML = list.map(function (it) { return gameHtml(it, true); }).join("");
      return;
    }
    var html = [], lastKey = null, groupCount = {};
    list.forEach(function (it) { var k = it.g.start.toDateString(); groupCount[k] = (groupCount[k] || 0) + 1; });
    list.forEach(function (it) {
      var k = it.g.start.toDateString();
      if (k !== lastKey) {
        lastKey = k;
        var n = groupCount[k];
        html.push('<h2 class="day">' + esc(dayFmt.format(it.g.start)) + " <small>" + esc(dateFmt.format(it.g.start)) +
          " &middot; " + n + (n === 1 ? " game" : " games") + "</small></h2>");
      }
      html.push(gameHtml(it, false));
    });
    board.innerHTML = html.join("");
  }

  function renderControls() {
    [["window-seg", state.windowMode], ["market-seg", state.market], ["sort-seg", state.sort]].forEach(function (pair) {
      var btns = $(pair[0]).querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) btns[i].setAttribute("aria-pressed", btns[i].dataset.v === pair[1] ? "true" : "false");
    });
  }

  function renderBooks() {
    var names = A.books().map(function (b) { return b.name; });
    var joined = names.length > 1 ? names.slice(0, -1).join(", ") + (names.length > 2 ? "," : "") + " and " + names[names.length - 1] : names[0];
    $("mast-sub").textContent = "Best line at " + joined + " · College football";
  }

  function render() { renderStatus(); renderTally(); renderControls(); renderBoard(); renderCard(); }

  // ---------- wiring ----------
  function seg(id, fn) {
    $(id).addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (b && b.dataset.v) fn(b.dataset.v);
    });
  }
  seg("window-seg", function (v) { state.windowMode = v; store.set("ls.window", v); render(); });
  seg("market-seg", function (v) { state.market = v; renderControls(); $("board").dataset.market = v; });
  seg("sort-seg", function (v) { state.sort = v; renderControls(); renderBoard(); });
  $("only-diff").addEventListener("change", function (e) { state.onlyDiff = e.target.checked; renderBoard(); });
  $("team-search").addEventListener("input", function (e) { state.q = e.target.value.trim(); renderBoard(); });

  $("board").addEventListener("click", function (e) {
    var mv = e.target.closest(".moves-btn");
    if (mv) {
      var id = mv.dataset.game;
      state.movesOpen[id] = !state.movesOpen[id];
      renderBoard();
      var again = $("board").querySelector('.moves-btn[data-game="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (again) again.focus();
      return;
    }
    var b = e.target.closest(".pick-btn");
    if (b) togglePick(b);
  });
  $("card-list").addEventListener("change", onCardChange);
  $("card-list").addEventListener("click", onCardClick);
  $("card").addEventListener("focusout", function () {
    setTimeout(function () { if (cardPendingRender) renderCard(); }, 0);
  });
  $("log-all").addEventListener("click", function () { logItems(card.slice()); });
  $("refresh-btn").addEventListener("click", onRefreshClick);
  $("run-on-github").addEventListener("click", function () {
    waitForRefresh("Once you press Run workflow on GitHub, the new lines show up here in about a minute.");
  });

  A.onBooks(function () {
    renderBooks();
    if (state.events && state.source !== "loading") setGames(state.events, state.source, state.loadedAt);
  });

  // Check for newer lines on open, whenever the page comes back into view, and every few minutes while it's showing.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") checkForLines();
  });
  window.addEventListener("pageshow", function (e) { if (e.persisted) checkForLines(); });
  setInterval(function () {
    if (document.visibilityState === "visible") checkForLines();
  }, POLL_MS);
  // Keep "Updated …" wording and the stale check current on a page left open.
  setInterval(function () { if (document.visibilityState === "visible") renderStatus(); }, 60 * 1000);

  loadLocalCard();
  renderBooks();
  render();
  renderRefresh();
  checkForLines();
  A.start();
})();
