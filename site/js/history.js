/* Line history: how each game's lines moved through the week. The refresh job adds every refresh to
   data/history.json; the board and the ledger read it. Pure functions, no DOM. */
(function (root, LS) {
  "use strict";

  var KEEP_DAYS = 10; // games stay this long after kickoff, long enough for the grader to save each bet's close

  // Each book's lines for a game are a list of rows, one per change:
  //   [t, away spread, price, home spread, price, total, over price, under price, away ML, home ML]
  // t is when the refresh that first saw it ran (unix seconds). Unchanged refreshes add nothing.
  // Board convention: the total's Over is the "away" side, the Under the "home" side.
  var COLS = {
    spread: { away: [1, 2], home: [3, 4] },
    total: { away: [5, 6], home: [5, 7] },
    ml: { away: [0, 8], home: [0, 9] }
  };

  function v(o, f) { return o && typeof o[f] === "number" ? o[f] : null; }
  function rowOf(t, lines) {
    var sa = lines.spread.away, sh = lines.spread.home, ov = lines.total.away, un = lines.total.home;
    var total = v(ov, "point"); if (total == null) total = v(un, "point");
    return [t, v(sa, "point"), v(sa, "price"), v(sh, "point"), v(sh, "price"), total, v(ov, "price"), v(un, "price"),
      v(lines.ml.away, "price"), v(lines.ml.home, "price")];
  }
  function sameRow(a, b) {
    for (var i = 1; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function empty() { return { version: 1, updatedAt: null, books: [], games: {} }; }
  function parse(text) {
    var d = JSON.parse(String(text || "").trim() || "{}");
    if (!d || typeof d.games !== "object" || !d.games) return empty();
    return { version: 1, updatedAt: d.updatedAt || null, books: Array.isArray(d.books) ? d.books : [], games: d.games };
  }

  // Adds one refresh. Games that have kicked off are skipped: in-game lines aren't the close.
  function addSnapshot(hist, events, at, books) {
    var t = Math.round(at.getTime() / 1000), added = 0;
    LS.normalize(events, at, books).forEach(function (g) {
      if (g.live) return;
      var h = hist.games[g.id] || (hist.games[g.id] = { start: "", away: g.away, home: g.home, lines: {} });
      h.start = g.start.toISOString(); h.away = g.away; h.home = g.home;
      g.bookKeys.forEach(function (k) {
        if (!g.books[k]) return;
        var row = rowOf(t, g.books[k]);
        if (row.slice(1).every(function (x) { return x === null; })) return;
        var list = h.lines[k] || (h.lines[k] = []);
        var last = list[list.length - 1];
        if (last && (last[0] >= t || sameRow(last, row))) return;
        list.push(row);
        added++;
      });
    });
    if (books && books.length) hist.books = books.map(function (b) { return { key: b.key, name: b.name, short: b.short }; });
    hist.updatedAt = at.toISOString();
    return added;
  }

  function prune(hist, now) {
    var cutoff = now.getTime() - KEEP_DAYS * 864e5, dropped = 0;
    Object.keys(hist.games).forEach(function (id) {
      if (Date.parse(hist.games[id].start) < cutoff) { delete hist.games[id]; dropped++; }
    });
    return dropped;
  }

  // One game per line, so each refresh is a small, readable change in the repository.
  function format(hist) {
    var ids = Object.keys(hist.games).sort(function (a, b) {
      var x = hist.games[a].start, y = hist.games[b].start;
      return x < y ? -1 : x > y ? 1 : a < b ? -1 : 1;
    });
    return '{"version":1,"updatedAt":' + JSON.stringify(hist.updatedAt) + ',"books":' + JSON.stringify(hist.books) + ',"games":{' +
      (ids.length ? "\n" + ids.map(function (id) { return JSON.stringify(id) + ":" + JSON.stringify(hist.games[id]); }).join(",\n") + "\n" : "") + "}}\n";
  }

  // ---------- reading ----------
  function cell(row, market, side) {
    var c = COLS[market] && COLS[market][side];
    if (!c || row[c[1]] == null) return null;
    if (market !== "ml" && row[c[0]] == null) return null;
    return { point: market === "ml" ? null : row[c[0]], price: row[c[1]], t: row[0] * 1000 };
  }
  // The book's last line for this bet seen before `beforeMs`.
  function lineAt(game, bookKey, market, side, beforeMs) {
    var rows = game && game.lines && game.lines[bookKey];
    if (!rows) return null;
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i][0] * 1000 >= beforeMs) continue;
      var c = cell(rows[i], market, side);
      if (c) return c;
    }
    return null;
  }
  function latest(game, bookKey, market, side) { return lineAt(game, bookKey, market, side, Infinity); }
  // The closing line: the last one seen before kickoff.
  function close(game, bookKey, market, side) { return lineAt(game, bookKey, market, side, Date.parse(game.start)); }

  function better(market, side, a, b) { return LS.compareLines(market, side, a, b) > 0; }
  // The best of several books' lines (each { book, o }).
  function bestOf(market, side, list) {
    var top = null;
    list.forEach(function (x) { if (x.o && (!top || better(market, side, x.o, top.o))) top = x; });
    return top;
  }

  // The best line on the first refresh that had this bet, across the books.
  function opened(game, bookKeys, market, side) {
    var firsts = [];
    bookKeys.forEach(function (k) {
      var rows = game && game.lines && game.lines[k];
      if (!rows) return;
      for (var i = 0; i < rows.length; i++) {
        var c = cell(rows[i], market, side);
        if (c) { firsts.push({ book: k, o: c }); return; }
      }
    });
    if (!firsts.length) return null;
    var t0 = Math.min.apply(null, firsts.map(function (x) { return x.o.t; }));
    return bestOf(market, side, firsts.filter(function (x) { return x.o.t === t0; }));
  }

  // The times this book's number changed (spreads and totals) or its price did (moneylines).
  function path(game, bookKey, market, side) {
    var rows = game && game.lines && game.lines[bookKey], out = [];
    (rows || []).forEach(function (r) {
      var c = cell(r, market, side);
      if (!c) return;
      var last = out[out.length - 1];
      if (!last || (market === "ml" ? c.price !== last.price : c.point !== last.point)) out.push(c);
    });
    return out;
  }

  // Worth pointing out on the board: a new number, or a moneyline 10 cents or more away.
  function moved(market, from, to) {
    if (!from || !to) return false;
    if (market === "ml") return LS.centsGap(from.price, to.price) >= 10;
    return Math.abs(from.point - to.point) > 1e-9;
  }

  // How your line compares with another one (the close, or the line now), from your side of the bet.
  //   dir    1 yours is better, -1 worse, 0 the same
  //   points the difference in the number in your favor (spreads and totals)
  //   cents  the difference in price in your favor, when the number is the same (or a moneyline)
  function compare(market, side, mine, other) {
    var dir = LS.compareLines(market, side, mine, other);
    var points = 0, cents = 0;
    if (market !== "ml" && Math.abs(mine.point - other.point) > 1e-9) {
      points = market === "total" && side === "away" ? other.point - mine.point : market === "total" ? mine.point - other.point : mine.point - other.point;
    } else if (dir !== 0) {
      cents = dir * LS.centsGap(mine.price, other.price);
    }
    return { dir: dir, points: points, cents: cents };
  }

  // ---------- big moves ----------
  // A spread or total that moved more than N points in N days (1½+ in a day, 2½+ in two days, and so
  // on up to a week), at one book. The line "N days ago" is the one in effect then (allowing 45 minutes
  // for a refresh that ran a little late), or the book's first line if the game was posted since.
  // Returns [{ market, book, days, move, from, to, since }], the biggest qualifying move per book and market.
  var MAX_DAYS = 7, GRACE_MS = 45 * 60 * 1000;
  function bigMoves(game, bookKeys, nowMs) {
    var out = [];
    if (!game || !game.lines || !(Date.parse(game.start) > nowMs)) return out;
    ["spread", "total"].forEach(function (m) {
      (bookKeys || Object.keys(game.lines)).forEach(function (k) {
        var to = latest(game, k, m, "away");
        if (!to) return;
        var first = null, rows = game.lines[k] || [];
        for (var i = 0; i < rows.length && !first; i++) first = cell(rows[i], m, "away");
        var best = null;
        for (var n = 1; n <= MAX_DAYS; n++) {
          var at = nowMs - n * 864e5 + GRACE_MS;
          var before = lineAt(game, k, m, "away", at + 1), from = before || first;
          var move = to.point - from.point;
          if (Math.abs(move) > n + 1e-9 && (!best || Math.abs(move) > Math.abs(best.move) + 1e-9)) {
            best = { market: m, book: k, days: n, move: move, from: from, to: to, since: Math.max(from.t, nowMs - n * 864e5), opened: !before };
          }
        }
        if (best) out.push(best);
      });
    });
    return out;
  }
  // "Western Michigan −13½ → −15" (a spread, from the favorite's side) or "Total 46½ → 49".
  function moveText(game, m) {
    if (m.market === "total") return "Total " + LS.fmtNum(m.from.point) + " → " + LS.fmtNum(m.to.point);
    var awayFav = m.to.point < 0 || (m.to.point === 0 && m.from.point < 0);
    var s = awayFav ? 1 : -1;
    return LS.shortTeam(awayFav ? game.away : game.home) + " " + LS.fmtSpread((s * m.from.point) || 0) + " → " + LS.fmtSpread((s * m.to.point) || 0);
  }
  function pointsText(x) { x = Math.abs(x); return LS.fmtNum(x) + (x === 1 ? " point" : " points"); }
  // "in 3 days", or "since it opened Wed 5 PM" for a game posted within the window.
  function spanText(m, fmtTime) {
    return m.opened ? "since it opened " + fmtTime(m.from.t) : "in " + (m.days === 1 ? "a day" : m.days + " days");
  }

  // Every game's big moves right now, one group per game and market (its books together), biggest first.
  // Each group is one phone alert and one row in the site's Big moves list.
  function bigMoveGroups(hist, nowMs) {
    var groups = [];
    Object.keys((hist && hist.games) || {}).forEach(function (id) {
      var game = hist.games[id], by = {};
      bigMoves(game, null, nowMs).forEach(function (m) { (by[m.market] = by[m.market] || []).push(m); });
      Object.keys(by).forEach(function (market) {
        var moves = by[market].sort(function (a, b) { return Math.abs(b.move) - Math.abs(a.move); });
        groups.push({ id: id, game: game, market: market, moves: moves });
      });
    });
    return groups.sort(function (a, b) { return Math.abs(b.moves[0].move) - Math.abs(a.moves[0].move); });
  }
  // "Georgia −9½ → −14½", or "Ohio State @ Nebraska total 47½ → 41½".
  function groupTitle(g) {
    var top = g.moves[0];
    return g.market === "total"
      ? LS.shortTeam(g.game.away) + " @ " + LS.shortTeam(g.game.home) + " total " + LS.fmtNum(top.from.point) + " → " + LS.fmtNum(top.to.point)
      : moveText(g.game, top);
  }
  // A move counts as new until it's been alerted (or marked seen) at a line within a point of where it is now.
  function moveKey(id, m) { return id + ":" + m.market + ":" + m.book; }
  function isNewMove(seen, id, m) {
    var last = seen ? seen[moveKey(id, m)] : null;
    return last == null || Math.abs(last - m.to.point) >= 1 - 1e-9;
  }
  function groupIsNew(seen, g) { return g.moves.some(function (m) { return isNewMove(seen, g.id, m); }); }

  var api = {
    KEEP_DAYS: KEEP_DAYS, COLS: COLS, MAX_DAYS: MAX_DAYS,
    bigMoves: bigMoves, moveText: moveText, pointsText: pointsText, spanText: spanText,
    bigMoveGroups: bigMoveGroups, groupTitle: groupTitle, moveKey: moveKey, isNewMove: isNewMove, groupIsNew: groupIsNew,
    empty: empty, parse: parse, addSnapshot: addSnapshot, prune: prune, format: format,
    cell: cell, lineAt: lineAt, latest: latest, close: close, opened: opened, path: path, bestOf: bestOf,
    moved: moved, compare: compare
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LINE_HISTORY = api;
})(this, typeof module !== "undefined" && module.exports ? require("./lines.js") : this.LS);
