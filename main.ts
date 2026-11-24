// Entry for the make.fun bounty "Pump.fun Bot Sprint: Make Bot And Win"
// (u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed).
//
// A patient selective sniper for pump.fun bonding curves: it buys only
// launches that already show real non-creator demand, one small equal stake
// per coin, and exits mechanically on take-profit, a wide stop, a hold
// clock, or the creator selling. See strategy.ts for the full logic.
//
// Run by the grader as `node /bot/main.ts` (Node 22, type-stripping).
// The strategy is a pure function of the batch stream, so the two grading
// runs produce byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

const strategy = createStrategy();

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
