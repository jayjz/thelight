# BTC Short-Horizon Momentum V1

## Status

**Failed experiment. Do not activate BTC PAPER execution.** This is a
deterministic, long/flat, read-only research slice; it adds no BTC runtime
strategy, broker authority, intents, orders, reconciliation, or live-money path.

The machine artifact is
[`btc-short-horizon-v1-2026-09-24.json`](results/btc-short-horizon-v1-2026-09-24.json).
It records the source-bar hash, frozen configuration, decision digests, trades,
and metrics. Full decisions are reproducible from immutable input bars and their
digests rather than checked in redundantly.

## Frozen hypothesis and rules

Completed provider-backed BTC/USD 1-minute bars may occasionally contain upside
continuation that exceeds retail transaction friction. This is an engineering
hypothesis, **not calibrated alpha**: no constant was selected after inspecting
this result.

`btc_momentum_v1` uses only the current completed-bar prefix and is long/flat:

- Warm up on 21 consecutive minute bars.
- Enter only when the five-minute log return is at least 70 bp, exceeds
  `1.5 * realizedVol(20) * sqrt(5)`, EMA(8) exceeds EMA(21) by 3 bp, and the
  observed move clears a 60 bp round-trip hurdle. A crossover alone never trades.
- Exit on momentum/EMA invalidation after a two-minute minimum hold, on a
  trailing stop of `max(12 bp, 2 * realizedVol(20))`, or after 30 minutes.
- A decision after *t* fills at close *t+1* and begins earning only on
  *t+1 → t+2* (`NEXT_BAR_CLOSE/v1`).

Controls are `flat` and the sole baseline `btc_momentum_baseline_v1`: enter on
the same completed five-minute 60 bp hurdle, exit after five minutes or on
non-positive momentum. This is intentionally not a strategy zoo.

The conservative 60 bp hurdle uses Alpaca's published lowest-volume taker fee of
25 bp/side plus 2 bp/side spread and 3 bp/side slippage proxies. Fees, spread,
and slippage remain separate ledger fields, not executable quote observations.
See Alpaca's [fee schedule](https://docs.alpaca.markets/us/docs/crypto-fees) and
[paper-trading limitations](https://docs.alpaca.markets/us/v1.4.2/docs/paper-trading).

## Data, partitions and cost scenarios

- Source: only the durable store's current `VERIFIED` suffix; research neither
  fills, interpolates, nor repairs a gap.
- Period: 2026-09-24 00:15Z–20:55Z; 1,241 consecutive bars; SHA-256
  `d17b37a071693e70d6bc4213d92cd5a4d365c42425a223101d95c48e6815aa49`.
- Chronology: 868 development bars then 373 independently warmed-up validation
  bars. This same-day split is not a multi-regime OOS claim.
- Cost scenarios, per side: fees 25 bp; spread 2 bp; slippage 3 bp; combined
  30 bp (60 bp round trip).

## Results

| Strategy / scenario | Entries / round trips | Gross P&L | Net P&L | Turnover | Max DD |
| --- | ---: | ---: | ---: | ---: | ---: |
| flat / combined | 0 / 0 | 0.00% | 0.00% | 0 | 0.00% |
| baseline / fees | 2 / 2 | -0.29% | -1.28% | 4 | 1.28% |
| baseline / combined | 2 / 2 | -0.29% | -1.48% | 4 | 1.48% |
| `btc_momentum_v1` / fees | 1 / 1 | -0.29% | -0.79% | 2 | 0.79% |
| `btc_momentum_v1` / combined | 1 / 1 | -0.29% | -0.89% | 2 | 0.89% |

Candidate/combined: 1,221 decisions, one entry and round trip (1.16/day over
20.68 hours), two-minute median hold, 0% hit rate, 0 profit factor, 0.16%
exposure, 0.60% cost paid, two signal flips, and -0.446% log return per turnover
unit. Development generated zero entries; validation generated the sole losing
two-minute trade (-0.29% gross, -0.89% net).

High trade frequency is not useful trade frequency. The candidate did not meet
the intended multiple-trades-per-day operating hypothesis in this cost regime;
its only completed trade lost before costs. The positive evidence is limited to
the new causal, cost-aware evaluation path. The negative evidence is negative
gross P&L, cost-sensitivity failure, and an inadequate one-day sample.

## Research basis and limitations

Longer-horizon cryptocurrency momentum motivates testing, not one-minute retail
parameters: [Liu & Tsyvinski](https://www.nber.org/papers/w24877) and
[Liu, Tsyvinski & Wu](https://onlinelibrary.wiley.com/doi/full/10.1111/jofi.13119).
At shorter horizons, fragmentation and microstructure matter:
[Makarov & Schoar](https://dspace.mit.edu/entities/publication/7f91bfb5-ba77-4d0e-9c79-ec75e104e6cc),
[Albers et al.](https://arxiv.org/abs/2108.09750), and
[Aït-Sahalia & Yu](https://arxiv.org/abs/0906.1444) motivate explicit costs and a
noise gate. No parameter sweep was run, consistent with Bailey et al. on
[backtest overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).
MoonDev was considered only for hypothesis workflow ideas; its Arena explicitly
separates prediction from trading/execution/risk, and claimed returns were not
evidence. [MoonDev Arena](https://moondev.com/arena/docs).

PAPER activation is unsupported. Blockers are broader verified history across
regimes, a predeclared untouched OOS interval, quote/order-book or realized-fill
evidence, BTC execution-timing parity, and the required 24/7 observation soak.
Any successor needs a new strategy ID and prospective frozen contract.
