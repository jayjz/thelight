# Reproducing the SPY PAPER development experiment

The export command is a read-only projection of the existing Postgres evidence
contract. It does not create another ledger, database, worker or broker client.
It never acquires a lease. The only data operations are parameterized SELECTs
inside REPEATABLE READ READ ONLY, with read-only connection defaults and a 30s
transaction-local statement timeout (compatible with the pooled endpoint). The optional env file reader takes DATABASE_URL only; no
Alpaca configuration is loaded. Report/export files use exclusive creation and
refuse to overwrite an existing artifact.

```sh
npm run research:paper-session -- --strategy ema_rsi_v1 --symbol SPY --date 2026-09-23 --export /tmp/session.json --output /tmp/report.json
```

With a local credential file, add `--database-env-file /path/to/existing/file`.
An already supplied DATABASE_URL takes precedence. No credential file is needed
for reproducible offline analysis:

```sh
npm run research:paper-session -- --input src/lib/lightlight/fixtures/paper-sessions/2026-09-22.json.gz --output /tmp/sep22-report.json
npm run research:paper-session -- --input src/lib/lightlight/fixtures/paper-sessions/2026-09-23.json.gz --output /tmp/sep23-report.json
```

JSON and gzip JSON exports are accepted. Optional database selectors:
`--worker-key`, `--run-id`, or `--start 2026-09-23T16:00:00Z --end 2026-09-23T20:00:00Z`.
Dates mean America/New_York calendar days, including DST. Explicit bounds are
half-open source-bar timestamps, maximum seven days. Run IDs select the exact
runtime ID in immutable decisions; they do not invent run attribution for
symbol-scoped position snapshots. Keep the complete session for evaluation;
a bounded mid-session counterfactual explicitly starts flat and is not a
reconstruction of the preceding portfolio.

Exit 0 means captured feature/target parity passes; exit 2 means parity fails
(including no captured decisions); exit 1 means command/structural failure.
Every per-decision mismatch is retained. PASS does not certify a whole exchange
day, dispatch eligibility, broker execution or investment performance.

## Audit of existing capabilities

| Surface | Current authority and reuse | Limitation |
|---|---|---|
| Closed bars | `closed_bars`, timestamp + OHLCV + first receipt time | Later capture is not contemporaneous availability; availability is checked per decision |
| Features | Existing recursive EMA, SMA RSI, 20-observation realized volatility | PAPER deliberately recomputes from up to 23 bars, seeding at each window's first close |
| Decisions | `decisions.evidence_json`, `strategyDecision` | Source bar start and wall-clock decision time are distinct |
| Retained state | Prior **risk-approved** target | Not broker position; initial boundary input is observed, not inferred |
| Risk | Existing `evaluateRisk` with persisted PAPER drawdown input | Not a new counterfactual account-risk simulation |
| Execution | Append-oriented broker orders, trade updates, positions; current intent projection | Broker orders omit prices/quantities; exact priced fills require trade updates |
| Run identity | Worker key and nested run ID; worker lifecycle rows | No persisted live source revision/configuration hash |
| Replay | Existing `ReplayExecution` ledger and costs exactly once | NEXT_BAR_CLOSE is not PAPER timing; no alternative accounting engine added |
| Metrics | Canonical replay ledger for counterfactual returns/costs; actual fills for PAPER cash flows | Unit replay exposure differs from PAPER one-share sizing; never compare returns as account P&L |

The snapshot retains evidence references and original rows. SHA-256 canonical
hashes identify the export, bars and frozen V2 config. Analysis additionally
records Git revision, dirty state and source content hash. Runtime provenance
is explicitly null where not recorded. Fixture exports were collected read-only
on 2026-09-24; they contain no credentials. `execution_intents` are current
projections at extraction, not reconstructed historical status. Historical
broker observations remain separately available in the export.

## Reconstruction and limitations

Fill events use execution IDs (event ID/composite fallback), reject conflicting
duplicates, and retain event quantity, price, timestamp and authoritative
position quantity, retaining nanosecond event timestamps. True timestamp ties
require a unique ordering from broker position transitions; ambiguous ties fail
explicitly. Partial fills are economic events, not one fill inferred per
terminal order. A completed round trip must start flat, remain nonnegative, and
end flat with matching successive positions. Censored starts/ends are not
paired into fictional trades. P&L sums sell cash flows minus buy cash flows,
before unavailable explicit broker fees. Missing priced updates for terminal
FILLED orders are reported. Snapshot transitions have observation intervals,
not invented exact execution times; positions lack worker/run scope.

Holding time and time in market on complete trades exclude censored exposure.
Absolute account equity is not recoverable from immutable decisions: only
relative drawdown is persisted. Thus account turnover is null; exact fill
notional is reported. User-supplied account equity may be used only as a labeled
external denominator. Minute high/low excursions use only fully interior
minutes. Boundary-minute extrema and full exact MAE/MFE are unavailable.

Parity replays each causally available completed-bar window, compares EMA9,
EMA21, RSI14, requested target and the risk-approved target, and chains replayed
risk targets. It preserves live features, targets, prior targets and broker
snapshot timestamps separately. Exact equality is required, no rounding-based
pass. Warmup absence is matched explicitly. Missing decisions, future receipt,
changed bars and changed target evidence remain visible failures.

The counterfactual uses the same frozen bars/opportunities for both strategies,
starts flat, and uses NEXT_BAR_CLOSE/v1. Gaps prevent ledger comparison. It has
no PAPER risk/dispatch/execution parity claim. Existing replay timestamps label
minute **starts**, while the simulated economic fill occurs at that minute's
close. The original ledger is preserved; do not compare these labels directly
to wall-clock broker fill times. Pending terminal intents are not filled, and
no liquidation is synthesized. Cost scenarios debit per unit turnover in the
existing log-equity accounting convention.

See [frozen hypothesis](EMA_RSI_V2.md) and [development results](SPY_DEVELOPMENT_RESULTS.md).
