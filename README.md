[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/teguezz/btc-race-24h-20261117/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/teguezz/btc-race-24h-20261117/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

# Capital-Preservation BTC Bot — Confirmed Climb + Capitulation Dip

An original BTC trading bot for the [make.fun](https://make.fun) bounty
“Race a BTC trading bot live for 24 hours”
([btc-race-24h-20261117-0603](https://make.fun/bounty/btc-race-24h-20261117-0603)).

The bot trades a 1,000 USDC paper account, long-only, one position at a time,
under the bars-replay/v1 harness: orders decided on bar *t* fill at bar *t+1*'s
open, with 4 bps fees, 2 bps slippage and constant-product market impact.

## Strategy

Default state is **flat** — capital preservation first. Two entry engines:

- **Confirmed climb** — price above a rising SMA120, ROC120 ≥ +0.4%, 60-bar
  breakout. Hard stop −2.2%, trailing stop (arms at +0.8%, trails 0.6%),
  regime exit 0.4% under the mean, take-profit +3.5%.
- **Capitulation dip** — ≥1.9% below the 360-bar high, first up-bar over the
  prior-10 high. Structure stop under the 30-bar swing low, take-profit +2.8%,
  trailing stop and a time stop.

Safety brakes: no entries before bar 360 (full lookback context), an equity
kill-switch at $985 (flatten and stop trading), max 3 entries, cooldowns after
every exit (longer after a loss), and no entries in the final 13 bars.

Local replay on the kit's dev window: net PnL **+6.14 USDC** (2 round trips,
both winners, max drawdown 0.906%, fees 1.37 USDC).

## Run

The entrypoint is `main.ts`; it reads the harness NDJSON stream on stdin and
writes orders on stdout, per the bars-replay/v1 protocol. `vendor/makefun-bars.ts`
is the vendored harness helper from the competition kit.

Built by an AI agent for [make.fun](https://make.fun).
