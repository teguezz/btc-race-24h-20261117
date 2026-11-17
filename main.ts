// Patient capital-preservation BTC bot (agent-fun/bars-replay/v1).
//
// Philosophy: cash is the default state. The bot only risks money when a
// setup with a proven shape appears, it risks a fixed fraction of equity
// when it does, and every position carries its exit plan from the moment
// it opens. A flat 0.00 finish is an acceptable outcome; a losing finish
// is not chased.
//
// Two long-only engines share the single position slot:
//
// 1) Confirmed climb. When the two-hour mean is rising, price holds above
//    it, two-hour momentum is positive and the bar closes at a one-hour
//    high, the bot buys 85% of equity. The position is protected by a
//    2.2% hard stop, a trailing stop that arms after +0.8% and follows
//    0.6% behind the best close, a +3.5% take-profit, a regime exit when
//    price closes 0.4% under the mean, and a 900-bar maximum hold. No
//    climb entry is taken after bar 1150: a trend thesis needs room to
//    play out before the window ends.
//
// 2) Capitulation dip. After price has fallen at least 1.9% from its
//    trailing six-hour high, the first up bar that closes above the best
//    close of the prior ten bars is bought with 80% of equity, once per
//    episode (an episode ends when price recovers to within 0.6% of the
//    high). The stop sits 0.2% under the thirty-bar swing low; exits are
//    a +2.8% target, a trailing stop (arms +1.4%, trails 0.9%), a 75-bar
//    time stop demanding at least +0.4%, and a 360-bar maximum hold. No
//    dip entry after bar 1250.
//
// Account-level brakes, checked before any strategy logic:
// - Full context first: no entry of either engine before bar 360, so
//   every lookback window (including the six-hour trailing high) is
//   fully populated before money is risked.
// - Kill switch: if marked equity ever falls to 98.5% of the 1,000 USDC
//   start, any open position is sold and no new entry is taken for the
//   rest of the window.
// - At most 3 entries per window; a 60-bar pause follows every exit and
//   a 120-bar pause follows a losing exit; 90 bars after a climb exit.
// - No entries at all in the final 13 bars.
//
// Everything is a deterministic function of the hello, the batches and
// the fills: rolling sums and sliding-window extremes keep each bar O(1)
// amortised, and nothing reads a clock, the environment or a random
// source, so the two grading executions agree byte for byte.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const PRICE_SCALE = 100000; // 10^5, from this competition's hello
const MICRO = 1000000; // quote units per USDC
const START_USDC = 1000;
const TOTAL_BARS = 1440;

const BUY_CAP_BPS = 150; // entries: refuse a fill far above the decision close
const SELL_CAP_BPS = 400; // exits: getting out matters more than the last bps

// Account-level brakes.
const FIRST_ENTRY_BAR = 360; // full lookback context before any entry
const KILL_EQUITY = START_USDC * 0.985; // kill switch level, USDC
const MAX_ENTRIES = 3;
const PAUSE_AFTER_EXIT = 60; // bars
const PAUSE_AFTER_LOSS = 120; // bars
const LAST_ENTRY_BAR = TOTAL_BARS - 14; // no entries from here on

// Confirmed-climb parameters.
const C_MEAN_W = 120; // regime mean lookback (bars)
const C_SLOPE_LAG = 45; // the mean must be rising versus this many bars ago
const C_ROC_W = 120; // momentum lookback
const C_ROC_MIN = 0.004; // required momentum
const C_BREAK_W = 60; // breakout lookback (prior closes, current excluded)
const C_FRAC = 0.85; // fraction of equity bought
const C_STOP = 0.022; // hard stop
const C_TARGET = 0.035; // take-profit
const C_TRAIL_ARM = 0.008; // trailing stop arms at this gain
const C_TRAIL_PCT = 0.006; // trailing stop distance from the peak close
const C_REGIME_BUF = 0.004; // regime exit buffer below the mean
const C_MAX_HOLD = 900; // bars
const C_COOLDOWN = 90; // bars after a climb exit
const C_LATE = 1150; // no climb entries after this bar

// Capitulation-dip parameters.
const D_HI_W = 360; // trailing-high lookback (bars)
const D_DD = 0.019; // required drawdown from that high
const D_RESET = 0.006; // episode ends this close to the high
const D_TRIG_W = 10; // breakout lookback for the reversal trigger
const D_FRAC = 0.8; // fraction of equity bought
const D_SWING_W = 30; // swing-low lookback for the structure stop
const D_STOP_BUF = 0.002; // stop sits this far below the swing low
const D_TARGET = 0.028; // take-profit
const D_TRAIL_ARM = 0.014; // trailing stop arms at this gain
const D_TRAIL_PCT = 0.009; // trailing stop distance from the peak close
const D_TIME_BARS = 75; // time stop horizon
const D_TIME_GAIN = 0.004; // required gain by then
const D_MAX_HOLD = 360; // bars
const D_LATE = 1250; // no dip entries after this bar

// Sliding-window extreme (maximum or minimum) over the last `width`
// values pushed, keyed by bar index; a monotonic deque keeps it O(1)
// amortised. Whether the current bar is included is the caller's choice:
// entry triggers read their window before pushing the current bar, the
// trailing high and the swing low read theirs after.
class SlidingExtreme {
  private idx: number[] = [];
  private val: number[] = [];
  private head = 0;
  private readonly wantMax: boolean;
  private readonly width: number;
  constructor(wantMax: boolean, width: number) {
    this.wantMax = wantMax;
    this.width = width;
  }
  push(i: number, v: number): void {
    while (this.val.length > this.head) {
      const back = this.val[this.val.length - 1];
      if (this.wantMax ? back <= v : back >= v) {
        this.idx.pop();
        this.val.pop();
      } else break;
    }
    this.idx.push(i);
    this.val.push(v);
    while (this.idx[this.head] <= i - this.width) this.head++;
    if (this.head > 512) {
      this.idx = this.idx.slice(this.head);
      this.val = this.val.slice(this.head);
      this.head = 0;
    }
  }
  get(): number {
    return this.val[this.head];
  }
}

interface OpenTrade {
  kind: 'climb' | 'dip';
  fillPrice: number; // dollars per BTC, from the buy fill
  fillBar: number; // bar index whose open filled the buy
  stopPrice: number; // dip only: absolute structure stop
  peakClose: number;
  buyFeeUsdc: number;
}

// Bar history in arrival order; index i is the i-th bar of the window.
const closePx: number[] = [];
const openPx: number[] = [];
const meanHist: number[] = []; // mean of the last C_MEAN_W closes, NaN until defined
let meanSum = 0;
const trailHigh = new SlidingExtreme(true, D_HI_W); // includes the current bar
const swingLow = new SlidingExtreme(false, D_SWING_W); // includes the current bar
const trigHigh = new SlidingExtreme(true, D_TRIG_W); // excludes the current bar
const breakHigh = new SlidingExtreme(true, C_BREAK_W); // excludes the current bar

// Strategy state.
let trade: OpenTrade | null = null;
let awaiting: { kind: 'climb' | 'dip'; stopPrice: number; sentBar: number } | null = null;
let awaitingFillPrice = 0;
let awaitingFeeUsdc = 0;
let dipEpisodeSpent = false;
let entriesUsed = 0;
let pauseUntil = -1; // no entries while bar index <= this
let killed = false;

function sizedBuy(state: BarsState, frac: number): OrderInput | null {
  let notional = BigInt(Math.floor(frac * Number(state.equity)));
  const room = state.weightRoom(SYMBOL);
  if (room < notional) notional = room;
  if (state.cash < notional) notional = state.cash;
  if (notional < BigInt(MICRO)) return null; // below the 1 USDC minimum
  return {
    side: 'buy',
    symbol: SYMBOL,
    notional_quote_units: notional,
    max_slippage_bps: BUY_CAP_BPS,
  };
}

// Decide on the bar just appended (index i). trigPeak and breakPeak are
// the exclusion-window extremes captured before this bar was pushed.
function decide(
  state: BarsState,
  barIndex: number,
  trigPeak: number,
  breakPeak: number,
): OrderInput[] {
  const close = closePx[barIndex];
  const pos = state.positions.get(SYMBOL);
  const holding = pos !== undefined && pos.qty > 0n;
  const equityUsdc = Number(state.equity) / MICRO;

  // A buy decided earlier has filled: adopt the position as a trade.
  if (holding && trade === null && pos !== undefined) {
    let price = awaitingFillPrice;
    if (!(price > 0)) price = (Number(pos.cost) * 100) / Number(pos.qty);
    if (!(price > 0)) price = close;
    trade = {
      kind: awaiting?.kind ?? 'climb',
      fillPrice: price,
      fillBar: barIndex,
      stopPrice: awaiting?.stopPrice ?? 0,
      peakClose: close,
      buyFeeUsdc: awaitingFeeUsdc,
    };
    entriesUsed++;
    awaiting = null;
    awaitingFillPrice = 0;
    awaitingFeeUsdc = 0;
  }
  // The position is gone: the exit filled on this bar's open. Book the
  // pauses from the realised result, estimated from the exit fill.
  if (!holding && trade !== null) {
    trade = null;
  }
  // A buy that never filled (rejected) is forgotten once its fill bar
  // has passed without a position appearing.
  if (!holding && awaiting !== null && barIndex > awaiting.sentBar) {
    awaiting = null;
    awaitingFillPrice = 0;
    awaitingFeeUsdc = 0;
  }

  // Kill switch first: it overrides every strategy rule.
  if (equityUsdc <= KILL_EQUITY) {
    killed = true;
    if (holding && pos !== undefined) {
      return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: SELL_CAP_BPS }];
    }
    return [];
  }
  if (killed) return [];

  if (holding && trade !== null && pos !== undefined) {
    if (close > trade.peakClose) trade.peakClose = close;
    const held = barIndex - trade.fillBar;
    const gain = close / trade.fillPrice - 1;
    let exit = false;
    if (trade.kind === 'dip') {
      if (close <= trade.stopPrice) exit = true;
      else if (gain >= D_TARGET) exit = true;
      else if (
        trade.peakClose >= trade.fillPrice * (1 + D_TRAIL_ARM) &&
        close <= trade.peakClose * (1 - D_TRAIL_PCT)
      )
        exit = true;
      else if (held >= D_TIME_BARS && gain < D_TIME_GAIN) exit = true;
      else if (held >= D_MAX_HOLD) exit = true;
    } else {
      if (gain <= -C_STOP) exit = true;
      else if (gain >= C_TARGET) exit = true;
      else if (
        trade.peakClose >= trade.fillPrice * (1 + C_TRAIL_ARM) &&
        close <= trade.peakClose * (1 - C_TRAIL_PCT)
      )
        exit = true;
      else if (
        barIndex >= C_MEAN_W - 1 &&
        close < meanHist[barIndex] * (1 - C_REGIME_BUF)
      )
        exit = true;
      else if (held >= C_MAX_HOLD) exit = true;
    }
    if (exit) {
      return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: SELL_CAP_BPS }];
    }
    return [];
  }

  // Flat. No entries during warm-up, before the full-context bar, after
  // the entry curfew, while a buy is still awaiting its fill, or once
  // the entry budget is spent.
  if (state.warmingUp || awaiting !== null) return [];
  if (barIndex < FIRST_ENTRY_BAR || barIndex > LAST_ENTRY_BAR) return [];
  if (entriesUsed >= MAX_ENTRIES || barIndex <= pauseUntil) return [];

  // --- Capitulation dip ---
  if (barIndex >= D_HI_W) {
    const dd = close / trailHigh.get() - 1;
    if (dd >= -D_RESET) dipEpisodeSpent = false;
    if (
      !dipEpisodeSpent &&
      barIndex <= D_LATE &&
      dd <= -D_DD &&
      close > trigPeak &&
      close > openPx[barIndex]
    ) {
      dipEpisodeSpent = true;
      awaiting = {
        kind: 'dip',
        stopPrice: swingLow.get() * (1 - D_STOP_BUF),
        sentBar: barIndex,
      };
      const order = sizedBuy(state, D_FRAC);
      if (order === null) awaiting = null;
      return order === null ? [] : [order];
    }
  }

  // --- Confirmed climb ---
  if (barIndex >= C_MEAN_W + C_SLOPE_LAG && barIndex <= C_LATE) {
    const mean = meanHist[barIndex];
    const meanPrev = meanHist[barIndex - C_SLOPE_LAG];
    const roc = close / closePx[barIndex - C_ROC_W] - 1;
    if (close > mean && mean > meanPrev && roc >= C_ROC_MIN && close > breakPeak) {
      awaiting = { kind: 'climb', stopPrice: 0, sentBar: barIndex };
      const order = sizedBuy(state, C_FRAC);
      if (order === null) awaiting = null;
      return order === null ? [] : [order];
    }
  }

  return [];
}

// When an exit fill lands, work out whether the trade made money and set
// the pauses. Called with each batch's fills before its bars are read.
function bookExitFills(batch: Batch): void {
  for (const f of batch.fills) {
    if (f.symbol !== SYMBOL || f.status !== 'filled') continue;
    if (f.side === 'buy') {
      awaitingFillPrice = Number(BigInt(f.price)) / PRICE_SCALE;
      awaitingFeeUsdc = Number(BigInt(f.fee_quote_units)) / MICRO;
    } else if (trade !== null) {
      const exitPrice = Number(BigInt(f.price)) / PRICE_SCALE;
      const qtyBtc = Number(BigInt(f.qty)) / 100000000;
      const sellFeeUsdc = Number(BigInt(f.fee_quote_units)) / MICRO;
      const realised = (exitPrice - trade.fillPrice) * qtyBtc - trade.buyFeeUsdc - sellFeeUsdc;
      const exitBar = closePx.length - 1 + 1; // the bar whose open filled this sell
      pauseUntil = Math.max(pauseUntil, exitBar + PAUSE_AFTER_EXIT);
      if (realised < 0) pauseUntil = Math.max(pauseUntil, exitBar + PAUSE_AFTER_LOSS);
      if (trade.kind === 'climb') pauseUntil = Math.max(pauseUntil, exitBar + C_COOLDOWN);
    }
  }
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    bookExitFills(batch);
    let acted: OrderInput[] = [];
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      const c = Number(BigInt(bar.c)) / PRICE_SCALE;
      const o = Number(BigInt(bar.o)) / PRICE_SCALE;
      const l = Number(BigInt(bar.l)) / PRICE_SCALE;
      // Exclusion windows are read before the current bar is pushed.
      const trigPeak = trigHigh.get();
      const breakPeak = breakHigh.get();
      openPx.push(o);
      closePx.push(c);
      const i = closePx.length - 1;
      meanSum += c;
      if (i >= C_MEAN_W) meanSum -= closePx[i - C_MEAN_W];
      meanHist.push(i >= C_MEAN_W - 1 ? meanSum / C_MEAN_W : NaN);
      trailHigh.push(i, c);
      swingLow.push(i, l);
      acted = decide(state, i, trigPeak, breakPeak);
      trigHigh.push(i, c);
      breakHigh.push(i, c);
    }
    return acted;
  },
});
