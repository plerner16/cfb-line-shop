// Final scores from The Odds API into site/data/scores.json, for grading the ledger.
//
// One check a day, Tuesday through Saturday, at the first hourly run from 5am Central. Each check
// returns every game completed in the last three days (2 credits), so:
//   Tuesday 5am   reaches back to Saturday 5am, which covers all of Saturday's games
//   Wed–Sat 5am   cover the previous night's games
// If a check fails, the next hourly run that morning tries again. About 43 credits a month.
//
// The private ledger repository reads this file and grades pending bets (its own scheduled job).
// Scores are public information, so this file lives with the public site.
//
// Environment:
//   ODDS_API_KEY  the key from The Odds API (a repository secret)

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { localParts, explain } from "./refresh-odds.mjs";

export const SCORES = { days: ["Tue", "Wed", "Thu", "Fri", "Sat"], fromHour: 5 };
const KEEP_DAYS = 14;
const FEED = "https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf/scores/";

// Has today's check happened yet, and is it time for it?
export function decideScores(now, lastCheck, schedule = SCORES) {
  const here = localParts(now);
  if (!schedule.days.includes(here.weekday)) return { go: false, why: `no score checks on ${here.weekday}` };
  if (here.hour < schedule.fromHour) return { go: false, why: `before ${schedule.fromHour}am` };
  if (lastCheck) {
    const then = localParts(new Date(lastCheck));
    if (then.day === here.day && then.hour >= schedule.fromHour) return { go: false, why: "already checked this morning" };
  }
  return { go: true, why: `${here.weekday} morning check` };
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// The feed's games, cut down to what grading needs: completed games with both scores.
export function finals(events) {
  const out = {};
  (events || []).forEach((ev) => {
    if (!ev || !ev.completed || !Array.isArray(ev.scores)) return;
    const score = (name) => { const s = ev.scores.find((x) => x && x.name === name); return s ? num(s.score) : null; };
    const home = score(ev.home_team), away = score(ev.away_team);
    if (home == null || away == null) return;
    out[ev.id] = { start: ev.commence_time, away: ev.away_team, home: ev.home_team, awayScore: away, homeScore: home };
  });
  return out;
}

async function fetchScores(key, fetchImpl) {
  const url = new URL(FEED);
  url.search = new URLSearchParams({ apiKey: key, daysFrom: "3", dateFormat: "iso" }).toString();
  let res;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  } catch {
    return { error: "Couldn't reach The Odds API for scores. The next hourly run will try again." };
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  console.log(`The Odds API scores: HTTP ${res.status}, used ${res.headers.get("x-requests-last") ?? "?"} credits, ${res.headers.get("x-requests-remaining") ?? "?"} left`);
  if (!res.ok) return { error: explain(res.status, body) };
  if (!Array.isArray(body)) return { error: "The Odds API sent unexpected scores. The next hourly run will try again." };
  return { events: body, remaining: num(res.headers.get("x-requests-remaining")) };
}

export async function run({ file, now = new Date(), key = "", force = false, fetchImpl = fetch }) {
  let prev = {};
  try { prev = JSON.parse(readFileSync(file, "utf8")) || {}; } catch { prev = {}; }
  const plan = force ? { go: true, why: "manual check" } : decideScores(now, prev.checkedAt);
  console.log(`${plan.go ? "Checking scores" : "Skipping scores"}: ${plan.why}`);
  if (!plan.go) return false;

  const result = key ? await fetchScores(key, fetchImpl) : { error: "There's no Odds API key, so scores can't be checked." };
  if (result.error) {
    console.log(`Score check failed: ${result.error}`);
    if (prev.lastError && prev.lastError.message === result.error) return false;
    writeFileSync(file, JSON.stringify({ ...prev, lastError: { at: now.toISOString(), message: result.error } }) + "\n");
    return true;
  }

  // Keep two weeks of finals, so a grading run that misses a day still finds them.
  const cutoff = now.getTime() - KEEP_DAYS * 864e5;
  const games = {};
  Object.entries(prev.games || {}).forEach(([id, g]) => { if (Date.parse(g.start) >= cutoff) games[id] = g; });
  const fresh = finals(result.events);
  Object.assign(games, fresh);
  console.log(`${Object.keys(fresh).length} final scores in the last three days; ${Object.keys(games).length} kept.`);
  writeFileSync(file, JSON.stringify({ checkedAt: now.toISOString(), lastError: null, creditsRemaining: result.remaining, games }) + "\n");
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = fileURLToPath(new URL("../site/data/scores.json", import.meta.url));
  const changed = await run({ file, key: (process.env.ODDS_API_KEY || "").trim(), force: process.env.FORCE_SCORES === "true" });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed ? "true" : "false"}\n`);
}
