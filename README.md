# CFB Line Shop

The best college football line across your sportsbooks, refreshed on a schedule, plus your bet ledger.

**Site:** https://plerner16.github.io/cfb-line-shop/ (the ledger is at `#ledger`)

On your phone, open the site and use **Add to Home Screen** (Safari: Share button; Chrome: ⋮ menu). It opens full screen with its own icon.

## The board

Each bet shows one line: the best one across your books, with the book under it (FD, DK, or both when they're the same).

- A better number wins, even at a worse price: +3½ beats +3, −3 beats −3½, a lower total is better for the Over and a higher total for the Under.
- On the same number, the better price wins.
- Highlighter means the books disagree and this is the better side of it. No highlight means every book has the same line.

Tap a price to put it on your card. After you bet it, fix the book, odds or stake if they changed and press **Add to ledger**.

## Adding a book

The books live in `site/books.json`. Add a line with The Odds API's key for the book, for example:

```json
{ "key": "betmgm", "name": "BetMGM", "short": "MGM" }
```

The next refresh pulls it, and the board, card and ledger pick it up. Up to 10 books cost the same credits as two (The Odds API counts every 10 bookmakers as one region). Bookmaker keys are listed at https://the-odds-api.com/sports-odds-data/bookmaker-apis.html.

## How the lines stay up to date

A GitHub Actions job (`.github/workflows/refresh-odds.yml`) runs hourly on weekdays. `scripts/refresh-odds.mjs` decides whether that run is one of the refreshes, pulls the lines from The Odds API into `site/data/odds.json`, and republishes the site. An open page checks for a newer file every few minutes and whenever you come back to it.

Refreshes happen at **8am, noon and 5pm Central, Monday through Friday**. If GitHub starts a run late or skips one, the next run makes it up. That's 15 refreshes a week at 3 credits each, about 195 of the free plan's 500 credits a month, which leaves roughly 100 refreshes a month for refreshing by hand. To change the times, edit `SCHEDULE` at the top of `scripts/refresh-odds.mjs`.

Press **Refresh** on the site to refresh right now (3 credits), or go to **Actions → Refresh lines → Run workflow** on GitHub.

## The ledger

Bets are saved in `ledger/bets.json` in this repository, one bet per line, so every device sees the same ledger and every change is in the history. The repository is public, so anyone with the site link can see the ledger. Saving a bet doesn't republish the site.

## Connecting a device

Refreshing and saving bets go through GitHub, so each device needs a GitHub token once. The site walks you through it: the token page opens with the name, a one-year expiration and the two permissions it needs (Actions and Contents, read and write) already filled in; you pick the `cfb-line-shop` repository and paste the token back. It's kept only in that browser. Any device can view the lines and the ledger without one.

## The API key

The Odds API key lives in the repository secret `ODDS_API_KEY` (Settings → Secrets and variables → Actions). It's only used by the refresh job and never appears on the site. If a refresh fails (a bad key, out of credits), the site says so at the top of the page and keeps showing the last good lines.
