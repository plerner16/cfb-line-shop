// Pulls FanDuel and DraftKings college football lines from The Odds API into site/data/odds.json,
// and adds them to site/data/history.json (how each line moved through the week).
//
// This runs every hour. Most runs decide there's nothing to do; refreshes happen at
//   8am, noon and 5pm Central, Monday through Friday
//   9am, 1pm and 5pm on Saturday, the last looks before most kickoffs (the closing lines)
// That's 18 refreshes a week at 3 credits each, about 235 of the free plan's 500 credits a month
// (280 with the morning score checks), which leaves room for refreshing by hand.
//
// Environment:
//   ODDS_API_KEY  the key from The Odds API (a repository secret)
//   FORCE=true    refresh now, whatever the schedule says (the site's Refresh button, Run workflow)

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HISTORY = require("../site/js/history.js");
const LS = require("../site/js/lines.js");

export const TZ = "America/Chicago";
const WEEKDAY = ["8:00", "12:00", "17:00"];
export const SCHEDULE = {
  // Central time, by day. Days that aren't listed have no refreshes.
  times: { Mon: WEEKDAY, Tue: WEEKDAY, Wed: WEEKDAY, Thu: WEEKDAY, Fri: WEEKDAY, Sat: ["9:00", "13:00", "17:00"] },
  graceMinutes: 30                    // a refresh up to 30 minutes before a slot counts for it
};

const FEED = "https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf/odds/";

// The books come from site/books.json, so adding one is a one-line change there. Up to 10 books cost
// the same as two (The Odds API counts each group of 10 bookmakers as one region).
export const DEFAULT_BOOKS = [
  { key: "fanduel", name: "FanDuel", short: "FD" },
  { key: "draftkings", name: "DraftKings", short: "DK" }
];
export function loadBooks(path) {
  try {
    const list = JSON.parse(readFileSync(path, "utf8"));
    const books = (Array.isArray(list) ? list : []).filter((b) => b && typeof b.key === "string" && b.key.trim())
      .map((b) => ({ key: b.key.trim(), name: String(b.name || b.key).trim(), short: String(b.short || b.name || b.key).trim() }));
    return books.length ? books : DEFAULT_BOOKS;
  } catch {
    return DEFAULT_BOOKS;
  }
}

// Markets the site watches but you don't bet at (scripts/markets.json): prediction markets, exchanges
// and overseas books. They ride along in the same request (the 10-bookmaker limit keeps it at
// 3 credits), stay off the board, and feed the market alerts.
export function loadMarkets(path) {
  try {
    const list = JSON.parse(readFileSync(path, "utf8"));
    return (Array.isArray(list) ? list : []).filter((b) => b && typeof b.key === "string" && b.key.trim())
      .map((b) => ({ key: b.key.trim(), name: String(b.name || b.key).trim(), short: String(b.short || b.name || b.key).trim() }));
  } catch {
    return [];
  }
}
export const MAX_BOOKMAKERS = 10;

// Splits one response: the board's books go to odds.json; the watched markets to their own files.
export function splitEvents(events, books) {
  const keep = new Set(books.map((b) => b.key));
  return events
    .map((ev) => ({ ev, own: (ev.bookmakers || []).filter((b) => keep.has(b.key)) }))
    .filter(({ ev, own }) => own.length || !(ev.bookmakers || []).length)
    .map(({ ev, own }) => ({ ...ev, bookmakers: own }));
}

// The markets' current lines (site/data/markets.json, one game per line) and, for the alerts, how their
// spreads and totals moved (state/market-history.json). Returns what each market covered.
export function recordMarkets({ events, now, markets, currentFile, historyFile }) {
  const t = Math.round(now.getTime() / 1000);
  const coverage = {};
  markets.forEach((m) => { coverage[m.key] = { games: 0, spreads: 0, totals: 0, moneylines: 0 }; });
  const games = {};
  for (const g of LS.normalize(events, now, markets)) {
    if (g.live) continue;
    const lines = {};
    for (const k of g.bookKeys) {
      const l = g.books[k];
      if (!l) continue;
      const row = HISTORY.rowOf(t, l);
      if (row.slice(1).every((x) => x === null)) continue;
      lines[k] = row;
      const c = coverage[k];
      c.games++;
      if (row[1] != null) c.spreads++;
      if (row[5] != null) c.totals++;
      if (row[8] != null) c.moneylines++;
    }
    if (Object.keys(lines).length) games[g.id] = { start: g.start.toISOString(), away: g.away, home: g.home, lines };
  }
  const ids = Object.keys(games).sort((a, b) => (games[a].start < games[b].start ? -1 : games[a].start > games[b].start ? 1 : a < b ? -1 : 1));
  const head = { updatedAt: now.toISOString(), books: markets, coverage };
  const text = JSON.stringify(head).slice(0, -1) + ',"games":{' +
    (ids.length ? "\n" + ids.map((id) => JSON.stringify(id) + ":" + JSON.stringify(games[id])).join(",\n") + "\n" : "") + "}}\n";
  if (currentFile) writeFileSync(currentFile, text);
  console.log("Markets: " + markets.map((m) => {
    const c = coverage[m.key];
    return `${m.name} ${c.games} games (${c.spreads} spreads, ${c.totals} totals, ${c.moneylines} moneylines)`;
  }).join("; "));

  if (historyFile) {
    let hist;
    try { hist = HISTORY.parse(readFileSync(historyFile, "utf8")); } catch { hist = HISTORY.empty(); }
    const added = HISTORY.addSnapshot(hist, events, now, markets, true);
    HISTORY.prune(hist, now);
    mkdirSync(dirname(historyFile), { recursive: true });
    writeFileSync(historyFile, HISTORY.format(hist));
    console.log(`Market history: ${added} new lines.`);
  }
  return coverage;
}

export function localParts(date) {
  const parts = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  return {
    weekday: parts.weekday,
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function toMinutes(hm) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}
function label(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "am" : "pm"}`;
}

// Should a run at `now` refresh, given when the last good refresh happened?
// A run refreshes when the latest slot that has started today hasn't been covered yet, so a late
// or skipped GitHub run is made up by the next one.
export function decide(now, lastSuccess, schedule = SCHEDULE) {
  const here = localParts(now);
  const times = schedule.times[here.weekday] || [];
  if (!times.length) return { go: false, why: `no refreshes on ${here.weekday}` };
  const nowMins = here.hour * 60 + here.minute;
  const started = times.map(toMinutes).filter((t) => t <= nowMins);
  if (!started.length) return { go: false, why: "before the first refresh of the day" };
  const slot = Math.max(...started);
  const slotStart = now.getTime() - (nowMins - slot) * 60000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds();
  if (!lastSuccess) return { go: true, why: `${label(slot)} refresh (no lines yet)` };
  const last = new Date(lastSuccess).getTime();
  if (last >= slotStart - schedule.graceMinutes * 60000) {
    return { go: false, why: `${label(slot)} refresh already done` };
  }
  return { go: true, why: `${label(slot)} refresh` };
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Error text is shown on the public page, so it never includes the key or the request URL.
export function explain(status, body) {
  const msg = body && typeof body.message === "string" ? body.message.trim() : "";
  if (/quota/i.test(msg)) return "Out of Odds API credits for this billing period. Refreshes pick up again when the plan resets.";
  if (status === 401) return `The Odds API didn't accept the key${msg ? ` (${msg})` : ""}. Check the ODDS_API_KEY secret on GitHub.`;
  if (status === 429) return "The Odds API asked to slow down. The next scheduled run will try again.";
  return `The Odds API answered with ${msg || `error ${status}`}. The next scheduled run will try again.`;
}

async function fetchOdds(key, books) {
  const url = new URL(FEED);
  url.search = new URLSearchParams({
    apiKey: key,
    bookmakers: books.map((b) => b.key).join(","),
    markets: "h2h,spreads,totals",
    oddsFormat: "american",
    dateFormat: "iso",
    includeRotationNumbers: "true"
  }).toString();

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  } catch {
    return { error: "Couldn't reach The Odds API. The next scheduled run will try again." };
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  const remaining = num(res.headers.get("x-requests-remaining"));
  const last = num(res.headers.get("x-requests-last"));
  console.log(`The Odds API: HTTP ${res.status}, this call used ${last ?? "?"} credits, ${remaining ?? "?"} left`);

  if (!res.ok) return { error: explain(res.status, body) };
  if (!Array.isArray(body)) return { error: "The Odds API sent something unexpected. The next scheduled run will try again." };
  return { events: body, remaining };
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

// Adds a refresh to the line history and drops games long finished. Returns true if the file changed.
export function recordHistory(historyFile, events, now, books) {
  let hist;
  try { hist = HISTORY.parse(readFileSync(historyFile, "utf8")); } catch { hist = HISTORY.empty(); }
  const before = HISTORY.format(hist);
  const added = HISTORY.addSnapshot(hist, events, now, books);
  const dropped = HISTORY.prune(hist, now);
  console.log(`Line history: ${added} new lines, ${dropped} finished games dropped, ${Object.keys(hist.games).length} games kept.`);
  const text = HISTORY.format(hist);
  if (text === before) return false;
  writeFileSync(historyFile, text);
  return true;
}

export async function run({ file, booksFile, historyFile = null, marketsFile = null, marketsOut = null, marketHistoryFile = null, now = new Date(), force = false, key = "" }) {
  let prev = {};
  try { prev = JSON.parse(readFileSync(file, "utf8")) || {}; } catch { prev = {}; }

  const plan = force ? { go: true, why: "manual run" } : decide(now, prev.updatedAt);
  console.log(`${plan.go ? "Refreshing" : "Skipping"}: ${plan.why}`);
  if (!plan.go) return false;

  const books = loadBooks(booksFile);
  const markets = (marketsFile ? loadMarkets(marketsFile) : []).filter((m) => !books.some((b) => b.key === m.key))
    .slice(0, Math.max(0, MAX_BOOKMAKERS - books.length));
  const result = key ? await fetchOdds(key, books.concat(markets)) : {
    error: "There's no Odds API key yet. Add it on GitHub as a repository secret named ODDS_API_KEY."
  };

  let next;
  if (result.error) {
    console.log(`Refresh failed: ${result.error}`);
    // A scheduled run that hits the same problem again leaves the file alone. A manual run always
    // records it, so the Refresh button on the site hears back.
    if (!force && prev.lastError && prev.lastError.message === result.error) {
      console.log("Same problem as last time, so the page already says so.");
      return false;
    }
    next = {
      updatedAt: prev.updatedAt || null,
      creditsRemaining: prev.creditsRemaining ?? null,
      lastError: { at: now.toISOString(), message: result.error },
      books: Array.isArray(prev.books) ? prev.books : books,
      events: Array.isArray(prev.events) ? prev.events : []
    };
  } else {
    const events = markets.length ? splitEvents(result.events, books) : result.events;
    console.log(`Got ${events.length} games.`);
    next = {
      updatedAt: now.toISOString(),
      creditsRemaining: result.remaining,
      lastError: null,
      books,
      events
    };
    if (historyFile) recordHistory(historyFile, events, now, books);
    if (markets.length && (marketsOut || marketHistoryFile)) {
      recordMarkets({ events: result.events, now, markets, currentFile: marketsOut, historyFile: marketHistoryFile });
    }
  }
  writeFileSync(file, JSON.stringify(next) + "\n");
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = fileURLToPath(new URL("../site/data/odds.json", import.meta.url));
  const booksFile = fileURLToPath(new URL("../site/books.json", import.meta.url));
  const historyFile = fileURLToPath(new URL("../site/data/history.json", import.meta.url));
  const changed = await run({
    file,
    booksFile,
    historyFile,
    marketsFile: fileURLToPath(new URL("./markets.json", import.meta.url)),
    marketsOut: fileURLToPath(new URL("../site/data/markets.json", import.meta.url)),
    marketHistoryFile: fileURLToPath(new URL("../state/market-history.json", import.meta.url)),
    force: process.env.FORCE === "true",
    key: (process.env.ODDS_API_KEY || "").trim()
  });
  setOutput("changed", changed ? "true" : "false");
}
