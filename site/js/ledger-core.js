/* Bet ledger: the saved file's format, changes to it, and the money math. Pure functions, no DOM. */
(function (root) {
  "use strict";

  var RESULTS = ["pending", "win", "loss", "push"];

  // ---------- file format ----------
  // ledger/bets.json: {"version":1,"bets":[ ...one bet per line... ]}
  function emptyDoc() { return { version: 1, bets: [] }; }

  function parseDoc(text) {
    var d = JSON.parse(String(text || "").trim() || "{}");
    if (Array.isArray(d)) d = { version: 1, bets: d };
    if (!d || !Array.isArray(d.bets)) throw new Error("The ledger file isn't in the expected format.");
    return { version: 1, bets: d.bets.filter(function (b) { return b && typeof b.id === "string"; }) };
  }

  function formatDoc(bets) {
    var sorted = bets.slice().sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0) || (a.id < b.id ? -1 : 1); });
    return '{"version":1,"bets":[' + (sorted.length ? "\n" + sorted.map(function (b) { return JSON.stringify(b); }).join(",\n") + "\n" : "") + "]}\n";
  }

  // UTF-8 safe base64, for the GitHub contents API.
  function toBase64(text) {
    var bytes = new TextEncoder().encode(text), bin = "";
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function fromBase64(b64) {
    var bin = atob(String(b64 || "").replace(/\s+/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function newId() {
    var s = "";
    for (var i = 0; i < 20; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789".charAt(Math.floor(Math.random() * 36));
    return s;
  }

  // ---------- changes ----------
  // Every change is described as data, so it can be re-applied to a newer copy of the file
  // when someone else saved in between.
  //   { type: "add", bets: [...] }            skips bets whose importKey is already there
  //   { type: "update", id, fields: {...} }
  //   { type: "remove", id }
  function applyChange(bets, change) {
    if (change.type === "add") {
      var known = {};
      bets.forEach(function (b) { if (b.importKey) known[b.importKey] = true; });
      var fresh = change.bets.filter(function (b) { return !b.importKey || !known[b.importKey]; });
      return { bets: bets.concat(fresh), changed: fresh.length > 0, added: fresh.length, skipped: change.bets.length - fresh.length };
    }
    var found = false;
    var next = [];
    bets.forEach(function (b) {
      if (b.id !== change.id) { next.push(b); return; }
      found = true;
      if (change.type === "update") {
        var copy = {};
        for (var k in b) copy[k] = b[k];
        for (var f in change.fields) copy[f] = change.fields[f];
        next.push(copy);
      }
    });
    return { bets: found ? next : bets, changed: found, missing: !found };
  }

  // ---------- money ----------
  function profitFor(bet) {
    var amount = Number(bet.amount), odds = Number(bet.odds);
    if (bet.result === "win") return odds > 0 ? amount * (odds / 100) : amount * (100 / Math.abs(odds));
    if (bet.result === "loss") return -amount;
    return 0; // push or pending
  }

  function summary(bets) {
    var s = { wagered: 0, net: 0, wins: 0, losses: 0, pushes: 0, pending: 0, settledStake: 0 };
    bets.forEach(function (b) {
      var amt = Number(b.amount) || 0;
      s.wagered += amt;
      if (b.result === "win") s.wins++;
      else if (b.result === "loss") s.losses++;
      else if (b.result === "push") s.pushes++;
      else { s.pending++; return; }
      s.net += profitFor(b);
      if (b.result !== "push") s.settledStake += amt;
    });
    return s;
  }

  // ---------- weeks ----------
  function normWeek(week) {
    var s = String(week == null ? "" : week).trim();
    var m = s.match(/^week\s*(\d+)$/i);
    return m ? m[1] : s;
  }
  function weekSortKey(week) {
    var m = String(week).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 9999;
  }
  function displayWeek(week) {
    var s = normWeek(week);
    if (!s) return "No week";
    return /^\d+$/.test(s) ? "Week " + s : s;
  }

  // ---------- input checks ----------
  function parseOdds(raw) {
    var n = Number(String(raw == null ? "" : raw).trim().replace(/^\+/, "").replace("−", "-"));
    if (!isFinite(n) || Math.abs(n) < 100) return null;
    return Math.round(n);
  }
  function parseAmount(raw) {
    var n = parseFloat(String(raw == null ? "" : raw).replace(/[$,\s]/g, ""));
    return n > 0 ? Math.round(n * 100) / 100 : null;
  }

  var api = {
    RESULTS: RESULTS,
    emptyDoc: emptyDoc, parseDoc: parseDoc, formatDoc: formatDoc, toBase64: toBase64, fromBase64: fromBase64, newId: newId,
    applyChange: applyChange, profitFor: profitFor, summary: summary,
    normWeek: normWeek, weekSortKey: weekSortKey, displayWeek: displayWeek,
    parseOdds: parseOdds, parseAmount: parseAmount
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LEDGER = api;
})(this);
