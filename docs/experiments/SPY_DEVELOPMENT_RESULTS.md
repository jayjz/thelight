# September 22–23 SPY development evidence

These sessions were examined before V2 was frozen. They are diagnostic evidence,
not holdout, parameter calibration or a profitability claim. Full exports are
checked in as gzip JSON fixtures; the reproduction command recalculates all
decision rows, distributions, trade associations and execution ledgers.

## Implementation identity

Fetched origin/main was cd3236f1b28d9c32783c0bc1e735dcfaf395ec43. The V1 Git blob
is 091f2e4d136d76c75310bb722e38275c13f55e4a on that main and on both supplied BTC
refs. The September 23 operational main-run premise therefore identifies the
same V1 source. The durable records independently reproduce its decisions but
do not contain a live Git revision attestation. V1 source is unchanged and a
regression test pins its blob hash.

## Actual PAPER evidence

| Metric | September 22 | September 23 |
|---|---:|---:|
| Captured decisions | 390 | 365 |
| Signal + risk target parity | PASS (0 mismatches) | PASS (0 mismatches) |
| Priced fills / observed transitions | 36 / 36 | 28 / 28 |
| Completed round trips | 18 | 14 |
| Winners / losers | 4 / 14 | 3 / 11 |
| Realized complete-trip P&L before fees ($) | -1.33 | -2.71 |
| Gross winners / gross losses ($) | 1.59 / 2.92 | 0.81 / 3.52 |
| Profit factor | 0.545 | 0.230 |
| Fill notional ($) | 27853.45 | 21513.83 |
| Mean / median hold (minutes) | 8.831 / 4.004 | 7.860 / 4.015 |
| Complete-trip time in market (minutes) | 158.950 | 110.039 |
| Median entry EMA spread (bps) | 0.204 | 0.186 |
| Median fill delay after completed minute (seconds) | 2.436 | 2.717 |

The earlier September 22 report (31 fills, 15 trips, about -$1.36) does not match
the full-day total in this export. Its exact earlier cutoff was not provided,
so the difference cannot be reconciled to a specific interval. September 23's reported
22 transitions / 11 trips was a lower bound over a narrower afternoon interval;
the full captured run has 28 / 14. Its -$2.71 fill-derived P&L agrees with the
user-provided ~$4,998.67 to ~$4,995.96 equity change. Those absolute equity
values are external context, not reconstructed database fields. Notional divided
by those external starting values is approximately 5.57x and 4.30x respectively
(using $5,000 for September 22); the machine report leaves account turnover null.

## Churn diagnosis

V1 requires only the sign of EMA separation, with no strength or persistence
threshold. Its exit fires on any negative crossing or RSI below 45. Additionally,
the live 23-bar sliding window re-seeds the slow EMA every minute, so removing
the oldest close can move crossover state. That is audited implementation
behavior, not evidence that reseeding alone caused a given loss.

Under the prospectively declared 0.5 strength diagnostic, September 22 has
15/18 weak entries, 12 losses among them and -$1.08 P&L. Its three stronger
entries also lose in aggregate (-$0.25, two losses). September 23 has 14/14 weak
entries, 11 losses and -$2.71. Thus weak entries dominate turnover, but the small
sample and absence of strong September 23 entries do not establish a causal
strength/return relationship. Median holds are about four minutes; both sessions
include roughly one-minute round trips. Full entry/exit RSI, spread, hold, return,
flip-interval and hourly-transition distributions are in the generated reports.

## Timing boundary

Actual fills occur roughly 1.8–4.0 seconds after the source minute completes.
NEXT_BAR_CLOSE/v1 instead waits until the following minute completes, around
60 seconds after source completion. Signal parity passes; execution and P&L
parity are **not claimed**. Counterfactual returns below use the existing
unit-exposure log-equity ledger, not PAPER's one-share cash P&L.

## Frozen counterfactual

| Session / strategy | Entries | Transitions / unit turnover | Weak entries | Exposure | Mean / median hold min | Gross return bps | Max drawdown bps (zero costs) |
|---|---:|---:|---:|---:|---:|---:|---:|
| Sep 22 / ema_rsi_v1 | 18 | 36 / 36 | 15 | 40.87% | 8.83 / 4 | -10.98 | 17.49 |
| Sep 22 / ema_rsi_v2 | 8 | 16 / 16 | 0 | 26.99% | 13.13 / 11 | -1.88 | 14.02 |
| Sep 23 / ema_rsi_v1 | 14 | 28 / 28 | 14 | 30.22% | 7.86 / 4 | -45.95 | 45.95 |
| Sep 23 / ema_rsi_v2 | 5 | 10 / 10 | 0 | 15.11% | 11.00 / 12 | -22.62 | 24.64 |

Transitions fall 55.6% and 64.3%, respectively; weak entries fall to zero by
construction. This demonstrates the intended turnover mechanism in development
data, not validated advantage. No constants were changed after this comparison.
V2 still has short holds and losing trades; no minimum hold forces persistence.

| Fees / slippage bps per unit turnover | Sep 22 V1 net bps | Sep 22 V2 net bps | Sep 23 V1 net bps | Sep 23 V2 net bps |
|---|---:|---:|---:|---:|
| 0 / 0 | -10.98 | -1.88 | -45.95 | -22.62 |
| 0 / 1 | -46.88 | -17.87 | -73.78 | -32.59 |
| 0 / 5 | -189.18 | -81.55 | -184.33 | -72.38 |
| 1 / 5 | -224.43 | -97.41 | -211.78 | -82.31 |

Costs are fixed sensitivity assumptions, not empirical IEX spreads and not a
parameter-selection objective. Gross and all net cases remain reported.

## Evidence identity

September 22:

- Run: `737e2720-bbc3-41ca-85b3-027cba546cb0`
- Evidence SHA-256: `52b12a7ee0a97eb9ab1f45f4d3be1b91b32e054be38493fc4f5ea1d9b4ed03bf`
- Bars SHA-256: `50a206e9b78d12f166aa5fedaf4f3acd2d3eb74fda96b73a2f4adc23ec8da417`

September 23:

- Run: `d68e667a-d793-4387-9cd5-f0ddecffd15e`
- Evidence SHA-256: `cb49fff5b74737912338ea1f1f7f5dd1eb3ee98be766e9297ee1d6d99c52e50e`
- Bars SHA-256: `41dee07ed36e949729457dc6c534d3917d71fd98f382534435d9e3752c54523f`

## Next session and holdout

Run unchanged V1 PAPER through the existing operator-controlled worker. Preserve
all evidence, then export with explicit run identity and hashes. V2 remains
offline shadow-only. Neither development date is a holdout. The next ten complete,
previously uninspected sessions after the experiment-spec commit form the frozen
validation cohort; no daily retuning. See [success/failure rules](EMA_RSI_V2.md).

## Validation

Focused deterministic research tests, typecheck, lint, full lightlight tests,
PAPER ownership integration and build were run. Lint has four inherited warnings
and no errors. Ownership testing used a disposable isolated schema; no session
evidence was mutated and no PAPER order was submitted. Build ran without
DATABASE_URL so the deployment migration hook skipped database writes.

Astra's first review found Date hashing, millisecond parsing and one missing
V2 warmup-history bar for interval exports. All were fixed with regression tests.
A follow-up Astra review identified ordering loss for submillisecond partial
fills. Exact nanosecond timestamps and position-based tie ordering now preserve
those events; ambiguous ties fail explicitly. Final review and check results
are recorded in the PR. No UI or broker-runtime
source changes are part of this experiment.
