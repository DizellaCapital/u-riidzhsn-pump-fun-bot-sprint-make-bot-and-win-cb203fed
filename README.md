# Pump.fun Bot Sprint: Make Bot And Win

[![Make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/DizellaCapital/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/DizellaCapital/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Entry for the make.fun bounty
`u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed` — a paper-trading bot
that runs on a 6-hour replay of real pump.fun chain data. Best paper net PnL
wins; top 2 places pay $1 each.

## Strategy: patient selective sniper

Most new coins bleed out, and every trade pays curve fees plus a flat tx fee,
so this bot trades rarely, small, and only into launches that already show
real demand. The design follows what the leaderboard of the sibling pump.fun
sprint taught: selective entries beat fast-cycle trading (a fast-cycle equal
sniper lost -0.358 SOL on the same dev window; a patient selective sniper lost
only -0.053 SOL).

- **Entry (age 2–3 slots after create):** at least 3 distinct non-creator
  buyers, at least 2.0 SOL bought by non-creators, creator's own buy ≤ 1 SOL,
  creator has not sold, real SOL 0.2–20. One buy per coin, never an add.
- **Stake:** 0.04 SOL per coin, clamped to the 1%-of-real-reserve order cap
  and skipped when the clamp would fall below the 0.01 SOL guardrail minimum.
- **Exit (sell all):** +18% take-profit, −20% stop-loss (wide — a narrow stop
  mostly fires on noise), max hold 36 slots, or immediately when the creator
  sells. No runner, no partial take-profit, no trailing stop.
- **Guardrail pacing:** the bot tracks its own pace against a 30-coin / 6-hour
  target; when it lags by more than 2 coins, it opens tiny 0.01 SOL probe
  round trips (flipped the moment the fill lands) so the 20-coin minimum bar
  is met even on a quiet stretch.

Fully deterministic: every decision is a pure function of the batch stream
(no clock, no environment, no randomness), so the two grading runs produce
byte-identical action logs.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts` (Node 22,
  type-stripping).
- `strategy.ts` — the trading logic.
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim (byte-identical
  copy of the kit's `sdk/ts/makefun-bot.ts`), zero dependencies.

## Local grading

From the bounty kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## Bounty

- Slug: `u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed`
- Pot: $2, top 2 (#1 $1, #2 $1). Deadline: 2026-11-28T08:00:00Z.
- Scoring: net PnL on 6 hours of pump.fun chain data collected after entries
  close; a prize needs net PnL above holding cash (above 0 SOL after every fee).

## License

MIT — see `LICENSE`.
