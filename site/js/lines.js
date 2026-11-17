/* Line-shopping math. Pure functions, no DOM. Works for any number of books. */
(function (root) {
  "use strict";

  // The books shown on the board. The refresh job writes the current list into odds.json
  // (from site/books.json); this is only the fallback for the sample board.
  var DEFAULT_BOOKS = [
    { key: "fanduel", name: "FanDuel", short: "FD" },
    { key: "draftkings", name: "DraftKings", short: "DK" }
  ];
  var MARKETS = [
    { key: "spread", api: "spreads", name: "Spread" },
    { key: "total", api: "totals", name: "Total" },
    { key: "ml", api: "h2h", name: "Moneyline" }
  ];
  var EPS = 1e-9;

  function implied(p) { return p < 0 ? -p / (-p + 100) : 100 / (p + 100); }
  function decimal(p) { return p < 0 ? 1 + 100 / -p : 1 + p / 100; }
  // Price gap in "cents": -105 vs -115 = 10, +105 vs -105 = 10.
  function centsGap(a, b) {
    var x = function (p) { return p < 0 ? p + 100 : p - 100; };
    return Math.round(Math.abs(x(a) - x(b)));
  }

  function outcome(market, name) {
    if (!market || !market.outcomes) return null;
    for (var i = 0; i < market.outcomes.length; i++) {
      var o = market.outcomes[i];
      if (o.name === name && typeof o.price === "number") {
        return { price: o.price, point: typeof o.point === "number" ? o.point : null };
      }
    }
    return null;
  }

  function findMarket(bk, apiKey) {
    if (!bk || !bk.markets) return null;
    for (var i = 0; i < bk.markets.length; i++) if (bk.markets[i].key === apiKey) return bk.markets[i];
    return null;
  }

  function cleanBooks(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (b) {
      if (b && typeof b.key === "string" && b.key) {
        out.push({ key: b.key, name: String(b.name || b.key), short: String(b.short || b.name || b.key).slice(0, 4) });
      }
    });
    return out.length ? out : DEFAULT_BOOKS.slice();
  }

  // Board convention: the total's Over sits on the away row, the Under on the home row.
  function normalize(events, now, books) {
    books = cleanBooks(books);
    return (events || []).map(function (ev) {
      var lines = {};
      books.forEach(function (b) {
        var bk = (ev.bookmakers || []).filter(function (x) { return x.key === b.key; })[0];
        if (!bk) { lines[b.key] = null; return; }
        var sp = findMarket(bk, "spreads"), tot = findMarket(bk, "totals"), ml = findMarket(bk, "h2h");
        lines[b.key] = {
          spread: { away: outcome(sp, ev.away_team), home: outcome(sp, ev.home_team) },
          total: { away: outcome(tot, "Over"), home: outcome(tot, "Under") },
          ml: { away: outcome(ml, ev.away_team), home: outcome(ml, ev.home_team) }
        };
      });
      var start = new Date(ev.commence_time);
      return {
        id: ev.id,
        start: start,
        away: ev.away_team,
        home: ev.home_team,
        awayRot: ev.away_rotation == null ? null : ev.away_rotation,
        homeRot: ev.home_rotation == null ? null : ev.home_rotation,
        live: start.getTime() <= now.getTime(),
        bookKeys: books.map(function (b) { return b.key; }),
        books: lines
      };
    });
  }

  function side(game, bookKey, market, row) {
    var b = game.books[bookKey];
    return b ? b[market][row] : null;
  }

  // Is point a better than point b for this bet (from the bettor's side)?
  function pointBetter(market, row, a, b) {
    if (market === "total") return row === "away" ? a < b : a > b; // Over wants the lower total, Under the higher
    return a > b; // spreads: +3.5 beats +3, -3 beats -3.5
  }

  // > 0 when line a is better than line b: the better number wins, and on the same number the better price.
  function compareLines(market, row, a, b) {
    if (market !== "ml" && Math.abs(a.point - b.point) > EPS) return pointBetter(market, row, a.point, b.point) ? 1 : -1;
    var da = decimal(a.price), db = decimal(b.price);
    if (Math.abs(da - db) > EPS) return da > db ? 1 : -1;
    return 0;
  }

  // The best line for one bet across all the books.
  //   kind: "none"  no book has it
  //         "one"   only one book has it
  //         "same"  every book that has it agrees
  //         "price" same number everywhere, one or more books pay better
  //         "line"  one or more books have a better number
  //   books: every book offering that best line (more than one when they tie)
  function bestLine(game, market, row) {
    var offers = [];
    game.bookKeys.forEach(function (k) {
      var o = side(game, k, market, row);
      if (o) offers.push({ book: k, o: o });
    });
    if (!offers.length) return { kind: "none", o: null, books: [], offers: offers, gap: 0 };
    var top = offers[0];
    offers.forEach(function (x) { if (compareLines(market, row, x.o, top.o) > 0) top = x; });
    var tied = [], rest = [];
    offers.forEach(function (x) { (compareLines(market, row, x.o, top.o) === 0 ? tied : rest).push(x); });
    var lineDiff = rest.some(function (x) { return market !== "ml" && Math.abs(x.o.point - top.o.point) > EPS; });
    var kind = offers.length === 1 ? "one" : !rest.length ? "same" : lineDiff ? "line" : "price";
    var gap = 0;
    rest.forEach(function (x) {
      if (market !== "ml" && Math.abs(x.o.point - top.o.point) > EPS) gap = Math.max(gap, Math.abs(x.o.point - top.o.point) * 20);
      else gap = Math.max(gap, centsGap(top.o.price, x.o.price));
    });
    return { kind: kind, o: top.o, books: tied.map(function (x) { return x.book; }), offers: offers, gap: gap };
  }

  // Cross-book arbs (both sides together pay out > stake) and middles (both sides can win).
  function opportunities(game) {
    var out = [];
    MARKETS.forEach(function (m) {
      game.bookKeys.forEach(function (x) {
        game.bookKeys.forEach(function (y) {
          if (x === y) return;
          var a = side(game, x, m.key, "away"), h = side(game, y, m.key, "home");
          if (!a || !h) return;
          var sameLine, lo = null, hi = null;
          if (m.key === "ml") sameLine = true;
          else if (m.key === "spread") {
            var s = a.point + h.point;
            sameLine = Math.abs(s) < EPS;
            if (s > EPS) { lo = -h.point; hi = a.point; } // home margin window
          } else {
            sameLine = Math.abs(a.point - h.point) < EPS;
            if (h.point - a.point > EPS) { lo = a.point; hi = h.point; } // total points window
          }
          if (sameLine) {
            var sum = implied(a.price) + implied(h.price);
            if (sum < 1 - EPS) out.push({ type: "arb", market: m.key, awayBook: x, homeBook: y, away: a, home: h, margin: 1 - sum });
          }
          if (lo !== null) {
            var hits = [];
            for (var n = Math.floor(lo) + 1; n < hi - EPS; n++) {
              if (n > lo + EPS && !(m.key === "spread" && n === 0)) hits.push(n);
            }
            if (hits.length) out.push({ type: "middle", market: m.key, awayBook: x, homeBook: y, away: a, home: h, hits: hits });
          }
        });
      });
    });
    return out;
  }

  function analyze(game) {
    var rows = {};
    var differs = false, lineDiff = false, gap = 0;
    MARKETS.forEach(function (m) {
      rows[m.key] = {};
      ["away", "home"].forEach(function (r) {
        var b = bestLine(game, m.key, r);
        rows[m.key][r] = b;
        if (b.kind === "price" || b.kind === "line") differs = true;
        if (b.kind === "line") lineDiff = true;
        gap = Math.max(gap, b.gap);
      });
    });
    var opps = opportunities(game);
    if (opps.length) gap += 100;
    var posted = game.bookKeys.filter(function (k) { return !!game.books[k]; });
    var only = posted.length === 1 && game.bookKeys.length > 1 ? posted[0] : null;
    return { rows: rows, opps: opps, differs: differs, lineDiff: lineDiff, gap: gap, only: only };
  }

  function summarize(analyzed) {
    var s = { games: analyzed.length, differ: 0, lines: 0, middles: 0, arbs: 0 };
    analyzed.forEach(function (g) {
      if (g.a.differs) s.differ++;
      if (g.a.lineDiff) s.lines++;
      g.a.opps.forEach(function (o) { if (o.type === "middle") s.middles++; else s.arbs++; });
    });
    return s;
  }

  // ---------- formatting ----------
  var MINUS = "−";
  function fmtPrice(p) { return p > 0 ? "+" + p : MINUS + Math.abs(p); }
  function fmtNum(abs) {
    var whole = Math.floor(abs + EPS), frac = abs - whole;
    if (Math.abs(frac) < EPS) return String(whole);
    if (Math.abs(frac - 0.5) < EPS) return (whole === 0 ? "" : String(whole)) + "½";
    return String(abs);
  }
  function fmtSpread(pt) {
    if (Math.abs(pt) < EPS) return "PK";
    return (pt > 0 ? "+" : MINUS) + fmtNum(Math.abs(pt));
  }
  function fmtLine(market, row, o) {
    if (market === "spread") return fmtSpread(o.point) + " " + fmtPrice(o.price);
    if (market === "total") return (row === "away" ? "O " : "U ") + fmtNum(o.point) + " " + fmtPrice(o.price);
    return fmtPrice(o.price);
  }

  // ---------- week window ----------
  // A betting week runs through Sunday night. On Sunday, "this week" is the coming week,
  // since that's when books post the next slate.
  function weekEnd(now) {
    var daysToSunday = (7 - now.getDay()) % 7 || 7;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToSunday, 23, 59, 59);
  }

  // ---------- picks (ledger format) ----------
  var TWO_WORD_MASCOTS = ["crimson tide", "nittany lions", "blue devils", "golden gophers", "fighting irish", "tar heels",
    "yellow jackets", "sun devils", "red raiders", "horned frogs", "scarlet knights", "demon deacons", "golden bears",
    "mean green", "green wave", "golden hurricane", "rainbow warriors", "black knights", "golden flashes", "blue raiders",
    "red wolves", "ragin cajuns", "ragin' cajuns", "thundering herd", "golden eagles", "fighting illini", "wolf pack",
    "blue hens", "black bears", "golden panthers", "golden lions", "golden griffins", "fighting hawks", "red flash"];
  // "Kansas State Wildcats" -> "Kansas State" (the way picks are written in a ledger)
  function shortTeam(name) {
    var words = String(name || "").trim().split(/\s+/);
    if (words.length < 2) return words.join(" ");
    var lastTwo = words.slice(-2).join(" ").toLowerCase().replace(/’/g, "'");
    var cut = TWO_WORD_MASCOTS.indexOf(lastTwo) >= 0 && words.length > 2 ? 2 : 1;
    return words.slice(0, words.length - cut).join(" ");
  }
  function plainPoint(pt) { return String(Math.round(pt * 100) / 100); }
  function pickText(market, row, o, away, home) {
    var team = shortTeam(row === "away" ? away : home);
    if (market === "total") return (row === "away" ? "Over " : "Under ") + plainPoint(o.point);
    if (market === "ml") return team + " ML";
    if (Math.abs(o.point) < EPS) return team + " PK";
    return team + " " + (o.point > 0 ? "+" : "") + plainPoint(o.point);
  }
  // College football week, Saturday-anchored: Week 1 of 2026 ends Sat Sep 5.
  var WEEK1_SAT = new Date(2026, 8, 5);
  function cfbWeek(date) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
    var w = Math.round((d - WEEK1_SAT) / 864e5 / 7) + 1;
    return w >= 1 ? String(w) : "";
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function localStamp(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  var api = {
    DEFAULT_BOOKS: DEFAULT_BOOKS, MARKETS: MARKETS, cleanBooks: cleanBooks,
    implied: implied, decimal: decimal, centsGap: centsGap,
    normalize: normalize, side: side, compareLines: compareLines, bestLine: bestLine,
    opportunities: opportunities, analyze: analyze, summarize: summarize,
    fmtPrice: fmtPrice, fmtSpread: fmtSpread, fmtNum: fmtNum, fmtLine: fmtLine,
    weekEnd: weekEnd,
    shortTeam: shortTeam, pickText: pickText, cfbWeek: cfbWeek, localStamp: localStamp
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LS = api;
})(this);
