# CFB Line Shop

FanDuel vs DraftKings college football lines, side by side, with the better number highlighted. The lines refresh on a schedule, so the page is current whenever you open it.

**Site:** https://plerner16.github.io/cfb-line-shop/

On your phone, open the site and use **Add to Home Screen** (Safari: Share button; Chrome: ⋮ menu). It opens full screen with its own icon.

## How it stays up to date

A GitHub Actions job (`.github/workflows/refresh-odds.yml`) runs hourly on weekdays. `scripts/refresh-odds.mjs` decides whether that run is one of the refreshes, pulls the lines from The Odds API into `site/data/odds.json`, and republishes the site. An open page checks for a newer file every few minutes and whenever you come back to it.

Refreshes happen at **8am, noon and 5pm Central, Monday through Friday**. If GitHub starts a run late or skips one, the next run makes it up. That's 15 refreshes a week at 3 credits each, about 195 of the free plan's 500 credits a month, which leaves roughly 100 refreshes a month for refreshing by hand. To change the times, edit `SCHEDULE` at the top of `scripts/refresh-odds.mjs`.

## Refresh right now

Press **Refresh** at the top of the site. The first time on each device, it walks you through making a GitHub token that only has access to this repository's Actions; after that it's one tap. The token is kept in that browser only. New lines show up in about a minute. Each refresh uses 3 credits.

You can also go to **Actions → Refresh lines → Run workflow** on GitHub.

## The API key

The key lives in the repository secret `ODDS_API_KEY` (Settings → Secrets and variables → Actions). It's only used by the refresh job and never appears on the site. If a refresh fails (a bad key, out of credits), the site says so at the top of the page and keeps showing the last good lines.

## Your card

Picks you add are saved in the browser on that device. **Copy placed bets for Bet Ledger** works the same as in the Claude version: paste into Bet Ledger's *Import from Line Shop*.
