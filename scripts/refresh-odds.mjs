// Pulls FanDuel and DraftKings college football lines from The Odds API into site/data/odds.json.
//
// GitHub runs this hourly on weekdays. Most runs decide there's nothing to do; refreshes happen at
//   8am, noon and 5pm Central, Monday through Friday
// That's 15 refreshes a week at 3 credits each, about 195 of the free plan's 500 credits a month,
// which leaves room for refreshing by hand.
//
// Environment:
//   ODDS_API_KEY  the key from The Odds API (a repository secret)
//   FORCE=true    refresh now, whatever the schedule says (the site's Refresh button, Run workflow)

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TZ = "America/Chicago";
export const SCHEDULE = {
  days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
  times: ["8:00", "12:00", "17:00"],  // Central time
  graceMinutes: 30                    // a refresh up to 30 minutes before a slot counts for it
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
  if (!schedule.days.includes(here.weekday)) return { go: false, why: `no refreshes on ${here.weekday}` };
  const nowMins = here.hour * 60 + here.minute;
  const started = schedule.times.map(toMinutes).filter((t) => t <= nowMins);
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
