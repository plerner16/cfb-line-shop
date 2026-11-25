# CFB Line Shop

The best college football line across your sportsbooks, refreshed on a schedule, plus your bet ledger.

**Site:** https://plerner16.github.io/cfb-line-shop/ (the ledger is at `#ledger`, on connected devices)

On your phone, open the site and use **Add to Home Screen** (Safari: Share button; Chrome: ⋮ menu). It opens full screen with its own icon.

## The board

Each bet shows one line: the best one across your books, with the book under it (FD, DK, or both when they're the same).

- A better number wins, even at a worse price: +3½ beats +3, −3 beats −3½, a lower total is better for the Over and a higher total for the Under.
- On the same number, the better price wins.
- Highlighter means the books disagree and this is the better side of it. No highlight means every book has the same line.

Tap a price to put it on your card. After you bet it, fix the book, odds or stake if they changed and press **Add to ledger**.

## Weather

Each game shows the forecast at the stadium for kickoff and the next three hours: temperature, sky or the chance of rain or snow, and the strongest wind. Games with 15 mph wind or 25 mph gusts are flagged Windy; indoor stadiums say Dome. The forecast comes from [Open-Meteo](https://open-meteo.com/) (free, no key, no Odds API credits) and updates every hour, every day.

- `scripts/stadiums.json` places each team's home games (stadium, city, coordinates, roof). A team that's missing shows no weather, and the hourly job's log names it.
- `scripts/neutral-sites.json` lists games played somewhere else (bowls, conference championships, Army–Navy), matched on both teams and a date range.

## Final scores and grading

`scripts/refresh-scores.mjs` checks final scores once a morning, Tuesday through Saturday, at the first hourly run from 5am Central, and saves them to `site/data/scores.json` (two weeks kept). Each check returns every game completed in the last three days and costs 2 credits, about 43 a month. Tuesday's check reaches back to Saturday morning, so it covers all of Saturday's games; the other mornings cover the night before. A failed check is retried the next hour.

The private `cfb-bet-ledger` repository grades pending bets from that file each morning (its own workflow). Bets added from the card carry their game id, so they're matched exactly; bets logged by hand are matched on the matchup and date. Bets you mark yourself are never changed.

## Adding a book

The books live in `site/books.json`. Add a line with The Odds API's key for the book, for example:

```json
{ "key": "betmgm", "name": "BetMGM", "short": "MGM" }
```

The next refresh pulls it, and the board, card and ledger pick it up. Up to 10 books cost the same credits as two (The Odds API counts every 10 bookmakers as one region). Bookmaker keys are listed at https://the-odds-api.com/sports-odds-data/bookmaker-apis.html.

## How the lines stay up to date

A GitHub Actions job (`.github/workflows/refresh-odds.yml`) runs every hour. `scripts/refresh-weather.mjs` updates the weather on every run; `scripts/refresh-odds.mjs` decides whether the run is one of the line refreshes and, if so, pulls the lines from The Odds API into `site/data/odds.json`. Then the site republishes. An open page checks for a newer file every few minutes and whenever you come back to it.

Refreshes happen at **8am, noon and 5pm Central, Monday through Friday, and 9am, 1pm and 5pm on Saturday** (the last looks before most kickoffs, which make the closing lines). If a run starts late or is skipped, the next run makes it up. That's 18 refreshes a week at 3 credits each, about 235 of the free plan's 500 credits a month (about 280 with the morning score checks), which leaves roughly 70 refreshes a month for refreshing by hand. To change the times, edit `SCHEDULE` at the top of `scripts/refresh-odds.mjs`.

## Line history

Every refresh is also added to `site/data/history.json`: for each game and book, a row each time a line changed (spread, total and moneyline, with prices), stamped with the refresh that first saw it. Lines from after kickoff are never recorded, so the last row before kickoff is the closing line. Games are dropped 10 days after kickoff. On the board, a line that has moved shows where the best line opened, and **Line moves** on a game shows every change at each book. The private ledger's morning job saves each bet's closing line from this file. The history was rebuilt back to October 28 from the saved copies of `odds.json`; before November 21 there were no Saturday refreshes, so Saturday games' closes from then are Friday evening's lines.

Press **Refresh** on the site to refresh right now (3 credits), or go to **Actions → Refresh lines → Run workflow** on GitHub and tick **Refresh the lines now**.

GitHub's own scheduler skips many runs when it's busy (it rarely ran this job in the morning), so a free timer at cron-job.org starts it at :05 every hour with `{"ref":"main","inputs":{"force":false}}`, which behaves like a scheduled run. GitHub's schedule stays on as a backup; extra runs do nothing extra.

## Line alerts

After each refresh, `scripts/line-alerts.mjs` checks the line history for big moves: a spread or total that moved more than 1 point in a day, 2 in two days, and so on up to 7 in a week, at either book (compared with that book's line then, or its first line if the game was posted since). Moneylines aren't checked. Each one is sent to your phone as its own alert through [ntfy](https://ntfy.sh), a free notification app (up to 20 a refresh; any more go out on the next one), and tapping it opens the game on the site with its line moves showing. A game and market alerts again only after the line moves at least another point. The same moves are listed under **Big moves** at the top of the Lines tab, and the board marks those games with a **Big move** tag. **Got it** marks one seen: it drops to the seen list and its tag goes quiet until the line moves another point. What's been seen is saved as `seen.json` in the private ledger repository, so it's the same on every connected device (a device that isn't connected keeps its own).

Setup: install the ntfy app, subscribe to your private topic name, and save that name as the repository secret `NTFY_TOPIC` (Settings → Secrets and variables → Actions). Without the secret, nothing is sent. The first run sends a "Line alerts are on" message (it links to the Big moves list), then an alert for each move already under way. What's been sent is kept in `state/line-alerts.json`, which isn't part of the published site. Anyone who knows the topic name can read the alerts or send to it, so keep it hard to guess.

## Market alerts

The same request also pulls lines you don't bet: Pinnacle, BetOnline, Kalshi, Polymarket, Novig, ProphetX, Betfair Exchange and Matchbook (`scripts/markets.json`; ten bookmakers in all still cost 3 credits). They stay off the board. Their current lines are in `site/data/markets.json` and show under **Line moves**; how their spreads and totals moved is kept in `state/market-history.json`. Betfair Exchange only has moneylines for college games, so it doesn't count toward spreads and totals.

`scripts/market-alerts.mjs` sends a second ntfy channel, your topic name plus `-markets`, after each refresh:

- **Stale line:** FanDuel or DraftKings is 1½ points or more better than the markets' consensus, the median of the markets that have the game (at least four, leaving out any far off the rest).
- **Market move:** that consensus moved more than 1 point in a day, 2 in two days, and so on up to a week. A book that hasn't followed goes in the same alert: "Market move: Georgia −11 → −13½ · FanDuel still −11½".

Each is its own alert, sent once. A stale line alerts again if the gap grows another point, or if it closes and opens again later; a market move if the consensus goes another point. Spreads and totals only. What's been sent is kept in `state/market-alerts.json`. The thresholds are `STALE_POINTS` and `MIN_MARKETS` at the top of the script.

## Edges

The **Edges** tab shows what has and hasn't worked this season, to find anything that helps you get past break-even (52.4% at −110).

- **Breaking even** and **your bets** are worked out in the browser from your private ledger, on connected devices only: the win rate your prices need against the one you've had, and your record, net and return by bet type, favorite or underdog, over or under, price, against the closing line, book and day.
- **Line moves**: betting the side a spread or total moved toward, at the number on the first refresh that showed a move of 1 to 4+ points within one, two or three days (when an alert would go off), plus open-to-close moves.
- **Against the close**: every game at its closing number: favorites and underdogs, home and road, spreads by size, overs and unders, and totals by wind and rain at kickoff.
- **Line shopping**: how often FanDuel and DraftKings closed on different numbers, and how many results the better number changed.

Everything is graded against final scores at the better of the two books' numbers for that side. Each row says whether its record could easily be luck (a coin flip would give it more than 1 time in 5), is worth watching, or is unlikely to be luck (under 1 time in 20).

`scripts/edges.mjs` builds `site/data/edges.json` after each refresh, only rewriting it when a number changes. It keeps two permanent records, since the site's line history drops games after ten days: `state/lines-archive.json` (every game's line history, rebuilt back to Oct 28 from the saved copies of `odds.json`) and `state/weather-archive.json` (each game's last forecast in the six hours before kickoff, back to Nov 17). Final scores come from `state/results.json`, which `.github/workflows/save-results.yml` fills from ESPN's free public scoreboard each morning (the last seven days), or for any dates you give it from the Actions tab.

## The ledger

Bets are saved in `bets.json` in the private repository `plerner16/cfb-bet-ledger`, one bet per line, so every connected device sees the same ledger and every change is in that repository's history. This repository (the site and the lines) stays public; it never holds your bets. A device that isn't connected sees the lines but not the ledger.

Each bet keeps when it was placed (`placedAt`, local time like `startTime`). Add to ledger stamps the current time; logging by hand defaults to now, and either can be changed later. The Ledger tab's **Early vs late** table groups settled bets by how long before kickoff they were placed (3+ days, 1–3 days, game day, after kickoff) and shows the record, net and return for each. Bets saved before placed times existed count from when they were logged, if that was before kickoff; the rest are left out of the table.

## Connecting a device

Seeing the ledger, saving bets and refreshing go through GitHub, so each device needs a GitHub token once. The site walks you through it: the token page opens with the name, a one-year expiration and the two permissions it needs (Actions and Contents, read and write) already filled in; you pick the `cfb-line-shop` and `cfb-bet-ledger` repositories and paste the token back. It's kept only in that browser. Any device can view the lines without one.

## The API key

The Odds API key lives in the repository secret `ODDS_API_KEY` (Settings → Secrets and variables → Actions). It's only used by the refresh job and never appears on the site. If a refresh fails (a bad key, out of credits), the site says so at the top of the page and keeps showing the last good lines.
