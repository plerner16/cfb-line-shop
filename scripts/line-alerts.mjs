// Sends a phone alert (through the ntfy app) when a spread or total moves more than N points in
// N days at a book: 1½+ in a day, 2½+ in two days, and so on up to a week. Moneylines aren't checked.
//
// It runs after each refresh and reads site/data/history.json. Each move alerts once; the same game
// and market alerts again only once the line has gone at least another point. What's been sent is
// kept in state/line-alerts.json (not part of the published site).
//
// The ntfy topic (the private channel name the app subscribes to) is the NTFY_TOPIC secret. Without
// it, nothing is sent.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const H = require("../site/js/history.js");
const LS = require("../site/js/lines.js");

export const SITE = "https://plerner16.github.io/cfb-line-shop/";
export const MAX_PER_RUN = 6; // more than this in one refresh: the rest go in one summary alert
const TZ = "America/Chicago";
const whenFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" });
const when = (ms) => whenFmt.format(new Date(ms));

const keyOf = (id, m) => `${id}:${m.market}:${m.book}`;
const bookName = (books, k) => (books.find((b) => b.key === k) || {}).name || k;

// Every game's current big moves, grouped by game and market, biggest first.
export function currentMoves(hist, nowMs) {
  const groups = [];
  for (const [id, game] of Object.entries(hist.games || {})) {
    const byMarket = {};
    for (const m of H.bigMoves(game, null, nowMs)) (byMarket[m.market] = byMarket[m.market] || []).push(m);
    for (const market of Object.keys(byMarket)) {
      const moves = byMarket[market].sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
      groups.push({ id, game, market, moves });
    }
  }
  return groups.sort((a, b) => Math.abs(b.moves[0].move) - Math.abs(a.moves[0].move));
}

// New since the last alert: never alerted, or a point or more past the line it was alerted at.
export function isNew(state, id, m) {
  const last = state.sent[keyOf(id, m)];
  return last == null || Math.abs(last - m.to.point) >= 1 - 1e-9;
}

export function describe(group, books) {
  const { game, moves } = group;
  const top = moves[0];
  const lines = moves.map((m) => `${bookName(books, m.book)}: ${H.moveText(game, m).replace(/^Total /, "")}, ${H.pointsText(m.move)} since ${when(m.since)}`);
  const kick = whenFmt.format(new Date(game.start));
  return {
    title: `Big move: ${group.market === "total" ? `${LS.shortTeam(game.away)} @ ${LS.shortTeam(game.home)} total ` + H.moveText(game, top).replace(/^Total /, "") : H.moveText(game, top)}`,
    message: `${lines.join("\n")}\n${game.away} @ ${game.home} · kickoff ${kick}`,
    click: `${SITE}#game=${encodeURIComponent(group.id)}`
  };
}

export async function postToNtfy(topic, alert) {
  const res = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, tags: ["chart_with_upwards_trend"], ...alert }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
}

function markSent(state, group) {
  for (const m of group.moves) state.sent[keyOf(group.id, m)] = m.to.point;
}

// Returns { state, sent: [alerts], error }. `send` posts one alert and throws if it couldn't; after a
// failure nothing more is sent, and what wasn't sent waits for the next run.
export async function check({ hist, state, nowMs, send }) {
  state = { startedAt: state.startedAt || null, sent: { ...(state.sent || {}) } };
  const books = hist.books || [];
  const groups = currentMoves(hist, nowMs);
  const out = [];
  let error = null;
  const trySend = async (alert) => {
    if (error) return false;
    try { await send(alert); out.push(alert); return true; } catch (e) { error = e.message; return false; }
  };

  // Forget games that are gone from the history.
  for (const k of Object.keys(state.sent)) if (!hist.games[k.split(":")[0]]) delete state.sent[k];

  if (!state.startedAt) {
    // First run: one welcome alert listing what's already moved, instead of a burst of alerts.
    const list = groups.slice(0, 8).map((g) => describe(g, books).title.replace(/^Big move: /, ""));
    const alert = {
      title: "Line alerts are on",
      message: "You'll get an alert when a spread or total moves more than 1 point in a day, 2 in two days, and so on up to 7 in a week, checked after each lines refresh." +
        (groups.length ? `\n\nAlready moved this week:\n${list.join("\n")}${groups.length > list.length ? `\n…and ${groups.length - list.length} more` : ""}` : ""),
      click: SITE
    };
    if (await trySend(alert)) {
      groups.forEach((g) => markSent(state, g));
      state.startedAt = new Date(nowMs).toISOString();
    }
    return { state, sent: out, error };
  }

  const fresh = groups.filter((g) => g.moves.some((m) => isNew(state, g.id, m)));
  const each = fresh.length > MAX_PER_RUN ? fresh.slice(0, MAX_PER_RUN - 1) : fresh;
  for (const g of each) if (await trySend(describe(g, books))) markSent(state, g);
  const rest = fresh.slice(each.length);
  if (rest.length) {
    const alert = {
      title: `${rest.length} more big moves`,
      message: rest.map((g) => describe(g, books).title.replace(/^Big move: /, "")).join("\n"),
      click: SITE
    };
    if (await trySend(alert)) rest.forEach((g) => markSent(state, g));
  }
  return { state, sent: out, error };
}

export async function run({ historyFile, stateFile, topic, nowMs = Date.now(), send = postToNtfy }) {
  if (!topic) { console.log("No NTFY_TOPIC secret set, so no alerts are sent."); return false; }
  let hist, state = {};
  try { hist = H.parse(readFileSync(historyFile, "utf8")); } catch (e) { console.log(`No line history to check (${e.message}).`); return false; }
  let before = "";
  try { before = readFileSync(stateFile, "utf8"); state = JSON.parse(before); } catch { /* first run */ }
  const result = await check({ hist, state, nowMs, send: (a) => send(topic, a) });
  if (result.error) console.log(`Couldn't send an alert (${result.error}); the rest wait for the next run.`);
  console.log(result.sent.length ? `Sent ${result.sent.length} alert${result.sent.length === 1 ? "" : "s"}: ${result.sent.map((a) => a.title).join(" | ")}` : "No new big moves.");
  const text = JSON.stringify(result.state, null, 0).replace(/,"/g, ',\n"') + "\n";
  if (text === before) return false;
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, text);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const changed = await run({
    historyFile: fileURLToPath(new URL("../site/data/history.json", import.meta.url)),
    stateFile: fileURLToPath(new URL("../state/line-alerts.json", import.meta.url)),
    topic: (process.env.NTFY_TOPIC || "").trim()
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
