/* The Ledger tab: bets saved in bets.json in the private cfb-bet-ledger repository.
   Reading and saving both need this device's GitHub token. */
(function () {
  "use strict";
  var A = window.APP, L = window.LEDGER, LS = window.LS, H = window.LINE_HISTORY;
  var $ = A.$, esc = A.esc;

  var CONTENTS = A.LEDGER_API + "/contents/bets.json";
  var POLL_MS = 5 * 60 * 1000;

  // What GitHub has, and the changes on their way there (shown right away).
  var server = { bets: [], sha: null, loaded: false, at: null };
  var pending = [];
  var loadProblem = "";

  var ui = {
    sort: A.store.get("ls.ledgerSort") === "start" ? "start" : "week",
    book: A.store.get("ls.ledgerBook") || "all",
    editing: null,
    confirmDelete: null,
    open: {}
  };

  function bets() {
    return pending.reduce(function (list, p) { return L.applyChange(list, p.change).bets; }, server.bets);
  }

  // ---------- reading ----------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Reads the ledger. Failures come back as { code, status }:
  //   "locked"   the repository is private and this device isn't connected
  //   "token"    this device's token can't open it (expired, or made without Contents access)
  //   "network" / "http"
  // A ledger that can't be opened is never shown as an empty one.
  async function fetchLatest() {
    var tok = A.token();
    var res;
    try {
      res = await A.gh("GET", CONTENTS + "?ref=main", tok || null);
    } catch (e) {
      throw { code: "network" };
    }
    if (res.ok) {
      var j = await res.json();
      return { bets: L.parseDoc(L.fromBase64(j.content)).bets, sha: j.sha };
    }
    if (tok && (res.status === 401 || res.status === 403 || res.status === 404)) throw { code: "token", status: res.status };
    if (!tok && (res.status === 404 || res.status === 401 || res.status === 403)) throw { code: "locked" };
    throw { code: "http", status: res.status };
  }

  function loadText(err) {
    if (err.code === "network") return "Couldn't reach GitHub to load the ledger. Check your connection; it tries again on its own.";
    return "GitHub answered with error " + err.status + " when loading the ledger. It tries again on its own.";
  }

  var loading = null;
  var access = null; // null when the ledger opened; otherwise the "locked" / "token" failure
  function load() {
    if (loading || pending.length) return loading || Promise.resolve();
    loading = fetchLatest().then(function (doc) {
      if (!pending.length) { server.bets = doc.bets; server.sha = doc.sha; }
      server.loaded = true;
      server.at = new Date();
      loadProblem = "";
      access = null;
    }, function (err) {
      if (err && (err.code === "locked" || err.code === "token")) {
        access = err;
        loadProblem = "";
        // What this device showed before is no longer something it may see.
        server = { bets: [], sha: null, loaded: false, at: null };
      } else {
        loadProblem = loadText(err || {});
      }
    }).then(function () { loading = null; render(); });
    return loading;
  }

  // ---------- saving ----------
  // Changes save one at a time. If the file changed on GitHub since we read it (another device,
  // or a quick double tap), re-read it and apply the change again on top.
  var chain = Promise.resolve();
  function save(change, message) {
    var p = { change: change, message: message };
    pending.push(p);
    render();
    var run = chain.then(function () { return commit(p, 0); });
    chain = run.catch(function () {});
    return run;
  }
  function drop(p) { pending = pending.filter(function (x) { return x !== p; }); }
  function fail(p, err) { drop(p); render(); throw err; }

  async function commit(p, attempt) {
    var tok = A.token();
    if (!tok) return fail(p, { code: "token", status: 0 });
    if (!server.loaded || !server.sha) {
      try {
        var first = await fetchLatest();
        server.bets = first.bets; server.sha = first.sha; server.loaded = true;
      } catch (e) { return fail(p, e && e.code === "token" ? e : { code: e && e.code === "http" ? "http" : "network", status: e && e.status }); }
    }
    var next = L.applyChange(server.bets, p.change);
    if (!next.changed) { drop(p); render(); return next; } // already there, or deleted elsewhere
    var body = { message: p.message, content: L.toBase64(L.formatDoc(next.bets)), branch: "main" };
    if (server.sha) body.sha = server.sha;
    var res;
    try { res = await A.gh("PUT", CONTENTS, tok, body); } catch (e) { return fail(p, { code: "network" }); }
    if (res.ok) {
      var j = await res.json();
      server.bets = next.bets;
      server.sha = j.content && j.content.sha;
      server.at = new Date();
      drop(p);
      render();
      return next;
    }
    if ((res.status === 409 || res.status === 422) && attempt < 4) {
      await sleep(700 * (attempt + 1));
      try {
        var latest = await fetchLatest();
        server.bets = latest.bets; server.sha = latest.sha;
      } catch (e) { return fail(p, e && e.code === "token" ? e : { code: e && e.code === "http" ? "http" : "network", status: e && e.status }); }
      return commit(p, attempt + 1);
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) return fail(p, { code: "token", status: res.status });
    return fail(p, { code: "http", status: res.status });
  }

  // Turns a failed save into what to do next. Token problems open the connect panel (and retry once
  // connected); anything else comes back as a sentence to show.
  function explain(err, retry) {
    if (err && err.code === "token") {
      A.openConnect({
        reason: err.status ? A.tokenProblem(err.status, "ledger")
          : "To save bets from this device, connect it to GitHub. You only do this once on each device.",
        after: retry
      });
      return "";
    }
    if (err && err.code === "network") return "Couldn't reach GitHub, so that wasn't saved. Check your connection and try again.";
    return "GitHub answered with error " + (err && err.status) + ", so that wasn't saved. Try again in a minute.";
  }

  function notice(text) { var n = $("ledger-notice"); n.textContent = text || ""; n.hidden = !text; }

  function run(change, message) {
    notice("");
    var go = function () {
      return save(change, message).catch(function (err) {
        var msg = explain(err, go);
        if (msg) notice(msg);
      });
    };
    return go();
  }

  // For the card on the Lines tab.
  function add(list, message) {
    return save({ type: "add", bets: list }, message);
  }

  // ---------- formatting ----------
  var startFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
  var syncFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  var placedFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
  function fmtStart(raw) {
    if (!raw) return "";
    var d = new Date(raw);
    return isNaN(d.getTime()) ? "" : startFmt.format(d);
  }
  function fmtOdds(n) { return LS.fmtPrice(Number(n)); }
  function startKey(b) {
    var t = b.startTime ? new Date(b.startTime).getTime() : NaN;
    return isFinite(t) ? t : Infinity;
  }
  function label(b) { return b.pick + (b.teams ? " (" + b.teams + ")" : ""); }

  // ---------- against the closing line ----------
  var seenFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  function bookKeyFor(name) {
    var n = String(name || "").toLowerCase();
    var list = A.books();
    for (var i = 0; i < list.length; i++) if (list[i].name.toLowerCase() === n || list[i].key === n) return list[i].key;
    return null;
  }
  // The line a bet is measured against: the close the morning grader saved with it, or, for bets added
  // from the card, this week's line history (the close once the game kicks off, the line now before that).
  function lineFor(b, p) {
    if (b.close && typeof b.close.odds === "number") {
      return { kind: "close", o: { point: b.close.line == null ? null : b.close.line, price: b.close.odds }, book: b.close.book, t: Date.parse(b.close.at) };
    }
    var hist = A.history();
    var g = H && hist && hist.games && b.eventId ? hist.games[b.eventId] : null;
    if (!g || !g.lines || b.market !== p.market || (b.side !== "away" && b.side !== "home")) return null;
    var side = p.market === "total" ? p.side : b.side;
    var started = Date.parse(g.start) <= Date.now();
    var get = started ? H.close : H.latest;
    var key = bookKeyFor(b.book), pick = null;
    if (key && g.lines[key]) { var o = get(g, key, p.market, side); if (o) pick = { book: key, o: o }; }
    if (!pick) pick = H.bestOf(p.market, side, Object.keys(g.lines).map(function (k) { return { book: k, o: get(g, k, p.market, side) }; }));
    return pick ? { kind: started ? "close" : "now", o: pick.o, book: A.bookName(pick.book), t: pick.o.t } : null;
  }
  // How a bet's line compares with that line ({ dir, points, cents, kind, line, p }), or null.
  // Bets placed after kickoff aren't measured: the close doesn't apply to an in-game line.
  function measured(b) {
    var p = L.pickLine(b.pick);
    if (!p || !H || !isFinite(Number(b.odds))) return null;
    var placed = L.placedInfo(b), lead = L.leadHours(b);
    if (placed && placed.exact && lead != null && lead < 0) return null;
    var line = lineFor(b, p);
    if (!line || (p.market !== "ml" && line.o.point == null)) return null;
    var c = H.compare(p.market, p.side, { point: p.point, price: Number(b.odds) }, line.o);
    c.kind = line.kind; c.line = line; c.p = p;
    return c;
  }
  function vsClose(b) { var c = measured(b); return c && c.kind === "close" ? c : null; }

  function lineText(p, o) {
    if (p.market === "spread") return LS.fmtSpread(o.point) + " " + LS.fmtPrice(o.price);
    if (p.market === "total") return (p.side === "away" ? "O " : "U ") + LS.fmtNum(o.point) + " " + LS.fmtPrice(o.price);
    return LS.fmtPrice(o.price);
  }
  function gapText(c) {
    if (c.points) return LS.fmtNum(Math.abs(c.points)) + (Math.abs(c.points) === 1 ? " point" : " points");
    return Math.abs(c.cents) + "¢";
  }
  function closeLineHtml(b) {
    var c = measured(b);
    if (!c) return "";
    var line = c.line, head;
    if (c.kind === "now") head = "Now " + lineText(c.p, line.o);
    else {
      var kick = Date.parse(b.startTime);
      head = isFinite(kick) && isFinite(line.t) && kick - line.t > 6 * 3600e3
        ? "Last line seen " + seenFmt.format(new Date(line.t)) + ": " + lineText(c.p, line.o)
        : "Closed " + lineText(c.p, line.o);
    }
    var verdict = c.dir > 0 ? (c.kind === "close" ? "you beat it by " : "yours is better by ") + gapText(c)
      : c.dir < 0 ? gapText(c) + " better than yours" : "same as yours";
    var title = c.kind === "close"
      ? "The last line the site saw before kickoff" + (line.book ? " at " + line.book : "") + ", compared with the line you got."
      : "The line" + (line.book ? " at " + line.book : "") + " as of the latest refresh, compared with the line you got.";
    return '<div class="bet-close" title="' + esc(title) + '">' + esc(head + (line.book ? " at " + line.book : "")) + ' · <span class="' +
      (c.dir > 0 ? "pos" : c.dir < 0 ? "neg" : "") + '">' + esc(verdict) + "</span></div>";
  }

  // ---------- rendering ----------
  function renderTally(list) {
    var s = L.summary(list);
    var netCls = s.net > 0.004 ? " pos" : s.net < -0.004 ? " neg" : "";
    $("ledger-tally").innerHTML =
      "<div><b>" + esc(A.money(s.wagered)) + "</b><span>Wagered</span></div>" +
      '<div class="net' + netCls + '"><b>' + esc(A.money(s.net, true)) + "</b><span>Net</span></div>" +
      "<div><b>" + s.wins + "-" + s.losses + "-" + s.pushes + "</b><span>Record</span></div>" +
      "<div><b>" + s.pending + "</b><span>Pending</span></div>" + closeTallyHtml(list);
  }
  function closeTallyHtml(list) {
    var c = L.closeSummary(list, vsClose);
    if (!c.closed) return "";
    return '<div title="' + esc(c.beat + " of " + c.closed + " bets got a better number or price than the closing line (" + c.same + " the same, " + c.worse + " worse)") + '"><b>' +
      Math.round(c.beat / c.closed * 100) + "%</b><span>Beat the close</span></div>";
  }

  // Early vs late: how bets did by how long before kickoff they were placed.
  function renderTiming(list) {
    var t = L.timing(list, vsClose);
    var rows = t.rows.filter(function (r) { return r.bets > 0 || r.key !== "live"; });
    var known = t.rows.reduce(function (n, r) { return n + r.bets; }, 0);
    if (!known) { $("ledger-timing").hidden = true; return; }
    $("ledger-timing").hidden = false;
    $("timing-body").innerHTML = rows.map(function (r) {
      var settled = r.wins + r.losses + r.pushes;
      var ret = r.stake > 0 ? r.net / r.stake : null;
      var cls = settled ? (r.net > 0.004 ? "pos" : r.net < -0.004 ? "neg" : "") : "";
      return "<tr><th scope=\"row\">" + esc(r.label) + '<span class="sub">' + r.bets + (r.bets === 1 ? " bet" : " bets") + "</span>" + (r.pending ? '<span class="sub">' + r.pending + " pending</span>" : "") + "</th>" +
        "<td>" + (settled ? r.wins + "-" + r.losses + "-" + r.pushes : "—") + "</td>" +
        '<td class="' + cls + '">' + (settled ? esc(A.money(r.net, true)) : "—") + "</td>" +
        '<td class="' + cls + '">' + (ret == null ? "—" : (ret > 0 ? "+" : ret < 0 ? "−" : "") + Math.abs(Math.round(ret * 100)) + "%") + "</td>" +
        "<td" + (r.closed ? ' title="' + r.beat + " of " + r.closed + ' bets beat the closing line"' : "") + ">" +
        (r.closed ? Math.round(r.beat / r.closed * 100) + '%<span class="sub">' + r.beat + "/" + r.closed + "</span>" : "—") + "</td></tr>";
    }).join("");
    $("timing-note").textContent = (t.unknown
      ? t.unknown + (t.unknown === 1 ? " bet has" : " bets have") + " no placed time (logged after the game started), so " + (t.unknown === 1 ? "it's" : "they're") + " left out. Older bets logged before kickoff count from when they were logged; new ones from when you press Add to ledger."
      : "Bets count from when you pressed Add to ledger or the time you entered.") +
      " Beat close is how often you got a better number or price than the last line before kickoff at the same book; the same line doesn't count.";
  }

  function renderBookFilter(list) {
    var names = {};
    list.forEach(function (b) { if (b.book) names[b.book] = true; });
    var all = Object.keys(names).sort(function (a, b) { return a.localeCompare(b); });
    if (ui.book !== "all" && all.indexOf(ui.book) < 0) ui.book = "all";
    $("ledger-books").innerHTML = ["all"].concat(all).map(function (name) {
      return '<button type="button" data-v="' + esc(name) + '" aria-pressed="' + (ui.book === name) + '">' + esc(name === "all" ? "All books" : name) + "</button>";
    }).join("");
    $("ledger-books").hidden = all.length < 2;
    var sb = $("ledger-sort").querySelectorAll("button");
    for (var i = 0; i < sb.length; i++) sb[i].setAttribute("aria-pressed", sb[i].dataset.v === ui.sort ? "true" : "false");
  }

  function resultButtons(b) {
    return '<div class="res" role="group" aria-label="Result">' + [["win", "W", "Won"], ["loss", "L", "Lost"], ["push", "P", "Push"]].map(function (r) {
      return '<button type="button" class="res-' + r[0] + '" data-act="result" data-v="' + r[0] + '" aria-pressed="' + (b.result === r[0]) + '" title="' + r[2] + '">' + r[1] + "</button>";
    }).join("") + "</div>";
  }

  function betHtml(b) {
    if (ui.editing === b.id) return editHtml(b);
    var saving = pending.some(function (p) { return p.change.id === b.id || (p.change.bets && p.change.bets.some(function (x) { return x.id === b.id; })); });
    var pl = L.profitFor(b);
    var plText = b.result === "pending" || !b.result ? "pending" : b.result === "push" ? "push" : A.money(pl, true);
    var plCls = b.result === "win" ? "pos" : b.result === "loss" ? "neg" : "";
    var meta = [fmtStart(b.startTime), b.book, fmtOdds(b.odds)];
    if (ui.sort === "start") meta.push(L.displayWeek(b.week));
    if (b.final && b.result && b.result !== "pending") meta.push("Final: " + b.final);
    var del = ui.confirmDelete === b.id;
    var placed = L.placedInfo(b), lead = L.leadHours(b);
    var placedLine = placed
      ? '<div class="bet-placed"' + (placed.exact ? "" : ' title="When it was logged; no placed time was saved for this bet"') + ">" +
        (placed.exact ? "Placed " : "Logged ") + esc(placedFmt.format(new Date(placed.ms))) + (lead != null ? " · " + esc(L.leadText(lead)) : "") + "</div>"
      : "";
    placedLine += closeLineHtml(b);
    return '<li class="bet' + (saving ? " saving" : "") + '" data-id="' + esc(b.id) + '">' +
      '<div class="bet-main">' + (b.teams ? '<div class="bet-teams">' + esc(b.teams) + "</div>" : "") +
      '<div class="bet-pick">' + esc(b.pick) + "</div>" +
      '<div class="bet-meta">' + meta.filter(Boolean).map(esc).join(" · ") +
      (b.gradedBy === "auto" && b.result && b.result !== "pending" ? ' <span class="auto-tag" title="Graded automatically from the final score">Auto</span>' : "") + "</div>" + placedLine + "</div>" +
      '<div class="bet-figs"><span class="wager">' + esc(A.money(b.amount)) + '</span><span class="pl ' + plCls + '">' + esc(plText) + "</span></div>" +
      '<div class="bet-ctl">' + resultButtons(b) +
      '<button type="button" class="btn icon" data-act="edit" aria-label="Edit ' + esc(b.pick) + '">✎</button>' +
      '<button type="button" class="btn icon' + (del ? " danger" : "") + '" data-act="delete" aria-label="Delete ' + esc(b.pick) + '">' + (del ? "Delete?" : "✕") + "</button>" +
      "</div></li>";
  }

  function bookOptions(current) {
    var names = A.books().map(function (b) { return b.name; });
    var known = names.indexOf(current) >= 0;
    return names.map(function (n) { return '<option value="' + esc(n) + '"' + (n === current ? " selected" : "") + ">" + esc(n) + "</option>"; }).join("") +
      '<option value="__other"' + (!known && current ? " selected" : "") + ">Other…</option>";
  }

  // The same fields for a new bet and for editing one.
  function fieldsHtml(prefix, b) {
    var known = A.books().some(function (x) { return x.name === b.book; });
    return '<div class="form-grid">' +
      '<label><span class="mini">Week</span><input class="input" name="week" inputmode="numeric" value="' + esc(L.normWeek(b.week)) + '"></label>' +
      '<label><span class="mini">Sportsbook</span><select class="input" name="book">' + bookOptions(b.book) + "</select>" +
      '<input class="input other-book" name="bookOther" placeholder="Sportsbook name" value="' + esc(known ? "" : (b.book || "")) + '"' + (known || !b.book ? " hidden" : "") + "></label>" +
      '<label class="wide"><span class="mini">Matchup</span><input class="input" name="teams" placeholder="Penn State @ Iowa" value="' + esc(b.teams || "") + '"></label>' +
      '<label class="wide"><span class="mini">Pick</span><input class="input" name="pick" placeholder="Iowa +4.5" value="' + esc(b.pick || "") + '"></label>' +
      '<label><span class="mini">Stake $</span><input class="input" name="amount" inputmode="decimal" value="' + esc(b.amount ? Number(b.amount).toFixed(2) : "") + '"></label>' +
      '<label><span class="mini">Odds</span><input class="input" name="odds" placeholder="-110" value="' + esc(b.odds ? fmtOdds(b.odds).replace("−", "-") : "") + '"></label>' +
      '<label class="wide"><span class="mini">Kickoff</span><input class="input" type="datetime-local" name="startTime" value="' + esc(b.startTime || "") + '"></label>' +
      '<label class="wide"><span class="mini">Placed</span><input class="input" type="datetime-local" name="placedAt" value="' + esc(b.placedAt || "") + '"></label>' +
      "</div>";
  }

  function editHtml(b) {
    return '<li class="bet editing" data-id="' + esc(b.id) + '"><form class="bet-edit" data-id="' + esc(b.id) + '">' + fieldsHtml("e", b) +
      '<p class="form-error" hidden></p>' +
      '<div class="row"><button type="submit" class="btn primary">Save</button><button type="button" class="btn" data-act="cancel">Cancel</button></div></form></li>';
  }

  // Reads a bet form; returns the fields or an error sentence.
  function readForm(form) {
    var get = function (n) { return (form.elements[n].value || "").trim(); };
    var book = get("book") === "__other" ? get("bookOther") : get("book");
    var f = {
      week: L.normWeek(get("week")),
      book: book,
      teams: get("teams"),
      pick: get("pick"),
      amount: L.parseAmount(get("amount")),
      odds: L.parseOdds(get("odds")),
      startTime: get("startTime"),
      placedAt: get("placedAt")
    };
    if (!f.pick) return { error: "Add the pick, like “Iowa +4.5”." };
    if (!f.book) return { error: "Choose the sportsbook." };
    if (f.amount == null) return { error: "The stake should be a dollar amount above zero." };
    if (f.odds == null) return { error: "Odds should look like -110 or +150." };
    if (f.placedAt && !isFinite(Date.parse(f.placedAt))) return { error: "The placed time doesn't look right." };
    return { fields: f };
  }

  function weekGroups(list) {
    var by = {};
    list.forEach(function (b) {
      var k = L.normWeek(b.week) || "";
      (by[k] = by[k] || []).push(b);
    });
    return Object.keys(by).sort(function (a, b) { return L.weekSortKey(b) - L.weekSortKey(a); }).map(function (k) {
      return { week: k, bets: by[k].sort(function (a, b) { return startKey(a) - startKey(b); }) };
    });
  }

  var rendered = false;
  function render() {
    if (A.currentView() !== "ledger" && rendered) { renderStatus(); return; }
    var ae = document.activeElement;
    if (ae && $("ledger-list").contains(ae) && ae.closest("form")) { renderStatus(); renderTally(bets()); return; } // don't wipe an edit in progress
    rendered = true;
    var all = bets();
    renderTally(all);
    renderTiming(all);
    renderBookFilter(all);
    renderStatus();
    var list = ui.book === "all" ? all : all.filter(function (b) { return b.book === ui.book; });
    var box = $("ledger-list");
    if (access && !all.length) {
      box.innerHTML = '<div class="empty-state locked"><p>' + esc(access.code === "locked"
        ? "Your ledger is private. Connect this device to GitHub to see it; you only do this once on each device."
        : A.tokenProblem(access.status, "ledger")) + '</p><button type="button" class="btn primary" id="ledger-unlock">Connect this device</button></div>';
      return;
    }
    if (!server.loaded && !all.length) {
      box.innerHTML = '<p class="empty-state">' + (loadProblem ? esc(loadProblem) : "Loading your ledger…") + "</p>";
      return;
    }
    if (!list.length) {
      box.innerHTML = '<p class="empty-state">' + (all.length ? "No bets at " + esc(ui.book) + " yet." : "No bets yet. Tap a price on the Lines tab, or log one by hand above.") + "</p>";
      return;
    }
    if (ui.sort === "start") {
      box.innerHTML = '<ul class="bets sheet">' + list.slice().sort(function (a, b) { return startKey(b) - startKey(a); }).map(betHtml).join("") + "</ul>";
      return;
    }
    var groups = weekGroups(list);
    box.innerHTML = groups.map(function (g, i) {
      var settled = g.bets.filter(function (b) { return b.result && b.result !== "pending"; });
      var net = settled.reduce(function (n, b) { return n + L.profitFor(b); }, 0);
      var hasPending = g.bets.some(function (b) { return !b.result || b.result === "pending"; });
      var open = ui.open.hasOwnProperty(g.week) ? ui.open[g.week] : (i === 0 || hasPending);
      var netCls = settled.length ? (net > 0.004 ? "pos" : net < -0.004 ? "neg" : "") : "";
      return '<details class="wk" data-week="' + esc(g.week) + '"' + (open ? " open" : "") + ">" +
        '<summary><span class="wk-name">' + esc(L.displayWeek(g.week)) + '</span><small>' + g.bets.length + (g.bets.length === 1 ? " bet" : " bets") +
        (hasPending ? " · " + g.bets.filter(function (b) { return !b.result || b.result === "pending"; }).length + " pending" : "") + "</small>" +
        '<span class="wk-net ' + netCls + '">' + (settled.length ? esc(A.money(net, true)) : "—") + "</span></summary>" +
        '<ul class="bets sheet">' + g.bets.map(betHtml).join("") + "</ul></details>";
    }).join("");
  }

  function renderStatus() {
    var st = $("ledger-status"), t = $("ledger-status-text");
    if (pending.length) { st.dataset.state = "saving"; t.textContent = "Saving…"; }
    else if (access) { st.dataset.state = "sample"; t.textContent = access.code === "locked" ? "Private" : "Reconnect"; }
    else if (loadProblem && !server.loaded) { st.dataset.state = "stale"; t.textContent = "Couldn't load"; }
    else if (!server.loaded) { st.dataset.state = "loading"; t.textContent = "Loading…"; }
    else if (!A.token()) { st.dataset.state = "sample"; t.textContent = "View only"; }
    else { st.dataset.state = "live"; t.textContent = "Saved"; }
    st.title = server.at ? "Last synced " + server.at.toLocaleString() : "";
    $("ledger-readonly").hidden = !!A.token() || !server.loaded;
    $("ledger-synced").textContent = server.at ? " Last synced " + syncFmt.format(server.at) + "." : "";
  }

  // ---------- events ----------
  function needsDevice(retry) {
    if (A.token()) return false;
    A.openConnect({ reason: "To log bets and mark results from this device, connect it to GitHub. You only do this once on each device.", after: retry });
    return true;
  }

  $("ledger-list").addEventListener("click", function (e) {
    if (e.target.closest("#ledger-unlock")) {
      A.openConnect({
        reason: access && access.code === "token" ? A.tokenProblem(access.status, "ledger") : "Connect this device to see your ledger. You only do this once on each device.",
        after: load
      });
      return;
    }
    var btn = e.target.closest("button[data-act]");
    if (!btn) return;
    var li = btn.closest(".bet"), id = li && li.dataset.id;
    var b = bets().filter(function (x) { return x.id === id; })[0];
    if (!b) return;
    var act = btn.dataset.act;
    if (act === "cancel") { ui.editing = null; render(); return; }
    if (act === "edit") { ui.editing = id; ui.confirmDelete = null; render(); var f = $("ledger-list").querySelector("form.bet-edit input"); if (f) f.focus(); return; }
    if (act === "delete") {
      if (ui.confirmDelete !== id) {
        ui.confirmDelete = id;
        render();
        setTimeout(function () { if (ui.confirmDelete === id) { ui.confirmDelete = null; render(); } }, 4000);
        return;
      }
      ui.confirmDelete = null;
      var doDelete = function () { run({ type: "remove", id: id }, "Ledger: delete " + label(b)); };
      if (!needsDevice(doDelete)) doDelete();
      return;
    }
    if (act === "result") {
      var next = b.result === btn.dataset.v ? "pending" : btn.dataset.v;
      var words = { win: "won", loss: "lost", push: "push", pending: "back to pending" };
      // Marked by hand: the morning grader leaves this bet alone from now on.
      var doSet = function () { run({ type: "update", id: id, fields: { result: next, gradedBy: "you" } }, "Ledger: " + b.pick + " " + words[next]); };
      if (!needsDevice(doSet)) doSet();
    }
  });

  $("ledger-list").addEventListener("submit", function (e) {
    var form = e.target.closest("form.bet-edit");
    if (!form) return;
    e.preventDefault();
    var r = readForm(form), err = form.querySelector(".form-error");
    if (r.error) { err.textContent = r.error; err.hidden = false; return; }
    var id = form.dataset.id;
    var doEdit = function () { run({ type: "update", id: id, fields: r.fields }, "Ledger: edit " + r.fields.pick); };
    ui.editing = null;
    if (document.activeElement) document.activeElement.blur();
    if (!needsDevice(doEdit)) doEdit();
    render();
  });

  function onBookSelect(e) {
    if (e.target.name !== "book") return;
    var other = e.target.parentNode.querySelector(".other-book");
    other.hidden = e.target.value !== "__other";
    if (!other.hidden) other.focus();
  }
  $("ledger-list").addEventListener("change", onBookSelect);
  $("bet-form-fields").addEventListener("change", onBookSelect);

  $("ledger-list").addEventListener("toggle", function (e) {
    var d = e.target;
    if (d.classList && d.classList.contains("wk")) ui.open[d.dataset.week] = d.open;
  }, true);

  function resetNewForm() {
    var now = new Date();
    $("bet-form-fields").innerHTML = fieldsHtml("n", {
      week: LS.cfbWeek(now), book: (A.books()[0] || {}).name, amount: parseFloat(A.store.get("ls.stake")) || 7.5,
      placedAt: LS.localStamp(now)
    });
    $("bet-form-error").hidden = true;
  }
  $("bet-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var r = readForm($("bet-form")), err = $("bet-form-error");
    if (r.error) { err.textContent = r.error; err.hidden = false; return; }
    err.hidden = true;
    var bet = r.fields;
    bet.id = L.newId();
    bet.result = "pending";
    bet.createdAt = Date.now();
    var doAdd = function () { run({ type: "add", bets: [bet] }, "Ledger: add " + bet.pick + " (" + A.money(bet.amount) + " at " + bet.book + ")"); };
    if (needsDevice(doAdd)) return;
    doAdd();
    resetNewForm();
    $("logbet").open = false;
  });

  $("ledger-sort").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    ui.sort = b.dataset.v;
    A.store.set("ls.ledgerSort", ui.sort);
    render();
  });
  $("ledger-books").addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (!b) return;
    ui.book = b.dataset.v;
    A.store.set("ls.ledgerBook", ui.book);
    render();
  });
  $("ledger-connect").addEventListener("click", function () {
    A.openConnect({ reason: "Connect this device to log bets and mark results. You only do this once on each device." });
  });

  A.onView(function (v) { if (v === "ledger") { render(); load(); } });
  // A token was saved or removed: open the ledger again with it.
  A.onDevice(function () {
    access = null;
    if (A.currentView() === "ledger") load(); else renderStatus();
  });
  A.onBooks(function () { resetNewForm(); });
  A.onHistory(function () { if (A.currentView() === "ledger" && rendered) render(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && A.currentView() === "ledger") load();
  });
  setInterval(function () {
    if (document.visibilityState === "visible" && A.currentView() === "ledger") load();
  }, POLL_MS);

  resetNewForm();
  A.ledger = { add: add, explain: explain, load: load, bets: bets };
})();
