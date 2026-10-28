# CFB Line Shop

FanDuel vs DraftKings college football lines, side by side, with the better number highlighted. The lines refresh on a schedule, so the page is current whenever you open it.

**Site:** https://plerner16.github.io/cfb-line-shop/

On your phone, open the site and use **Add to Home Screen** (Safari: Share button; Chrome: ⋮ menu). It opens full screen with its own icon.

## How it stays up to date

A GitHub Actions job (`.github/workflows/refresh-odds.yml`) runs every hour. `scripts/refresh-odds.mjs` decides whether that hour is a refresh, pulls the lines from The Odds API into `site/data/odds.json`, and republishes the site. An open page checks for a newer file every few minutes and whenever you come back to it.

Schedule (Central time), sized for the free plan's 500 credits a month at 3 credits per refresh:

| Days | Refreshes |
|---|---|
| Thursday – Saturday | Every 2 hours, 8am – 10pm (8 a day) |
| Sunday – Wednesday | Once, around noon |

That's about 28 refreshes a week, roughly 370 credits a month. To change it, edit `SCHEDULE` at the top of `scripts/refresh-odds.mjs`.

## Refresh right now

Go to **Actions → Refresh lines → Run workflow**. It refreshes immediately, whatever the schedule says, and uses 3 credits.

## The API key

The key lives in the repository secret `ODDS_API_KEY` (Settings → Secrets and variables → Actions). It's only used by the refresh job and never appears on the site. If a refresh fails (a bad key, out of credits), the site says so at the top of the page and keeps showing the last good lines.

## Your card

Picks you add are saved in the browser on that device. **Copy placed bets for Bet Ledger** works the same as in the Claude version: paste into Bet Ledger's *Import from Line Shop*.
