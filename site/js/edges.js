/* Edges tab: what has and hasn't worked this season. Line moves, market trends and line shopping come
   from data/edges.json (built from every game's lines and final score by scripts/edges.mjs). Your own
   bets are broken down here in the browser from the private ledger, on connected devices only. */
(function () {
  "use strict";
  var A = window.APP, L = window.LEDGER, LS = window.LS;
  var $ = A.$, esc = A.esc;
  var BREAK_EVEN = 110 / 210; // win rate needed at −110 (52.4%)

  // ---------- reading a record ----------
  function pct(w, l) { return w + l ? (w / (w + l)) * 100 : null; }
  function recText(r) { return r.w + "-" + r.l + (r.p ? "-" + r.p : ""); }
  // How surprising a record would be from a coin flip (two-sided), as a plain label.
  function phi(z) { // standard normal CDF (Abramowitz and Stegun 7.1.26)
    var t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
    return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }
  function luck(w, l) {
    var n = w + l;
    if (n < 20) return { key: "few", text: "Too few" };
    var z = (Math.abs(w - n / 2) - 0.5) / Math.sqrt(n / 4);
    var p = 2 * (1 - phi(Math.max(0, z)));
    if (p <= 0.05) return { key: "strong", text: "Unlikely luck" };
    if (p <= 0.2) return { key: "watch", text: "Worth watching" };
    return { key: "luck", text: "Could be luck" };
  }
  function pctCell(r) {
    var x = pct(r.w, r.l);
    if (x == null) return '<td class="muted">—</td>';
    var cls = x >= BREAK_EVEN * 100 ? "pos" : x <= (1 - BREAK_EVEN) * 100 ? "neg" : "";
    return '<td class="' + cls + '">' + Math.round(x) + "%</td>";
  }
  function luckCell(r) { var k = luck(r.w, r.l); return '<td><span class="read ' + k.key + '">' + k.text + "</span></td>"; }
  function half(x) { return LS.fmtNum(x); }

  // ---------- the season's report ----------
  var data = null;
  function load() {
    return fetch("data/edges.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.moves) { data = d; renderReport(); } }, function () { /* try again next visit */ });
  }
  var dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

  function movesTable(rows, market) {
    var head = "<thead><tr><th scope=\"col\">Moved at least</th>" + [1, 2, 3].map(function (n) { return '<th scope="col">' + (n === 1 ? "In a day" : "In " + n + " days") + "</th>"; }).join("") + "</tr></thead>";
    var Xs = [];
    rows.forEach(function (r) { if (Xs.indexOf(r.X) < 0) Xs.push(r.X); });
    var body = Xs.map(function (X) {
      return "<tr><th scope=\"row\">" + half(X) + (X === 1 ? " point" : " points") + "</th>" + [1, 2, 3].map(function (n) {
        var r = rows.filter(function (x) { return x.X === X && x.n === n; })[0];
        if (!r || !(r.w + r.l)) return '<td class="muted">—</td>';
        var x = pct(r.w, r.l), k = luck(r.w, r.l);
        var cls = x >= BREAK_EVEN * 100 ? "pos" : x <= (1 - BREAK_EVEN) * 100 ? "neg" : "";
        return '<td class="' + cls + '" title="' + esc(recText(r) + " betting with the move. Afterward the line kept going " + r.kept + " times and came back " + r.back + ". " + k.text + ".") + '">' +
          Math.round(x) + "%" + (k.key === "watch" || k.key === "strong" ? '<i class="mark ' + k.key + '" aria-label="' + k.text + '"></i>' : "") +
          '<span class="sub">' + recText(r) + "</span></td>";
      }).join("") + "</tr>";
    }).join("");
    return '<table class="etable grid">' + head + "<tbody>" + body + "</tbody></table>";
  }
  // The strongest spot so far worth naming: 30+ graded bets, the best win rate.
  function headline(rows, market) {
    var cands = rows.filter(function (r) { return r.w + r.l >= 30 && r.X >= 1.5; });
    if (!cands.length) return "";
    cands.sort(function (a, b) { return pct(b.w, b.l) - pct(a.w, a.l); });
    var r = cands[0], x = Math.round(pct(r.w, r.l));
    var small = rows.filter(function (q) { return q.X === 1 && q.n === r.n; })[0];
    return "Best so far: " + (market === "spread" ? "spreads" : "totals") + " that moved " + half(r.X) + "+ points " + (r.n === 1 ? "in a day" : "within " + r.n + " days") +
      " went " + recText(r) + " (" + x + "%) betting with the move" +
      (r.kept + r.back ? ", and the line kept going your way " + r.kept + " of " + (r.kept + r.back) + " times after" : "") + "." +
      (small && small.w + small.l ? " Moves of only 1 point: " + recText(small) + " (" + Math.round(pct(small.w, small.l)) + "%)." : "");
  }

  function trendsTable(rows) {
    var groups = [];
    rows.forEach(function (r) { if (groups.indexOf(r.group) < 0) groups.push(r.group); });
    return '<table class="etable"><thead><tr><th scope="col">Bet</th><th scope="col">Record</th><th scope="col">Win %</th><th scope="col">Read</th></tr></thead>' +
      groups.map(function (g) {
        return '<tbody><tr class="grp"><th colspan="4" scope="rowgroup">' + esc(g) + "</th></tr>" + rows.filter(function (r) { return r.group === g; }).map(function (r) {
          return "<tr><th scope=\"row\">" + esc(r.label) + "</th><td>" + (r.w + r.l + r.p ? recText(r) : "—") + "</td>" + pctCell(r) + luckCell(r) + "</tr>";
        }).join("") + "</tbody>";
      }).join("") + "</table>";
  }

  function renderReport() {
    if (!data) return;
    $("edges-range").textContent = data.games + " games, " + dayFmt.format(new Date(data.first)) + " to " + dayFmt.format(new Date(data.last));
    $("moves-spread").innerHTML = movesTable(data.moves.spread, "spread");
    $("moves-total").innerHTML = movesTable(data.moves.total, "total");
    $("moves-headline").textContent = headline(data.moves.spread, "spread");
    $("moves-headline-total").textContent = headline(data.moves.total, "total");
    $("oc-table").innerHTML = '<table class="etable"><thead><tr><th scope="col">Moved open to close</th><th scope="col">At the open</th><th scope="col">At the close</th></tr></thead><tbody>' +
      ["spread", "total"].map(function (m) {
        return '<tr class="grp"><th colspan="3" scope="rowgroup">' + (m === "spread" ? "Spreads" : "Totals") + "</th></tr>" + data.openClose[m].map(function (r) {
          var cell = function (x) { var p = pct(x.w, x.l); return "<td>" + recText(x) + (p == null ? "" : ' <span class="' + (p >= BREAK_EVEN * 100 ? "pos" : p <= 47.6 ? "neg" : "muted") + '">(' + Math.round(p) + "%)</span>") + "</td>"; };
          return "<tr><th scope=\"row\">" + esc(r.label) + "</th>" + cell(r.open) + cell(r.close) + "</tr>";
        }).join("");
      }).join("") + "</tbody></table>";
    $("trends-table").innerHTML = trendsTable(data.trends);
    var s = data.shopping.spread, t = data.shopping.total;
    $("shop-text").innerHTML = s.games ? "FanDuel and DraftKings closed on different spreads in <b>" + s.differ + " of " + s.games + "</b> games (" + Math.round(s.differ / s.games * 100) + "%), and on different totals in <b>" + t.differ + "</b>. " +
      "Taking the better number changed how <b>" + (s.helped + t.helped) + " bets</b> came out: a loss became a push, or a push or loss became a win. Every table here is graded at the better of the two numbers, the way you'd bet it." : "";
    $("edges-report").hidden = false;
  }

  // ---------- your bets ----------
  function dec(odds) { return odds > 0 ? 1 + odds / 100 : 1 + 100 / -odds; }
  function groupRows(list, dims) {
    return dims.map(function (d) {
      var r = { label: d.label, w: 0, l: 0, p: 0, net: 0, stake: 0 };
      list.forEach(function (b) {
        if (!d.test(b)) return;
        if (b.result === "win") r.w++; else if (b.result === "loss") r.l++; else if (b.result === "push") r.p++; else return;
        r.net += L.profitFor(b);
        if (b.result !== "push") r.stake += Number(b.amount) || 0;
      });
      return r;
    }).filter(function (r) { return r.w + r.l + r.p > 0; });
  }
  function mineTable(title, rows) {
    if (!rows.length) return "";
    return '<tbody><tr class="grp"><th colspan="5" scope="rowgroup">' + esc(title) + "</th></tr>" + rows.map(function (r) {
      var ret = r.stake ? r.net / r.stake * 100 : null;
      var cls = r.net > 0.004 ? "pos" : r.net < -0.004 ? "neg" : "";
      return "<tr><th scope=\"row\">" + esc(r.label) + "</th><td>" + recText(r) + "</td>" + pctCell(r) +
        '<td class="' + cls + '">' + esc(A.money(r.net, true)) + '</td><td class="' + cls + '">' + (ret == null ? "—" : (ret > 0 ? "+" : ret < 0 ? "−" : "") + Math.abs(Math.round(ret)) + "%") + "</td></tr>";
    }).join("") + "</tbody>";
  }
  function renderMine() {
    var box = $("edges-mine");
    if (!A.ledger || !A.token()) {
      box.innerHTML = '<p class="hint">Connect this device (Ledger tab) to see your own bets broken down here.</p>';
      return;
    }
    var all = A.ledger.bets();
    var settled = all.filter(function (b) { return b.result === "win" || b.result === "loss" || b.result === "push"; });
    if (!settled.length) { box.innerHTML = '<p class="hint">Your settled bets show up here once the ledger loads.</p>'; return; }
    var info = function (b) { return L.pickLine(b.pick); };
    var odds = function (b) { return Number(b.odds); };
    var vs = A.ledger.vsClose || function () { return null; };
    var isSat = function (b) { var d = new Date(Date.parse(b.startTime)); return d.getDay() === 6; };
    var books = [];
    settled.forEach(function (b) { if (b.book && books.indexOf(b.book) < 0) books.push(b.book); });

    // Break-even: the win rate these prices need, against the win rate you've had.
    var wl = settled.filter(function (b) { return b.result !== "push"; });
    var stake = 0, payout = 0, wins = 0;
    wl.forEach(function (b) { var a = Number(b.amount) || 0; stake += a; payout += a * dec(odds(b)); if (b.result === "win") wins++; });
    var need = payout ? stake / payout * 100 : BREAK_EVEN * 100, have = wl.length ? wins / wl.length * 100 : 0;
    var s = L.summary(all);
    $("edges-be").innerHTML =
      '<div class="' + (have >= need ? "pos" : "neg") + '"><b>' + have.toFixed(1) + "%</b><span>You've won</span></div>" +
      "<div><b>" + need.toFixed(1) + "%</b><span>Needed at your prices</span></div>" +
      '<div class="' + (s.net >= 0 ? "pos" : "neg") + '"><b>' + esc(A.money(s.net, true)) + "</b><span>Net</span></div>";
    $("edges-be-note").textContent = "You've won " + wins + " of " + wl.length + " bets that weren't pushes. At the prices you've paid, breaking even takes " + need.toFixed(1) +
      "% (it's 52.4% at −110). Every 10 cents of juice you save lowers that by about 1 point.";

    var html = '<table class="etable"><thead><tr><th scope="col">Your bets</th><th scope="col">Record</th><th scope="col">Win %</th><th scope="col">Net</th><th scope="col">Return</th></tr></thead>' +
      mineTable("Bet type", groupRows(settled, [
        { label: "Spreads", test: function (b) { var p = info(b); return p && p.market === "spread"; } },
        { label: "Totals", test: function (b) { var p = info(b); return p && p.market === "total"; } },
        { label: "Moneylines", test: function (b) { var p = info(b); return p && p.market === "ml"; } },
        { label: "Other (parlays, props)", test: function (b) { return !info(b); } }
      ])) +
      mineTable("Favorite or underdog", groupRows(settled, [
        { label: "Spread favorites", test: function (b) { var p = info(b); return p && p.market === "spread" && p.point < 0; } },
        { label: "Spread underdogs", test: function (b) { var p = info(b); return p && p.market === "spread" && p.point > 0; } },
        { label: "Moneyline favorites", test: function (b) { var p = info(b); return p && p.market === "ml" && odds(b) < 0; } },
        { label: "Moneyline underdogs", test: function (b) { var p = info(b); return p && p.market === "ml" && odds(b) > 0; } }
      ])) +
      mineTable("Over or under", groupRows(settled, [
        { label: "Overs", test: function (b) { var p = info(b); return p && p.market === "total" && p.side === "away"; } },
        { label: "Unders", test: function (b) { var p = info(b); return p && p.market === "total" && p.side === "home"; } }
      ])) +
      mineTable("Price", groupRows(settled, [
        { label: "−120 or more juice", test: function (b) { return odds(b) <= -120; } },
        { label: "−119 to +119", test: function (b) { return odds(b) > -120 && odds(b) < 120; } },
        { label: "+120 or more", test: function (b) { return odds(b) >= 120; } }
      ])) +
      mineTable("Against the closing line", groupRows(settled, [
        { label: "Beat the close", test: function (b) { var c = vs(b); return c && c.dir > 0; } },
        { label: "Same as the close", test: function (b) { var c = vs(b); return c && c.dir === 0; } },
        { label: "Worse than the close", test: function (b) { var c = vs(b); return c && c.dir < 0; } }
      ])) +
      mineTable("Book", groupRows(settled, books.map(function (k) { return { label: k, test: function (b) { return b.book === k; } }; }))) +
      mineTable("Day", groupRows(settled, [
        { label: "Saturday games", test: isSat },
        { label: "Other days", test: function (b) { return !isSat(b); } }
      ])) + "</table>";
    box.innerHTML = html;
  }

  function show() {
    if (A.currentView() !== "edges") return;
    if (!data) load();
    renderMine();
    if (A.ledger && A.token()) A.ledger.load().then(renderMine, renderMine);
  }
  A.onView(function (v) { if (v === "edges") show(); });
  A.onDevice(function () { if (A.currentView() === "edges") show(); });
  A.onHistory(function () { if (A.currentView() === "edges") renderMine(); });
  show();
})();
