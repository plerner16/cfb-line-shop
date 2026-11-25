// The Edges report (site/data/edges.json): what has and hasn't worked this season, from every game's
// FanDuel and DraftKings lines and its final score. It runs after each refresh and only rewrites the
// report when a number in it changes.
//
// It also keeps two permanent records, since the site's line history only keeps ten days:
//   state/lines-archive.json    every game's line history (copied from site/data/history.json)
//   state/weather-archive.json  each game's last forecast before kickoff (from site/data/weather.json)
// Final scores come from state/results.json (scripts/espn-results.mjs).
//
// Everything is graded at the better of the two books' numbers for that side, the way you'd bet it.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const H = require("../site/js/history.js");

const BOOKS = ["fanduel", "draftkings"];
const DAY = 864e5, GRACE = 45 * 60e3, HOUR = 3600e3;
export const THRESHOLDS = [1, 1.5, 2, 2.5, 3, 4];
export const WINDOWS = [1, 2, 3];
const WINDY = 15, CALM = 10; // mph at kickoff

// ---------- permanent records ----------
export function archiveLines(archive, history) {
  let changed = 0;
  archive.games = archive.games || {};
  for (const [id, g] of Object.entries(history.games || {})) {
    if (JSON.stringify(archive.games[id]) !== JSON.stringify(g)) { archive.games[id] = g; changed++; }
  }
  if (history.books && history.books.length) archive.books = history.books;
  return changed;
}

// The forecast for games kicking off within six hours; the last one saved before kickoff stays.
export function archiveWeather(archive, weather, history, nowMs) {
  let changed = 0;
  archive.games = archive.games || {};
  for (const [id, w] of Object.entries((weather && weather.games) || {})) {
    const g = history.games && history.games[id];
    if (!g || typeof w.wind !== "number") continue;
    const start = Date.parse(g.start);
    if (!(start > nowMs) || start - nowMs > 6 * HOUR) continue;
    const rec = { start: g.start, roof: w.roof || "open", temp: w.temp, wind: w.wind, gust: w.gust, precip: w.precip, sky: w.sky, snow: !!w.snow };
    if (JSON.stringify(archive.games[id]) !== JSON.stringify(rec)) { archive.games[id] = rec; changed++; }
  }
  return changed;
}

export function formatGames(doc) {
  const ids = Object.keys(doc.games || {}).sort((a, b) => {
    const x = (doc.games[a].start || ""), y = (doc.games[b].start || "");
    return x < y ? -1 : x > y ? 1 : a < b ? -1 : 1;
  });
  const head = { ...doc }; delete head.games;
  return JSON.stringify(head).slice(0, -1) + (Object.keys(head).length ? "," : "") + '"games":{' +
    (ids.length ? "\n" + ids.map((id) => JSON.stringify(id) + ":" + JSON.stringify(doc.games[id])).join(",\n") + "\n" : "") + "}}\n";
}

// ---------- matching final scores ----------
const ALIAS = { "southern mississippi": "southern miss", "appalachian state": "app state", "umass": "massachusetts",
  "sam houston state": "sam houston", "ul monroe": "louisiana monroe", "hawaii": "hawaii", "miami oh": "miami oh" };
export function norm(s) {
  let x = String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  for (const [k, v] of Object.entries(ALIAS)) if (x === k || x.startsWith(k + " ")) x = v + x.slice(k.length);
  return x;
}
const school = (s) => norm(s).split(" ").slice(0, -1).join(" ") || norm(s);
const sameTeam = (a, b) => norm(a) === norm(b) || school(a) === school(b);
export function findResult(g, results) {
  const t = Date.parse(g.start);
  const near = results.filter((r) => Math.abs(Date.parse(r.start) - t) < 36 * HOUR);
  const r = near.find((x) => sameTeam(x.home, g.home) && sameTeam(x.away, g.away));
  if (r) return { awayScore: r.awayScore, homeScore: r.homeScore, neutral: !!r.neutral };
  const f = near.find((x) => sameTeam(x.home, g.away) && sameTeam(x.away, g.home));
  return f ? { awayScore: f.homeScore, homeScore: f.awayScore, neutral: !!f.neutral } : null;
}

// ---------- grading ----------
// side: "away"/"home" on spreads (the line is the away team's), "over"/"under" on totals.
export function grade(market, side, L, res) {
  const d = market === "spread" ? res.awayScore - res.homeScore + L : res.awayScore + res.homeScore - L;
  const s = market === "spread" ? (side === "away" ? d : -d) : (side === "over" ? d : -d);
  return s > 1e-9 ? 1 : s < -1e-9 ? -1 : 0;
}
// The books' numbers for this game and market at a moment (away spread, or total).
function numbersAt(g, market, t) {
  return BOOKS.map((k) => H.lineAt(g, k, market, "away", t + 1)).filter(Boolean).map((c) => c.point);
}
// The better number for a side, of the books' numbers (as the away spread or the total).
function bestFor(market, side, nums) {
  if (!nums.length) return null;
  if (market === "spread") return side === "away" ? Math.max(...nums) : Math.min(...nums);
  return side === "over" ? Math.min(...nums) : Math.max(...nums);
}
const toward = (market, move) => (market === "spread" ? (move < 0 ? "away" : "home") : (move > 0 ? "over" : "under"));
const avg = (v) => v.reduce((a, b) => a + b, 0) / v.length;

function rec() { return { w: 0, l: 0, p: 0 }; }
function add(r, x) { if (x > 0) r.w++; else if (x < 0) r.l++; else r.p++; }

// Each finished game's line through the week (the books' average at each refresh) and its final score.
export function buildSeries(lines, results, nowMs) {
  const resList = Object.values(results.games || {});
  const times = new Set();
  Object.values(lines.games || {}).forEach((g) => Object.values(g.lines || {}).forEach((rows) => rows.forEach((r) => times.add(r[0] * 1000))));
  const T = [...times].sort((a, b) => a - b);
  const series = [];
  let games = 0, first = null, last = null;
  for (const [id, g] of Object.entries(lines.games || {})) {
    const start = Date.parse(g.start);
    if (!(start < nowMs - 4 * HOUR)) continue;
    const res = findResult(g, resList);
    if (!res) continue;
    games++;
    if (!first || g.start < first) first = g.start;
    if (!last || g.start > last) last = g.start;
    for (const market of ["spread", "total"]) {
      const pts = [];
      for (const t of T) {
        if (t >= start) break;
        const nums = numbersAt(g, market, t);
        if (nums.length) pts.push({ t, L: avg(nums), nums });
      }
      if (pts.length < 2) continue;
      series.push({ id, g, market, res, pts, open: pts[0], close: pts[pts.length - 1] });
    }
  }
  return { series, games, first, last };
}

// The first time a line had moved X+ points within N days, betting the side it moved toward right then.
export function moveTable(series, market) {
  const rows = [];
  for (const n of WINDOWS) for (const X of THRESHOLDS) {
    const r = { n, X, ...rec(), kept: 0, back: 0 };
    for (const s of series) {
      if (s.market !== market) continue;
      let hit = null;
      for (let i = 0; i < s.pts.length && !hit; i++) {
        const p = s.pts[i];
        let ref = s.open;
        for (let j = i; j >= 0; j--) if (s.pts[j].t <= p.t - n * DAY + GRACE) { ref = s.pts[j]; break; }
        const mv = p.L - ref.L;
        if (Math.abs(mv) >= X - 1e-9) hit = { mv, at: p };
      }
      if (!hit) continue;
      const side = toward(market, hit.mv);
      add(r, grade(market, side, bestFor(market, side, hit.at.nums), s.res));
      const further = (s.close.L - hit.at.L) * Math.sign(hit.mv);
      if (further > 0.01) r.kept++; else if (further < -0.01) r.back++;
    }
    rows.push(r);
  }
  return rows;
}

export function openCloseTable(series, market) {
  const buckets = [["½–1 point", 0.5, 1.26], ["1½–2½ points", 1.5, 2.76], ["3+ points", 3, 999]];
  return buckets.map(([label, lo, hi]) => {
    const atOpen = rec(), atClose = rec();
    for (const s of series) {
      if (s.market !== market) continue;
      const mv = s.close.L - s.open.L, a = Math.abs(mv);
      if (a < lo - 1e-9 || a > hi) continue;
      const side = toward(market, mv);
      add(atOpen, grade(market, side, bestFor(market, side, s.open.nums), s.res));
      add(atClose, grade(market, side, bestFor(market, side, s.close.nums), s.res));
    }
    return { label, open: atOpen, close: atClose };
  });
}

// Against the closing number: favorites and underdogs, home and road, overs and unders, and weather.
export function trends(series, weather) {
  const out = [];
  const row = (group, label, test) => {
    const r = { group, label, ...rec() };
    for (const s of series) { const x = test(s); if (x != null) add(r, x); }
    out.push(r);
  };
  const close = (s, side) => bestFor(s.market, side, s.close.nums);
  const favSide = (s) => (s.close.L < -0.25 ? "away" : s.close.L > 0.25 ? "home" : null);
  const sp = (fn) => (s) => (s.market === "spread" ? fn(s) : null);
  const tot = (fn) => (s) => (s.market === "total" ? fn(s) : null);
  const gradeSide = (s, side) => grade(s.market, side, close(s, side), s.res);
  const dog = (side) => (side === "away" ? "home" : "away");

  row("Sides", "Favorites", sp((s) => { const f = favSide(s); return f && gradeSide(s, f); }));
  row("Sides", "Underdogs", sp((s) => { const f = favSide(s); return f && gradeSide(s, dog(f)); }));
  row("Sides", "Home teams", sp((s) => (s.res.neutral ? null : gradeSide(s, "home"))));
  row("Sides", "Road teams", sp((s) => (s.res.neutral ? null : gradeSide(s, "away"))));
  row("Sides", "Home favorites", sp((s) => (!s.res.neutral && favSide(s) === "home" ? gradeSide(s, "home") : null)));
  row("Sides", "Road favorites", sp((s) => (!s.res.neutral && favSide(s) === "away" ? gradeSide(s, "away") : null)));
  row("Sides", "Home underdogs", sp((s) => (!s.res.neutral && favSide(s) === "away" ? gradeSide(s, "home") : null)));
  row("Sides", "Road underdogs", sp((s) => (!s.res.neutral && favSide(s) === "home" ? gradeSide(s, "away") : null)));
  for (const [label, lo, hi] of [["Favorites of 3 or less", 0.5, 3], ["Favorites of 3½–7", 3.5, 7], ["Favorites of 7½–14", 7.5, 14],
    ["Favorites of 14½–21", 14.5, 21], ["Favorites of 21½ or more", 21.5, 999]]) {
    row("Favorites by size", label, sp((s) => { const f = favSide(s), a = Math.abs(s.close.L); return f && a >= lo - 0.26 && a <= hi + 0.26 ? gradeSide(s, f) : null; }));
  }
  row("Totals", "Overs", tot((s) => gradeSide(s, "over")));
  row("Totals", "Unders", tot((s) => gradeSide(s, "under")));
  for (const [label, lo, hi] of [["Overs, totals under 45", 0, 44.9], ["Overs, totals 45–54½", 45, 54.9], ["Overs, totals 55 or more", 55, 999]]) {
    row("Totals", label, tot((s) => (s.close.L >= lo && s.close.L <= hi ? gradeSide(s, "over") : null)));
  }
  const wx = (s) => {
    const w = weather.games && weather.games[s.id];
    return w && w.roof !== "dome" && w.roof !== "closed" && typeof w.wind === "number" ? w : null;
  };
  row("Weather", `Unders, wind ${WINDY}+ mph`, tot((s) => { const w = wx(s); return w && w.wind >= WINDY ? gradeSide(s, "under") : null; }));
  row("Weather", `Unders, wind under ${CALM} mph`, tot((s) => { const w = wx(s); return w && w.wind < CALM ? gradeSide(s, "under") : null; }));
  row("Weather", "Unders, rain or snow likely", tot((s) => { const w = wx(s); return w && (w.precip >= 50 || w.snow) ? gradeSide(s, "under") : null; }));
  return out;
}

// What shopping two books was worth: how often their closing numbers differed, and how often the
// better number changed how the bet came out.
export function shopping(series) {
  const out = {};
  for (const market of ["spread", "total"]) {
    const r = { games: 0, differ: 0, helped: 0, halfPoint: 0 };
    for (const s of series) {
      if (s.market !== market || s.close.nums.length < 2) continue;
      r.games++;
      const nums = s.close.nums, lo = Math.min(...nums), hi = Math.max(...nums);
      if (hi - lo < 0.26) continue;
      r.differ++;
      if (hi - lo < 0.76) r.halfPoint++;
      const sides = market === "spread" ? ["away", "home"] : ["over", "under"];
      for (const side of sides) {
        const best = bestFor(market, side, nums), worst = side === "away" || side === "under" ? lo : hi;
        if (grade(market, side, best, s.res) > grade(market, side, worst, s.res)) r.helped++;
      }
    }
    out[market] = r;
  }
  return out;
}

export function report({ lines, results, weather, nowMs }) {
  const { series, games, first, last } = buildSeries(lines, results, nowMs);
  return {
    games, first, last,
    moves: { spread: moveTable(series, "spread"), total: moveTable(series, "total") },
    openClose: { spread: openCloseTable(series, "spread"), total: openCloseTable(series, "total") },
    trends: trends(series, weather || { games: {} }),
    shopping: shopping(series),
    windyGames: Object.keys((weather && weather.games) || {}).length
  };
}

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } };
function writeIfChanged(file, text) {
  let before = null;
  try { before = readFileSync(file, "utf8"); } catch { /* new */ }
  if (before === text) return false;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return true;
}

export function run({ historyFile, weatherFile, resultsFile, linesArchiveFile, weatherArchiveFile, outFile, nowMs = Date.now() }) {
  const history = H.parse(JSON.stringify(readJson(historyFile, {})));
  const lines = readJson(linesArchiveFile, { games: {} });
  const wxArchive = readJson(weatherArchiveFile, { games: {} });
  const nLines = archiveLines(lines, history);
  const nWx = archiveWeather(wxArchive, readJson(weatherFile, {}), history, nowMs);
  let changed = writeIfChanged(linesArchiveFile, formatGames(lines));
  changed = writeIfChanged(weatherArchiveFile, formatGames(wxArchive)) || changed;
  const rep = report({ lines, results: readJson(resultsFile, { games: {} }), weather: wxArchive, nowMs });
  const old = readJson(outFile, null);
  const strip = (o) => { const c = { ...o }; delete c.updatedAt; return JSON.stringify(c); };
  const same = old && strip(old) === strip(rep);
  if (!same) { writeIfChanged(outFile, JSON.stringify({ updatedAt: new Date(nowMs).toISOString(), ...rep }) + "\n"); changed = true; }
  console.log(`Edges: ${rep.games} graded games${same ? " (no change)" : ""}; archive took ${nLines} games' lines and ${nWx} forecasts.`);
  return changed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = (p) => fileURLToPath(new URL(p, import.meta.url));
  const changed = run({
    historyFile: f("../site/data/history.json"),
    weatherFile: f("../site/data/weather.json"),
    resultsFile: f("../state/results.json"),
    linesArchiveFile: f("../state/lines-archive.json"),
    weatherArchiveFile: f("../state/weather-archive.json"),
    outFile: f("../site/data/edges.json")
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
