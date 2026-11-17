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

  // ---------- when a bet was placed ----------
  // placedAt is a local "YYYY-MM-DDTHH:MM" like startTime. Bets saved before placed times existed
  // fall back to when they were logged, but only if that was before kickoff (otherwise it says
  // nothing about when the bet was made).
  function placedInfo(bet) {
    if (bet.placedAt) {
      var t = Date.parse(bet.placedAt);
      if (isFinite(t)) return { ms: t, exact: true };
    }
    var start = Date.parse(bet.startTime);
    var logged = Number(bet.createdAt);
    if (isFinite(start) && logged > 0 && logged < start) return { ms: logged, exact: false };
    return null;
  }
  // Hours from placing the bet to kickoff (negative: placed after kickoff). Null when unknown.
  function leadHours(bet) {
    var p = placedInfo(bet), start = Date.parse(bet.startTime);
    return p && isFinite(start) ? (start - p.ms) / 3600e3 : null;
  }
  var TIMING = [
    { key: "early", label: "3+ days out", min: 72 },
    { key: "mid", label: "1–3 days out", min: 24 },
    { key: "gameday", label: "Game day", min: 0 },
    { key: "live", label: "After kickoff", min: -Infinity }
  ];
  function timingKey(hours) {
    if (hours == null) return null;
    for (var i = 0; i < TIMING.length; i++) if (hours >= TIMING[i].min) return TIMING[i].key;
    return null;
  }
  // Record, net and return for each timing group. Pending bets are counted but not scored.
  function timing(bets) {
    var rows = TIMING.map(function (t) {
      return { key: t.key, label: t.label, bets: 0, wins: 0, losses: 0, pushes: 0, pending: 0, net: 0, stake: 0 };
    });
    var unknown = 0;
    bets.forEach(function (b) {
      var key = timingKey(leadHours(b));
      if (!key) { unknown++; return; }
      var r = rows.filter(function (x) { return x.key === key; })[0];
      r.bets++;
      if (b.result === "win") r.wins++;
      else if (b.result === "loss") r.losses++;
      else if (b.result === "push") r.pushes++;
      else { r.pending++; return; }
      r.net += profitFor(b);
      if (b.result !== "push") r.stake += Number(b.amount) || 0;
    });
    return { rows: rows, unknown: unknown };
  }
  function leadText(hours) {
    if (hours == null) return "";
    if (hours < 0) return "after kickoff";
    if (hours >= 48) return Math.floor(hours / 24) + " days before kickoff";
    if (hours >= 24) return "1 day before kickoff";
    if (hours >= 2) return Math.floor(hours) + " hours before kickoff";
    if (hours >= 1) return "1 hour before kickoff";
    return Math.max(1, Math.round(hours * 60)) + " min before kickoff";
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
    parseOdds: parseOdds, parseAmount: parseAmount,
    placedInfo: placedInfo, leadHours: leadHours, timing: timing, timingKey: timingKey, leadText: leadText, TIMING: TIMING
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LEDGER = api;
})(this);
