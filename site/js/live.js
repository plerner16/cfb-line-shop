/* Live now: games in progress (and the ones finished today) from ESPN's free public scoreboard, checked
   every minute while games are on, next to each game's closing line and your bets on it. No credits:
   live betting odds aren't pulled. */
(function () {
  "use strict";
  var A = window.APP, LS = window.LS, L = window.LEDGER, H = window.LINE_HISTORY;
  var $ = A.$, esc = A.esc;
  var SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard";
  var FAST = 60 * 1000, SLOW = 10 * 60 * 1000;

  // ---------- teams ----------
  var ALIAS = { "southern mississippi": "southern miss", "appalachian state": "app state", "umass": "massachusetts",
    "sam houston state": "sam houston", "ul monroe": "louisiana monroe" };
  function norm(s) {
    var x = String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    Object.keys(ALIAS).forEach(function (k) { if (x === k || x.indexOf(k + " ") === 0) x = ALIAS[k] + x.slice(k.length); });
    return x;
  }
  function school(s) { var w = norm(s).split(" "); return w.length > 1 ? w.slice(0, -1).join(" ") : w[0]; }
  function sameTeam(a, b) { return norm(a) === norm(b) || school(a) === school(b); }
  // A pick's team ("Iowa", "Iowa St.") against a full name ("Iowa State Cyclones").
  function pickIsTeam(pickTeam, full) {
    var p = norm(String(pickTeam).replace(/\bst\.?$/i, "State"));
    return p === norm(full) || p === school(full) || norm(LS.shortTeam(full)) === p;
  }

  // ---------- ESPN ----------
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return "" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
  function parse(json) {
    return (json.events || []).map(function (ev) {
      var c = (ev.competitions || [])[0] || {};
      var st = (c.status || ev.status || {});
      var t = st.type || {};
      var side = function (ha) {
        var x = (c.competitors || []).filter(function (k) { return k.homeAway === ha; })[0];
        return x && { id: String(x.id || (x.team && x.team.id) || ""), name: x.team ? x.team.displayName : "", abbr: x.team ? (x.team.abbreviation || x.team.shortDisplayName) : "", score: Number(x.score) || 0 };
      };
      var away = side("away"), home = side("home");
      if (!away || !home) return null;
      var sit = c.situation || {};
      var link = ((ev.links || []).filter(function (l) { return (l.rel || []).indexOf("summary") >= 0; })[0] || {}).href || "";
      return {
        espnId: String(ev.id), start: c.date || ev.date, state: t.state || "pre", completed: !!t.completed,
        detail: t.shortDetail || t.detail || "", period: Number(st.period) || 0, clock: Number(st.clock) || 0,
        away: away, home: home,
        possession: sit.possession ? (String(sit.possession) === away.id ? "away" : String(sit.possession) === home.id ? "home" : null) : null,
        down: sit.downDistanceText || "", redZone: !!sit.isRedZone, link: link
      };
    }).filter(Boolean);
  }

  // The game in the site's line history, with ESPN's scores put the same way round.
  function match(e) {
    var hist = A.history(), t = Date.parse(e.start);
    if (!hist || !hist.games) return null;
    var ids = Object.keys(hist.games);
    for (var i = 0; i < ids.length; i++) {
      var g = hist.games[ids[i]];
      if (Math.abs(Date.parse(g.start) - t) > 36 * 3600e3) continue;
      if (sameTeam(g.away, e.away.name) && sameTeam(g.home, e.home.name)) return { id: ids[i], g: g, a: e.away.score, h: e.home.score, flip: false };
      if (sameTeam(g.away, e.home.name) && sameTeam(g.home, e.away.name)) return { id: ids[i], g: g, a: e.home.score, h: e.away.score, flip: true };
    }
    return null;
  }

  // ---------- lines and bets ----------
  function closing(g, market) {
    var books = Object.keys(g.lines || {}), pick = null;
    ["fanduel", "draftkings"].concat(books).some(function (k) {
      var c = g.lines[k] && (H.close(g, k, market, "away") || H.latest(g, k, market, "away"));
      if (c) pick = c;
      return !!c;
    });
    return pick;
  }
  // Minutes played, for the scoring pace (regulation only).
  function elapsed(e) {
    if (/half/i.test(e.detail)) return 30;
    if (e.period < 1 || e.period > 4) return null;
    return (e.period - 1) * 15 + (15 - e.clock / 60);
  }
  function by(x) { return LS.fmtNum(Math.abs(x)); }

  function coverText(m) {
    var sp = closing(m.g, "spread");
    if (!sp) return null;
    var margin = m.a - m.h, v = margin + sp.point; // the away side against the closing number
    var awayLine = LS.fmtSpread(sp.point), homeLine = LS.fmtSpread(-sp.point || 0);
    if (Math.abs(v) < 1e-9) return { text: "Right on the closing number", cls: "" };
    return v > 0
      ? { text: "Covering: " + LS.shortTeam(m.g.away) + " " + awayLine + " (by " + by(v) + ")", cls: "" }
      : { text: "Covering: " + LS.shortTeam(m.g.home) + " " + homeLine + " (by " + by(v) + ")", cls: "" };
  }
  function totalText(m, e) {
    var tot = closing(m.g, "total"), pts = m.a + m.h;
    var mins = e.state === "in" ? elapsed(e) : null;
    var pace = mins && mins >= 8 ? Math.round(pts * 60 / mins) : null;
    return pts + " points" + (tot ? " · total " + LS.fmtNum(tot.point) : "") + (pace != null ? " · on pace for " + pace : "");
  }

  function betsFor(m) {
    if (!A.ledger || !A.token()) return [];
    var t = Date.parse(m.g.start);
    return A.ledger.bets().filter(function (b) {
      if (b.eventId) return b.eventId === m.id;
      var parts = String(b.teams || "").split(/\s+@\s+|\s+vs\.?\s+/i);
      if (parts.length !== 2 || Math.abs(Date.parse(b.startTime) - t) > 36 * 3600e3) return false;
      return (pickIsTeam(parts[0], m.g.away) && pickIsTeam(parts[1], m.g.home)) || (pickIsTeam(parts[0], m.g.home) && pickIsTeam(parts[1], m.g.away));
    });
  }
  // How your bet stands on the current score.
  function betStatus(b, m, done) {
    var p = L.pickLine(b.pick);
    if (!p) return { text: "", cls: "" };
    var pts = m.a + m.h;
    if (p.market === "total") {
      var over = p.side === "away", d = pts - p.point;
      if (done) return d === 0 ? { text: "push", cls: "" } : (d > 0) === over ? { text: "won", cls: "pos" } : { text: "lost", cls: "neg" };
      if (over) return d > 0 ? { text: "already over", cls: "pos" } : { text: "needs " + by(d) + " more", cls: "" };
      return d > 0 ? { text: "already over", cls: "neg" } : d === 0 ? { text: "on the number", cls: "" } : { text: by(d) + " to spare", cls: "pos" };
    }
    var side = null;
    if (b.eventId === m.id && (b.side === "away" || b.side === "home") && b.market === p.market) side = b.side;
    else if (pickIsTeam(p.team, m.g.away)) side = "away";
    else if (pickIsTeam(p.team, m.g.home)) side = "home";
    if (!side) return { text: "", cls: "" };
    var margin = side === "away" ? m.a - m.h : m.h - m.a;
    var v = p.market === "spread" ? margin + p.point : margin;
    if (done) return v === 0 ? { text: "push", cls: "" } : v > 0 ? { text: "won", cls: "pos" } : { text: "lost", cls: "neg" };
    if (p.market === "ml") return v > 0 ? { text: "leading by " + by(v), cls: "pos" } : v < 0 ? { text: "trailing by " + by(v), cls: "neg" } : { text: "tied", cls: "" };
    return v > 0 ? { text: "covering by " + by(v), cls: "pos" } : v < 0 ? { text: "not covering, by " + by(v), cls: "neg" } : { text: "on the number", cls: "" };
  }

  // ---------- the list ----------
  var games = [];   // [{ e, m }] matched games, live first
  var lastError = null, fetchedAt = null;
  function rowHtml(x) {
    var e = x.e, m = x.m, done = e.state === "post";
    var g = m.g, aw = LS.shortTeam(g.away), hm = LS.shortTeam(g.home);
    var poss = !done && e.possession ? (m.flip ? (e.possession === "away" ? "home" : "away") : e.possession) : null;
    var cover = coverText(m);
    var bets = betsFor(m).map(function (b) {
      var s = betStatus(b, m, done);
      return '<li><span class="lb-pick">' + esc(b.pick) + "</span> " + esc(A.money(Number(b.amount) || 0)) + (s.text ? ' · <span class="' + s.cls + '">' + esc(s.text) + "</span>" : "") + "</li>";
    }).join("");
    return '<li class="lg' + (done ? " done" : "") + '" data-id="' + esc(m.id) + '">' +
      '<div class="lg-score">' +
        '<div class="lg-team' + (poss === "away" ? " poss" : "") + '"><span>' + esc(aw) + "</span><b>" + m.a + "</b></div>" +
        '<div class="lg-team' + (poss === "home" ? " poss" : "") + '"><span>' + esc(hm) + "</span><b>" + m.h + "</b></div>" +
      "</div>" +
      '<div class="lg-info">' +
        '<div class="lg-clock">' + esc(done ? "Final" + (/OT/.test(e.detail) ? " (OT)" : "") : e.detail) + (e.down && !done && !/half|end/i.test(e.detail) ? ' <span class="lg-down' + (e.redZone ? " rz" : "") + '">' + esc(e.down) + "</span>" : "") + "</div>" +
        (cover ? '<div class="lg-line">' + esc(done ? cover.text.replace(/^Covering: /, "Covered: ") : cover.text) + "</div>" : "") +
        '<div class="lg-line">' + esc(totalText(m, e)) + "</div>" +
        (bets ? '<ul class="lg-bets">' + bets + "</ul>" : "") +
      "</div>" +
      (e.link ? '<a class="lg-link" href="' + esc(e.link) + '" target="_blank" rel="noopener">Game on ESPN ↗</a>' : "") +
      "</li>";
  }
  function render() {
    var sec = $("live");
    var live = games.filter(function (x) { return x.e.state === "in"; });
    var done = games.filter(function (x) { return x.e.state === "post"; });
    if (!live.length && !done.length) { sec.hidden = true; A.setLive({}); return; }
    sec.hidden = false;
    $("live-meta").textContent = (live.length ? live.length + " in progress" : "No games on right now") + (fetchedAt ? " · " + timeFmt.format(fetchedAt) : "");
    $("live-list").innerHTML = live.map(rowHtml).join("");
    $("live-list").hidden = !live.length;
    $("live-done").hidden = !done.length;
    $("live-done-count").textContent = "Finished today (" + done.length + ")";
    $("live-done-list").innerHTML = done.map(rowHtml).join("");
    $("live-note").textContent = "Scores from ESPN, checked every minute while games are on. Lines are the last ones before kickoff." +
      (A.token() ? "" : " Connect this device (Ledger tab) to see your bets here too.") + (lastError ? " The last check didn't go through; trying again." : "");
    var map = {};
    live.forEach(function (x) { map[x.m.id] = { detail: x.e.detail, a: x.m.a, h: x.m.h }; });
    A.setLive(map);
  }
  var timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

  // ---------- checking ----------
  var timer = null, busy = false, askedLedger = false;
  function dates() {
    var now = new Date(), out = [ymd(now)];
    if (now.getHours() < 6) out.push(ymd(new Date(now.getTime() - 864e5)));
    return out;
  }
  function check() {
    if (busy || !A.history()) return schedule(SLOW);
    busy = true;
    return Promise.all(dates().map(function (d) {
      return fetch(SCOREBOARD + "?dates=" + d + "&groups=80&limit=300", { cache: "no-store" }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
    })).then(function (list) {
      var seen = {}, out = [];
      list.forEach(function (j) {
        parse(j).forEach(function (e) {
          if (seen[e.espnId] || e.state === "pre") return;
          seen[e.espnId] = true;
          var m = match(e);
          if (m) out.push({ e: e, m: m });
        });
      });
      out.sort(function (x, y) { return Date.parse(x.e.start) - Date.parse(y.e.start); });
      games = out;
      lastError = null;
      fetchedAt = new Date();
      if (!askedLedger && A.ledger && A.token() && out.length) { askedLedger = true; A.ledger.load().then(render, render); }
      render();
    }, function (err) {
      lastError = err;
      if (games.length) render();
    }).then(function () {
      busy = false;
      schedule(nextWait());
    });
  }
  // Every minute while a game is on or about to start; otherwise every ten minutes.
  function nextWait() {
    if (games.some(function (x) { return x.e.state === "in"; })) return FAST;
    var hist = A.history(), now = Date.now();
    var soon = hist && hist.games && Object.keys(hist.games).some(function (id) {
      var t = Date.parse(hist.games[id].start);
      return t > now - 4 * 3600e3 && t < now + 45 * 60e3;
    });
    return soon ? FAST : SLOW;
  }
  function schedule(ms) {
    clearTimeout(timer);
    if (document.hidden || A.currentView() !== "lines") return;
    timer = setTimeout(check, ms);
  }
  function wake() {
    if (document.hidden || A.currentView() !== "lines") { clearTimeout(timer); return; }
    check();
  }

  document.addEventListener("visibilitychange", wake);
  A.onView(function () { wake(); });
  A.onHistory(function () { if (!fetchedAt) wake(); });
  A.onDevice(function () { askedLedger = false; render(); });

  // For tests: read a scoreboard without fetching.
  A.liveParse = parse;
})();
