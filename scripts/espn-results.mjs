// Saves college football final scores from ESPN's public scoreboard into state/results.json, a
// permanent record (scores.json only keeps two weeks). Used to study how line moves turned out.
//
//   node scripts/espn-results.mjs 2026-10-27 2026-11-23     (a range of dates, Central time)
//   node scripts/espn-results.mjs                           (the last seven days)
//
// No key needed. Games already saved as final are kept as they are.

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const URL_BASE = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard";

function* days(from, to) {
  for (let d = new Date(from + "T12:00:00Z"); d <= new Date(to + "T12:00:00Z"); d = new Date(d.getTime() + 864e5)) {
    yield d.toISOString().slice(0, 10).replace(/-/g, "");
  }
}

export function parseScoreboard(json) {
  const out = {};
  for (const ev of json.events || []) {
    const comp = (ev.competitions || [])[0];
    if (!comp) continue;
    const status = (comp.status || ev.status || {}).type || {};
    if (!status.completed) continue;
    const home = (comp.competitors || []).find((c) => c.homeAway === "home");
    const away = (comp.competitors || []).find((c) => c.homeAway === "away");
    if (!home || !away) continue;
    out[ev.id] = {
      start: comp.date || ev.date,
      away: away.team.displayName, home: home.team.displayName,
      awayScore: Number(away.score), homeScore: Number(home.score),
      neutral: !!comp.neutralSite
    };
  }
  return out;
}

export async function run({ file, from, to, fetchImpl = fetch }) {
  let saved = { games: {} };
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { /* new file */ }
  let added = 0, failed = 0;
  for (const day of days(from, to)) {
    try {
      const res = await fetchImpl(`${URL_BASE}?dates=${day}&groups=80&limit=500`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const games = parseScoreboard(await res.json());
      for (const [id, g] of Object.entries(games)) if (!saved.games[id]) { saved.games[id] = g; added++; }
      console.log(`${day}: ${Object.keys(games).length} finals`);
    } catch (e) {
      failed++;
      console.log(`${day}: couldn't read (${e.message})`);
    }
  }
  const ids = Object.keys(saved.games).sort((a, b) => (saved.games[a].start < saved.games[b].start ? -1 : 1));
  const text = '{"games":{' + (ids.length ? "\n" + ids.map((id) => JSON.stringify(id) + ":" + JSON.stringify(saved.games[id])).join(",\n") + "\n" : "") + "}}\n";
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`${added} new finals saved, ${ids.length} in all${failed ? `, ${failed} days couldn't be read` : ""}.`);
  return added > 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const today = new Date().toISOString().slice(0, 10);
  const back = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const changed = await run({
    file: fileURLToPath(new URL("../state/results.json", import.meta.url)),
    from: process.argv[2] || back,
    to: process.argv[3] || today
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}
