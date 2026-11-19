// Market alerts: a second ntfy channel (NTFY_TOPIC + "-markets") that watches the prediction markets,
// exchanges and overseas books in scripts/markets.json. Spreads and totals only. Two kinds:
//
//   Stale line   FanDuel or DraftKings is 1½ points or more better than the markets' consensus
//                (the median of the markets that have the game, leaving out any far off the rest;
//                at least four markets, so a thinly traded game doesn't set it off).
//   Market move  the consensus moved more than N points in N days (1½+ in a day, 2½+ in two days,
//                and so on up to a week), the same rule as the line alerts.
//
// Each one is its own alert, sent once. A stale line alerts again if the gap grows another point, or
// if it closes and opens again; a market move if the consensus goes another point. What's been sent
// is kept in state/market-alerts.json. It runs after each refresh, reading site/data/markets.json (the
// markets now), site/data/odds.json (your books now) and state/market-history.json (the markets before).

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const H = require("../site/js/history.js");
const LS = require("../site/js/lines.js");

export const SITE = "https://plerner16.github.io/cfb-line-shop/";
export const STALE_POINTS = 1.5;
export const MIN_MARKETS = 4;
export const MAX_PER_RUN = 20;
const MARKETS = ["spread", "total"];
const GRACE_MS = 45 * 60 * 1000;
const TZ = "America/Chicago";
const whenFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" });
const when = (ms) => whenFmt.format(new Date(ms));
const pts = (x) => H.pointsText(x);
const nameOf = (list, k) => (list.find((b) => b.key === k) || {}).name || k;
const shortOf = (list, k) => (list.find((b) => b.key === k) || {}).short || k;

// A spread from one side: the away number, or the home number (its negative).
const sideNum = (awayPoint, side) => (side === "away" ? awayPoint : -awayPoint) || 0;
function sideLine(market, side, awayPoint) {
  return market === "total" ? (side === "away" ? "Over " : "Under ") + LS.fmtNum(awayPoint) : LS.fmtSpread(sideNum(awayPoint, side));
}

function marketList(lines, market, marketBooks, side = "away") {
  const ml = H.marketLines(lines, market);
  const shown = ml.list.filter((x) => !x.outlier).map((x) => `${shortOf(marketBooks, x.book)} ${market === "total" ? LS.fmtNum(x.point) : LS.fmtSpread(sideNum(x.point, side))}`);
  return { text: shown.join(" · "), consensus: ml.consensus };
}

// Your books where they're a point and a half or more better than the markets, for either side.
export function staleLines({ odds, markets, nowMs }) {
  const out = [];
  const books = odds.books || [];
  for (const g of LS.normalize(odds.events || [], new Date(nowMs), books)) {
    if (g.live) continue;
    const mg = markets.games && markets.games[g.id];
    if (!mg) continue;
    for (const market of MARKETS) {
      const c = H.marketLines(mg.lines, market).consensus;
      if (!c || c.n < MIN_MARKETS) continue;
      for (const b of g.bookKeys) {
        const l = g.books[b];
        const away = l && l[market] && l[market].away;
        if (!away || typeof away.point !== "number") continue;
        const gap = away.point - c.point; // spread: + is better for the away side; total: + is better for the Under
        if (Math.abs(gap) < STALE_POINTS - 1e-9) continue;
        const side = market === "spread" ? (gap > 0 ? "away" : "home") : (gap > 0 ? "home" : "away");
        const o = l[market][side];
        out.push({ kind: "stale", id: g.id, game: g, mg, market, book: b, side, point: away.point, price: o && o.price, consensus: c, gap: Math.abs(gap) });
      }
    }
  }
  return out.sort((a, b) => b.gap - a.gap);
}

// The consensus moving more than N points in N days, from the markets' saved history.
export function marketMoves({ markets, history, nowMs }) {
  const out = [];
  const keys = (markets.books || []).map((b) => b.key);
  for (const [id, mg] of Object.entries(markets.games || {})) {
    if (!(Date.parse(mg.start) > nowMs)) continue;
    const hg = history.games && history.games[id];
    if (!hg) continue;
    for (const market of MARKETS) {
      const now = H.marketLines(mg.lines, market).consensus;
      if (!now || now.n < MIN_MARKETS) continue;
      let best = null;
      for (let n = 1; n <= H.MAX_DAYS; n++) {
        const at = nowMs - n * 864e5 + GRACE_MS;
        const then = H.consensus(keys.map((k) => { const c = H.lineAt(hg, k, market, "away", at + 1); return c && c.point; }), market);
        if (!then || then.n < MIN_MARKETS) continue;
        const move = now.point - then.point;
        if (Math.abs(move) > n + 1e-9 && (!best || Math.abs(move) > Math.abs(best.move) + 1e-9)) best = { days: n, move, from: then.point, to: now.point };
      }
      if (best) out.push({ kind: "move", id, mg, market, ...best });
    }
  }
  return out.sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
}

export function keyOf(a) { return a.kind === "stale" ? `stale:${a.id}:${a.market}:${a.book}:${a.side}` : `move:${a.id}:${a.market}`; }
// Stale lines remember the gap; market moves the consensus line.
export function isNew(sent, a) {
  const last = sent[keyOf(a)];
  if (last == null) return true;
  return a.kind === "stale" ? a.gap - last >= 1 - 1e-9 : Math.abs(a.to - last) >= 1 - 1e-9;
}

export function describe(a, { odds, markets }) {
  const mbooks = markets.books || [], books = odds.books || [];
  const game = a.kind === "stale" ? a.game : a.mg;
  const matchup = `${game.away} @ ${game.home} · kickoff ${when(Date.parse(a.mg.start))}`;
  const click = `${SITE}#game=${encodeURIComponent(a.id)}`;
  if (a.kind === "stale") {
    const team = a.market === "spread" ? LS.shortTeam(a.side === "away" ? game.away : game.home) + " " : "";
    const yours = sideLine(a.market, a.side, a.point);
    const theirs = a.market === "total" ? LS.fmtNum(a.consensus.point) : LS.fmtSpread(sideNum(a.consensus.point, a.side));
    const list = marketList(a.mg.lines, a.market, mbooks, a.side);
    const where = a.market === "total" ? ` · ${LS.shortTeam(game.away)} @ ${LS.shortTeam(game.home)}` : "";
    return {
      title: `Stale line: ${nameOf(books, a.book)} ${team}${yours} (markets ${theirs})${where}`,
      message: `${nameOf(books, a.book)} has ${team}${yours}${a.price != null ? " " + LS.fmtPrice(a.price) : ""}, ${pts(a.gap)} better than the markets.\nMarkets: ${list.text}\n${matchup}`,
      click
    };
  }
  const fake = { market: a.market, from: { point: a.from }, to: { point: a.to } };
  const label = a.market === "total"
    ? `${LS.shortTeam(game.away)} @ ${LS.shortTeam(game.home)} total ${LS.fmtNum(a.from)} → ${LS.fmtNum(a.to)}`
    : H.moveText(game, fake);
  const list = marketList(a.mg.lines, a.market, mbooks);
  const yoursNow = [];
  const og = LS.normalize((odds.events || []).filter((e) => e.id === a.id), new Date(), books)[0];
  if (og) for (const b of og.bookKeys) {
    const o = og.books[b] && og.books[b][a.market] && og.books[b][a.market].away;
    if (o && typeof o.point === "number") yoursNow.push(`${nameOf(books, b)} ${a.market === "total" ? LS.fmtNum(o.point) : LS.fmtSpread(o.point)}`);
  }
  return {
    title: `Market move: ${label}`,
    message: `The markets moved ${pts(a.move)} in ${a.days === 1 ? "a day" : a.days + " days"}.\nNow: ${list.text}` +
      (yoursNow.length ? `\nYour books${a.market === "spread" ? " (" + LS.shortTeam(game.away) + ")" : ""}: ${yoursNow.join(" · ")}` : "") + `\n${matchup}`,
    click
  };
}

export async function check({ odds, markets, history, state, nowMs, send }) {
  state = { startedAt: state.startedAt || null, sent: { ...(state.sent || {}) } };
  const out = [];
  let error = null;
  const trySend = async (alert) => {
    if (error) return false;
    try { await send(alert); out.push(alert); return true; } catch (e) { error = e.message; return false; }
  };
  const stale = staleLines({ odds, markets, nowMs });
  const moves = marketMoves({ markets, history, nowMs });

  // A stale line that has closed is forgotten, so it alerts again if it opens again. Games gone are forgotten.
  const openStale = new Set(stale.map(keyOf));
  for (const k of Object.keys(state.sent)) {
    const id = k.split(":")[1];
    if (!markets.games || !markets.games[id] || (k.startsWith("stale:") && !openStale.has(k))) delete state.sent[k];
  }

  if (!state.startedAt) {
    const ok = await trySend({
      title: "Market alerts are on",
      message: `You'll get an alert when FanDuel or DraftKings is ${LS.fmtNum(STALE_POINTS)} points or more better than the prediction markets and overseas books, and when those markets move more than 1 point in a day, 2 in two days, and so on. Spreads and totals, checked after each lines refresh.`,
      click: `${SITE}#lines`
    });
    if (!ok) return { state, sent: out, error };
    state.startedAt = new Date(nowMs).toISOString();
  }

  const fresh = [...stale, ...moves].filter((a) => isNew(state.sent, a));
  for (const a of fresh.slice(0, MAX_PER_RUN)) {
    if (await trySend(describe(a, { odds, markets }))) state.sent[keyOf(a)] = a.kind === "stale" ? a.gap : a.to;
  }
  return { state, sent: out, error };
}

async function postToNtfy(topic, alert) {
  const res = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, tags: ["globe_with_meridians"], ...alert }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
}

const readJson = (f, fallback) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; } };

export async function run({ oddsFile, marketsFile, historyFile, stateFile, topic, nowMs = Date.now(), send = postToNtfy }) {
  if (!topic) { console.log("No NTFY_TOPIC secret set, so no market alerts are sent."); return false; }
  const markets = readJson(marketsFile, null);
  if (!markets || !markets.games) { console.log("No market lines yet."); return false; }
  const odds = readJson(oddsFile, { events: [] });
  const history = H.parse(JSON.stringify(readJson(historyFile, {})));
  let before = "";
  try { before = readFileSync(stateFile, "utf8"); } catch { /* first run */ }
  const state = readJson(stateFile, {});
  const result = await check({ odds, markets, history, state, nowMs, send: (a) => send(topic, a) });
  if (result.error) console.log(`Couldn't send a market alert (${result.error}); the rest wait for the next run.`);
  console.log(result.sent.length ? `Sent ${result.sent.length} market alert${result.sent.length === 1 ? "" : "s"}: ${result.sent.map((a) => a.title).join(" | ")}` : "No new market alerts.");
  const text = JSON.stringify(result.state).replace(/,"/g, ',\n"') + "\n";
  if (text === before) return false;
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, text);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = (p) => fileURLToPath(new URL(p, import.meta.url));
  const topic = (process.env.NTFY_TOPIC || "").trim();
  const changed = await run({
    oddsFile: base("../site/data/odds.json"),
    marketsFile: base("../site/data/markets.json"),
    historyFile: base("../state/market-history.json"),
    stateFile: base("../state/market-alerts.json"),
    topic: topic ? `${topic}-markets` : ""
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
