// Kickoff forecasts for every game on the board, into site/data/weather.json.
//
// Runs every hour (see .github/workflows/refresh-odds.yml). Weather comes from Open-Meteo, which is free
// for non-commercial use, needs no key and doesn't touch The Odds API credits.
//
// Each game is placed at the home team's stadium (scripts/stadiums.json) unless it's listed as a
// neutral-site game (scripts/neutral-sites.json). For open-air stadiums the forecast covers kickoff and
// the next three hours: temperature at kickoff, the strongest wind and gusts, the highest chance of
// rain or snow, and the worst sky. Indoor stadiums just say so.
//
// Environment:
//   CHECK_STADIUMS=true   also look up each stadium's city and report any that look misplaced (logs only)

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FORECAST = "https://api.open-meteo.com/v1/forecast";
const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
export const GAME_HOURS = 4;   // kickoff hour plus the next three
export const DAYS = 14;        // how far ahead to ask for (two weeks keeps each call at Open-Meteo's base weight)
const CHUNK = 10;              // locations per request
const TRIES = 3;               // attempts per request before giving up on this run
const TZ = "America/Chicago";

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

export function centralDay(date) {
  const p = {};
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}`;
}

function place(s) {
  return { venue: s.venue, city: s.city, lat: Number(s.lat), lon: Number(s.lon), roof: s.roof || "open" };
}

// Where a game is played: a listed neutral site, or else the home team's stadium.
export function venueFor(ev, stadiums, neutral) {
  const day = centralDay(new Date(ev.commence_time));
  for (const n of (neutral && neutral.games) || []) {
    const teams = new Set(n.teams || []);
    if (teams.has(ev.home_team) && teams.has(ev.away_team) && (!n.from || day >= n.from) && (!n.to || day <= n.to)) {
      return { ...place(n), neutral: true };
    }
  }
  const s = stadiums[ev.home_team];
  return s ? { ...place(s), neutral: false } : null;
}

// WMO weather codes, from calm to severe.
const SKY = ["clear", "partly", "cloudy", "fog", "drizzle", "rain", "snow", "storm"];
export function skyOf(code) {
  if (code == null) return null;
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code === 45 || code === 48) return "fog";
  if (code === 3) return "cloudy";
  if (code === 1 || code === 2) return "partly";
  return "clear";
}

// The game window out of one location's hourly forecast. Null when kickoff is outside the forecast.
export function summarize(hourly, kickoffSec) {
  const times = hourly && hourly.time;
  if (!Array.isArray(times)) return null;
  const idx = times.indexOf(Math.floor(kickoffSec / 3600) * 3600);
  if (idx < 0) return null;
  const at = [];
  for (let i = idx; i < Math.min(idx + GAME_HOURS, times.length); i++) at.push(i);
  const series = (name) => at.map((i) => (hourly[name] || [])[i]).filter((v) => typeof v === "number");
  const max = (name) => { const v = series(name); return v.length ? Math.round(Math.max(...v)) : null; };
  const temp = (hourly.temperature_2m || [])[idx];
  if (typeof temp !== "number") return null;
  const skies = series("weather_code").map(skyOf);
  const sky = skies.reduce((worst, s) => (SKY.indexOf(s) > SKY.indexOf(worst) ? s : worst), skies[0] || null);
  return {
    temp: Math.round(temp),
    wind: max("wind_speed_10m"),
    gust: max("wind_gusts_10m"),
    precip: max("precipitation_probability"),
    sky,
    snow: skies.includes("snow")
  };
}

function why(err) {
  if (!err) return "unknown error";
  if (err.name === "TimeoutError") return "Open-Meteo took too long to answer";
  const c = err.cause;
  return [err.message, c && (c.code || c.message)].filter(Boolean).join(": ");
}

async function forecastWithRetry(locs, fetchImpl) {
  let last;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try { return await forecast(locs, fetchImpl); } catch (err) {
      last = err;
      console.log(`Weather request for ${locs.length} stadiums failed (try ${attempt} of ${TRIES}): ${why(err)}`);
      if (attempt < TRIES) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw last;
}

async function forecast(locs, fetchImpl) {
  const url = new URL(FORECAST);
  url.search = new URLSearchParams({
    latitude: locs.map((l) => l.lat.toFixed(3)).join(","),
    longitude: locs.map((l) => l.lon.toFixed(3)).join(","),
    hourly: "temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    timeformat: "unixtime",
    timezone: "GMT",
    forecast_days: String(DAYS)
  }).toString();
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) throw new Error(`Open-Meteo answered with ${(body && body.reason) || `error ${res.status}`}`);
  const list = Array.isArray(body) ? body : [body];
  if (list.length !== locs.length) throw new Error("Open-Meteo sent back a different number of places than asked for");
  return list;
}

export async function run({ oddsFile, outFile, stadiumsFile, neutralFile, now = new Date(), fetchImpl = fetch }) {
  const odds = readJson(oddsFile, {});
  const stadiums = readJson(stadiumsFile, {});
  const neutral = readJson(neutralFile, { games: [] });
  const prev = readJson(outFile, null);

  const games = {};
  const locs = new Map();
  const missing = new Set();
  const horizon = now.getTime() + (DAYS - 1) * 864e5;

  for (const ev of odds.events || []) {
    const kick = new Date(ev.commence_time);
    if (!(kick.getTime() > now.getTime() - 3 * 3600e3)) continue; // over or nearly over
    const v = venueFor(ev, stadiums, neutral);
    if (!v) { missing.add(ev.home_team); continue; }
    const g = { venue: v.venue, city: v.city, roof: v.roof };
    if (v.neutral) g.neutral = true;
    games[ev.id] = g;
    if (v.roof !== "open") continue;
    if (kick.getTime() > horizon) { g.later = true; continue; }
    const key = `${v.lat.toFixed(3)},${v.lon.toFixed(3)}`;
    if (!locs.has(key)) locs.set(key, { lat: v.lat, lon: v.lon, games: [] });
    locs.get(key).games.push({ id: ev.id, kick: Math.floor(kick.getTime() / 1000) });
  }

  // A batch that fails keeps its games' last forecast; the rest still update.
  const places = [...locs.values()];
  const prevGames = (prev && prev.games) || {};
  let failed = 0, lastError = "";
  for (let i = 0; i < places.length; i += CHUNK) {
    const chunk = places.slice(i, i + CHUNK);
    let results;
    try {
      results = await forecastWithRetry(chunk, fetchImpl);
    } catch (err) {
      failed++;
      lastError = why(err);
      chunk.forEach((loc) => loc.games.forEach((g) => {
        const old = prevGames[g.id];
        if (old && old.temp != null) {
          ["temp", "wind", "gust", "precip", "sky", "snow"].forEach((k) => { if (old[k] !== undefined) games[g.id][k] = old[k]; });
        }
      }));
      continue;
    }
    chunk.forEach((loc, j) => {
      loc.games.forEach((g) => {
        const s = summarize(results[j].hourly, g.kick);
        if (s) Object.assign(games[g.id], s);
        else games[g.id].later = true;
      });
    });
  }
  const batches = Math.ceil(places.length / CHUNK);
  if (failed && failed === batches) {
    console.log(`Weather not updated: ${lastError}. Keeping the last forecast.`);
    return { changed: false, error: lastError, missing: [...missing] };
  }
  if (failed) console.log(`${failed} of ${batches} weather requests failed (${lastError}); those games keep their last forecast.`);

  if (missing.size) console.log(`No stadium on file for: ${[...missing].join(", ")}. Add them to scripts/stadiums.json.`);
  const withWeather = Object.values(games).filter((g) => g.temp != null).length;
  console.log(`Weather for ${withWeather} games at ${places.length} stadiums; ${Object.keys(games).length - withWeather} indoors or too far out.`);

  if (prev && JSON.stringify(prev.games) === JSON.stringify(games)) {
    console.log("Forecast unchanged.");
    return { changed: false, missing: [...missing] };
  }
  const out = { updatedAt: now.toISOString(), source: "Open-Meteo", games };
  writeFileSync(outFile, JSON.stringify(out) + "\n");
  return { changed: true, missing: [...missing] };
}

// ---------- one-off check of the stadium list ----------
const STATES = { AL: "Alabama", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  NE: "Nebraska", NV: "Nevada", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", SC: "South Carolina", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
function km(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
async function checkStadiums(stadiumsFile, neutralFile) {
  const all = Object.entries(readJson(stadiumsFile, {}));
  ((readJson(neutralFile, {}).games) || []).forEach((n) => all.push([n.teams.join(" vs "), n]));
  const flagged = [];
  for (const [team, s] of all) {
    const [cityName, st] = s.city.split(",").map((x) => x.trim());
    const url = `${GEOCODE}?name=${encodeURIComponent(cityName)}&count=10&countryCode=US&language=en&format=json`;
    try {
      const body = await (await fetch(url, { signal: AbortSignal.timeout(15000) })).json();
      const hits = (body.results || []).filter((x) => !STATES[st] || x.admin1 === STATES[st]);
      if (!hits.length) { flagged.push(`${team}: couldn't find ${s.city}`); continue; }
      const d = Math.min(...hits.map((h) => km(s, { lat: h.latitude, lon: h.longitude })));
      if (d > 25) flagged.push(`${team}: ${s.venue} is ${Math.round(d)} km from ${s.city}`);
    } catch (e) {
      flagged.push(`${team}: lookup failed (${e.message})`);
    }
  }
  console.log(flagged.length ? `Stadium check, worth a look:\n  ${flagged.join("\n  ")}` : `Stadium check: all ${all.length} stadiums are where their cities are.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = (p) => fileURLToPath(new URL(p, import.meta.url));
  const files = {
    oddsFile: here("../site/data/odds.json"),
    outFile: here("../site/data/weather.json"),
    stadiumsFile: here("./stadiums.json"),
    neutralFile: here("./neutral-sites.json")
  };
  const result = await run(files);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed ? "true" : "false"}\n`);
  if (process.env.CHECK_STADIUMS === "true") await checkStadiums(files.stadiumsFile, files.neutralFile);
  if (!existsSync(files.outFile)) writeFileSync(files.outFile, JSON.stringify({ updatedAt: null, source: "Open-Meteo", games: {} }) + "\n");
}
