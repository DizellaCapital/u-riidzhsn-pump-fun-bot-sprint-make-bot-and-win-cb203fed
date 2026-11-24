// Patient selective sniper for pump.fun bonding curves (agent-fun/replay/v2).
//
// Idea: most new coins bleed out, and every trade pays ~125 bps of curve fees
// plus a flat tx fee, so the only way to stay near break-even is to trade
// rarely, small, and only into launches that already show real demand.
// One equal stake per coin, never an add. Exits are mechanical: a take-profit,
// a wide stop (narrow stops mostly fire on noise), a hold clock, or the
// creator selling — whichever comes first.
//
// Guardrail pacing: the contest needs a round trip of at least 0.01 SOL on at
// least 20 coins inside a 6-hour window. The bot tracks its own coin pace
// against a 30-coin / 6h target and, when it lags, opens tiny 0.01 SOL probe
// round trips on the next plausible launch so the minimum bar is met even on
// a quiet stretch.
//
// Fully deterministic: every decision is a pure function of the batch stream
// (no clock, no environment, no randomness), so the two grading runs produce
// byte-identical action logs.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;

// --- tuned constants -------------------------------------------------------

/** SOL spent on one normal entry (curve fees included). */
const STAKE_LAMPORTS = 40_000_000n; // 0.04 SOL
/** SOL spent on one pacing probe round trip. */
const PROBE_LAMPORTS = 10_000_000n; // 0.01 SOL, the guardrail minimum
/** Entry window: slots after the CreateEvent in which a buy may fire. */
const ENTRY_AGE_MIN = 2;
const ENTRY_AGE_MAX = 3;
/** Entry filter: distinct non-creator buyers seen so far. */
const MIN_BUYERS = 3;
/** Entry filter: SOL bought by non-creators so far (lamports). */
const MIN_NON_CREATOR_BOUGHT = 2_000_000_000n; // 2.0 SOL
/** Entry filter: the creator's own buys must stay at or below this. */
const MAX_CREATOR_BUY = 1_000_000_000n; // 1.0 SOL
/** Entry filter: real SOL reserve must sit inside this band. */
const MIN_REAL_SOL = 200_000_000n; // 0.2 SOL
const MAX_REAL_SOL = 20_000_000_000n; // 20 SOL
/** Exit: sell everything at +18% / -20% vs cost, or after this many slots. */
const TAKE_PROFIT_NUM = 118n;
const STOP_LOSS_NUM = 80n;
const PCT_DEN = 100n;
const MAX_HOLD_SLOTS = 36;
/** Looser entry filter used only for pacing probes. */
const PROBE_MIN_BUYERS = 2;
const PROBE_MIN_NON_CREATOR_BOUGHT = 500_000_000n; // 0.5 SOL
/** Pacing target: this many coins per this many slots (~6h at 0.4s/slot). */
const PACE_TARGET_COINS = 30;
const PACE_TARGET_SLOTS = 54000;
/** Start probing once the bot trails its pace target by this many coins. */
const PACE_LAG_TRIGGER = 2;
/** Slippage guard on every order (bps). Wide enough that a 2-slot latency
 *  move rarely rejects the fill, tight enough to bound a bad print. */
const SLIPPAGE_BPS = 1000;

interface CoinWatch {
  mint: string;
  creator: string;
  createdSlot: number;
  /** Distinct non-creator buyers seen. */
  buyers: Set<string>;
  /** Lamports bought by non-creators. */
  nonCreatorBought: bigint;
  /** Lamports bought by the creator. */
  creatorBought: bigint;
  /** The creator sold at least once. */
  creatorSold: boolean;
  /** A normal buy was placed for this coin. */
  bought: boolean;
  /** A probe buy was placed for this coin. */
  probed: boolean;
  /** Slot the normal buy was decided on (for the hold clock). */
  buySlot: number;
  /** This position is a probe: sell it as soon as the fill lands. */
  probePosition: boolean;
}

export interface StrategyStats {
  coinsBought: number;
  probesBought: number;
}

export function createStrategy() {
  const watched = new Map<string, CoinWatch>();
  let firstSlot = -1;
  let coinsBought = 0;
  let probesBought = 0;

  function watchFor(mint: string, slot: number): CoinWatch {
    let w = watched.get(mint);
    if (w === undefined) {
      w = {
        mint,
        creator: '',
        createdSlot: slot,
        buyers: new Set<string>(),
        nonCreatorBought: 0n,
        creatorBought: 0n,
        creatorSold: false,
        bought: false,
        probed: false,
        buySlot: -1,
        probePosition: false,
      };
      watched.set(mint, w);
    }
    return w;
  }

  /** Price of one token in lamports, fixed-point scaled by 1e9. */
  function priceScaled(curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): bigint | null {
    if (curve.virtual_token_reserves <= 0n) return null;
    return (curve.virtual_quote_reserves * 1_000_000_000n) / curve.virtual_token_reserves;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    if (firstSlot < 0) firstSlot = batch.slot;
    const orders: OrderInput[] = [];

    // --- fold this batch's events into the per-coin watch -----------------
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const w = watchFor(e.mint, e.slot);
        w.creator = e.creator;
        w.createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const w = watchFor(e.mint, e.slot);
        if (w.creator === '') w.creator = e.creator;
        const amount = BigInt(e.sol_amount);
        if (e.is_buy) {
          if (e.user === w.creator) {
            w.creatorBought += amount;
          } else {
            w.buyers.add(e.user);
            w.nonCreatorBought += amount;
          }
        } else if (e.user === w.creator) {
          w.creatorSold = true;
        }
      } else {
        // CompleteEvent: the curve is done; forget the watch so it can never
        // be entered again (the shim already refuses orders on it).
        watched.delete(e.mint);
      }
    }

    // --- exits: sell held positions that hit TP / SL / clock / creator sell
    for (const [mint, holding] of state.positions) {
      const w = watched.get(mint);
      const curve = state.curves.get(mint);
      // Probe positions are flipped the moment the fill lands.
      if (w !== undefined && w.probePosition) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        w.probePosition = false;
        continue;
      }
      if (w !== undefined && w.creatorSold) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        continue;
      }
      if (curve === undefined) continue;
      const price = priceScaled(curve);
      if (price === null) continue;
      // Current value vs cost, in fixed point: value = tokens * price / 1e9.
      const value = (holding.token_amount * price) / 1_000_000_000n;
      const cost = holding.cost_lamports;
      if (cost <= 0n) continue;
      const hitTp = value * PCT_DEN >= cost * TAKE_PROFIT_NUM;
      const hitSl = value * PCT_DEN <= cost * STOP_LOSS_NUM;
      const agedOut = w !== undefined && w.buySlot >= 0 && batch.slot - w.buySlot >= MAX_HOLD_SLOTS;
      if (hitTp || hitSl || agedOut) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
      }
    }

    // --- entries: coins inside the age window that pass the filter --------
    const openSlots =
      state.hello.caps.max_open_positions - state.committedPositionCount();
    if (openSlots > 0) {
      let buysPlaced = 0;
      const elapsed = batch.slot - firstSlot;
      const expectedCoins =
        elapsed > 0 ? Math.floor((PACE_TARGET_COINS * elapsed) / PACE_TARGET_SLOTS) : 0;
      const behindPace = coinsBought + probesBought + PACE_LAG_TRIGGER <= expectedCoins;

      for (const w of watched.values()) {
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (w.bought || w.probed) continue;
        if (w.creatorSold) continue;
        const age = batch.slot - w.createdSlot;
        if (age < ENTRY_AGE_MIN || age > ENTRY_AGE_MAX) continue;
        const curve = state.curves.get(w.mint);
        if (curve === undefined || curve.complete) continue;
        const realSol = curve.real_quote_reserves;
        if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;

        const strong =
          w.buyers.size >= MIN_BUYERS &&
          w.nonCreatorBought >= MIN_NON_CREATOR_BOUGHT &&
          w.creatorBought <= MAX_CREATOR_BUY;
        const probeOk =
          behindPace &&
          w.buyers.size >= PROBE_MIN_BUYERS &&
          w.nonCreatorBought >= PROBE_MIN_NON_CREATOR_BOUGHT &&
          w.creatorBought <= MAX_CREATOR_BUY;

        if (strong) {
          const cap = state.maxBuyLamports(w.mint);
          const size = STAKE_LAMPORTS < cap ? STAKE_LAMPORTS : cap;
          if (size < PROBE_LAMPORTS) continue; // below the guardrail minimum
          if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
          orders.push({
            side: 'buy',
            mint: w.mint,
            quote_lamports: size.toString(),
            max_slippage_bps: SLIPPAGE_BPS,
          });
          w.bought = true;
          w.buySlot = batch.slot;
          coinsBought += 1;
          buysPlaced += 1;
        } else if (probeOk) {
          const cap = state.maxBuyLamports(w.mint);
          const size = PROBE_LAMPORTS < cap ? PROBE_LAMPORTS : cap;
          if (size < PROBE_LAMPORTS) continue;
          if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
          orders.push({
            side: 'buy',
            mint: w.mint,
            quote_lamports: size.toString(),
            max_slippage_bps: SLIPPAGE_BPS,
          });
          w.probed = true;
          w.buySlot = batch.slot;
          w.probePosition = true;
          probesBought += 1;
          buysPlaced += 1;
        }
        if (state.committedPositionCount() + buysPlaced >= state.hello.caps.max_open_positions) break;
      }
    }

    // --- remember probe fills: a probe position flips to "sell now" -------
    // (handled at the top of the next batch via w.probePosition, which was
    // set when the probe buy was placed.)

    return orders;
  }

  function stats(): StrategyStats {
    return { coinsBought, probesBought };
  }

  return { onBatch, stats };
}
