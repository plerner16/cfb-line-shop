// Sends a phone alert (through the ntfy app) when a spread or total moves more than N points in
// N days at a book: 1½+ in a day, 2½+ in two days, and so on up to a week. Moneylines aren't checked.
//
// It runs after each refresh and reads site/data/history.json. Each move is its own alert, sent once;
// the same game and market alerts again only once the line has gone at least another point. What's
// been sent is kept in state/line-alerts.json (not part of the published site). The site lists the
// same moves under Big moves, where you can mark them seen.
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
export const MAX_PER_RUN = 20; // a safety limit; anything past it goes out on the next run
const TZ = "America/Chicago";
const whenFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" });
const when = (ms) => whenFmt.format(new Date(ms));
const bookName = (books, k) => (books.find((b) => b.key === k) || {}).name || k;

// Every game's current big moves, one per game and market, biggest first (shared with the site).
export const currentMoves = (hist, nowMs) => H.bigMoveGroups(hist, nowMs);
// New since the last alert: never alerted, or a point or more past the line it was alerted at.
export const isNew = (state, id, m) => H.isNewMove(state.sent, id, m);

// One alert per game and market. Tapping it opens the game on the site with its line moves showing.
export function describe(group, books) {
  const { game, moves } = group;
  const lines = moves.map((m) => `${bookName(books, m.book)}: ${H.moveText(game, m).replace(/^Total /, "")}, ${H.pointsText(m.move)} ${H.spanText(m, when)}`);
  return {
    title: `Big move: ${H.groupTitle(group)}`,
    message: `${lines.join("\n")}\n${game.away} @ ${game.home} · kickoff ${when(Date.parse(game.start))}`,
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
  for (const m of group.moves) state.sent[H.moveKey(group.id, m)] = m.to.point;
}

// Returns { state, sent: [alerts], error }. `send` posts one alert and throws if it couldn't; after a
// failure nothing more is sent, and what wasn't sent waits for the next run.
export async function check({ hist, state, nowMs, send }) {
  state = { startedAt: state.startedAt || null, sent: { ...(state.sent || {}) } };
  const books = hist.books || [];
  const out = [];
  let error = null;
  const trySend = async (alert) => {
    if (error) return false;
    try { await send(alert); out.push(alert); return true; } catch (e) { error = e.message; return false; }
  };

  // Forget games that are gone from the history.
  for (const k of Object.keys(state.sent)) if (!hist.games[k.split(":")[0]]) delete state.sent[k];

  if (!state.startedAt) {
    const ok = await trySend({
      title: "Line alerts are on",
      message: "You'll get an alert when a spread or total moves more than 1 point in a day, 2 in two days, and so on up to 7 in a week, checked after each lines refresh. Each one is also on the site's Big moves list, where you can mark it seen.",
      click: `${SITE}#alerts`
    });
    if (!ok) return { state, sent: out, error };
    state.startedAt = new Date(nowMs).toISOString();
  }

  const fresh = currentMoves(hist, nowMs).filter((g) => g.moves.some((m) => isNew(state, g.id, m)));
  for (const g of fresh.slice(0, MAX_PER_RUN)) if (await trySend(describe(g, books))) markSent(state, g);
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
