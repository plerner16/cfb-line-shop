// Pulls FanDuel and DraftKings college football lines from The Odds API into site/data/odds.json.
//
// GitHub runs this every hour. Most runs decide there's nothing to do; the schedule below keeps
// usage inside the free plan (500 credits a month, 3 credits per refresh):
//   Thu–Sat: every ~2 hours from 8am to 10pm Central  (8 refreshes a day)
//   Sun–Wed: once a day, at the first run after noon  (1 refresh a day)
// That's about 28 refreshes a week, roughly 370 credits a month.
//
// Environment:
//   ODDS_API_KEY  the key from The Odds API (a repository secret)
//   FORCE=true    refresh now, whatever the schedule says (manual runs)

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TZ = "America/Chicago";
export const SCHEDULE = {
  gameDays: ["Thu", "Fri", "Sat"],
  firstHour: 8,       // earliest refresh, local hour
  lastHour: 22,       // latest refresh, local hour (10pm)
  gapMinutes: 115,    // game days: two hours apart, with room for GitHub's late starts
  otherDaysHour: 12   // other days: one refresh, at or after noon
};

const FEED = "https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf/odds/";

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

// Should a run at `now` refresh, given when the last good refresh happened?
export function decide(now, lastSuccess, schedule = SCHEDULE) {
  const here = localParts(now);
  if (here.hour < schedule.firstHour || here.hour > schedule.lastHour) {
    return { go: false, why: `outside ${schedule.firstHour}:00–${schedule.lastHour}:59 Central` };
  }
  const last = lastSuccess ? new Date(lastSuccess) : null;
  if (schedule.gameDays.includes(here.weekday)) {
    if (!last) return { go: true, why: "no lines yet" };
    const mins = Math.round((now - last) / 60000);
    return mins >= schedule.gapMinutes
      ? { go: true, why: `game day, last refresh ${mins} min ago` }
      : { go: false, why: `game day, last refresh only ${mins} min ago` };
  }
  if (here.hour < schedule.otherDaysHour) return { go: false, why: "off day, waiting for noon" };
  if (!last) return { go: true, why: "no lines yet" };
  const then = localParts(last);
  if (then.day === here.day && then.hour >= schedule.otherDaysHour) {
    return { go: false, why: "off day, already refreshed this afternoon" };
  }
  return { go: true, why: "off day, daily refresh" };
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

async function fetchOdds(key) {
  const url = new URL(FEED);
  url.search = new URLSearchParams({
    apiKey: key,
    bookmakers: "fanduel,draftkings",
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

export async function run({ file, now = new Date(), force = false, key = "" }) {
  let prev = {};
  try { prev = JSON.parse(readFileSync(file, "utf8")) || {}; } catch { prev = {}; }

  const plan = force ? { go: true, why: "manual run" } : decide(now, prev.updatedAt);
  console.log(`${plan.go ? "Refreshing" : "Skipping"}: ${plan.why}`);
  if (!plan.go) return false;

  const result = key ? await fetchOdds(key) : {
    error: "There's no Odds API key yet. Add it on GitHub as a repository secret named ODDS_API_KEY."
  };

  let next;
  if (result.error) {
    console.log(`Refresh failed: ${result.error}`);
    if (prev.lastError && prev.lastError.message === result.error) {
      console.log("Same problem as last time, so the page already says so.");
      return false;
    }
    next = {
      updatedAt: prev.updatedAt || null,
      creditsRemaining: prev.creditsRemaining ?? null,
      lastError: { at: now.toISOString(), message: result.error },
      events: Array.isArray(prev.events) ? prev.events : []
    };
  } else {
    console.log(`Got ${result.events.length} games.`);
    next = {
      updatedAt: now.toISOString(),
      creditsRemaining: result.remaining,
      lastError: null,
      events: result.events
    };
  }
  writeFileSync(file, JSON.stringify(next) + "\n");
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = fileURLToPath(new URL("../site/data/odds.json", import.meta.url));
  const changed = await run({
    file,
    force: process.env.FORCE === "true",
    key: (process.env.ODDS_API_KEY || "").trim()
  });
  setOutput("changed", changed ? "true" : "false");
}
