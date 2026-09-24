# LIGHTLIGHT Project Status

**Snapshot:** 2026-09-22  
**Integration baseline:** `feat/btc-paper-runtime`  
**Default branch:** `main`

## Executive summary

LIGHTLIGHT has moved beyond a replay-only prototype. The repository now contains a bounded, durable Alpaca PAPER execution system with broker reconciliation, market-data recovery, cross-process dispatch fencing, deterministic decision evidence, and real PAPER fill handling.

The current engineering bottleneck is no longer “can the bot place PAPER orders?” That path has been exercised. The bottleneck is making every live session reproducible, operationally truthful, and directly comparable to offline evaluation before further strategy tuning or wider broker authority.

## Proven runtime capabilities

### SPY dispatch

SPY is the only asset with broker dispatch authority.

Two deterministic runtime paths exist:

- `ema_trend` on completed 15-minute buckets;
- `ema_rsi_v1` on completed 1-minute bars.

Both use the same safety model:

```text
closed market evidence
  -> deterministic decision
  -> deterministic risk
  -> durable execution intent
  -> broker reconciliation
  -> fenced dispatch authority
  -> Alpaca PAPER
  -> broker/trade-update evidence
  -> durable position/account observations
```

### Dispatch safety

Implemented:

- durable Postgres/Neon state;
- one live lease owner per worker key;
- monotonic fencing token;
- fenced `PENDING -> SUBMISSION_ATTEMPTED` transition;
- final lease revalidation before the one authorized broker POST;
- broker-authoritative restart reconciliation;
- fail-closed `UNKNOWN` handling;
- fail-closed uncertain-submission recovery;
- deterministic client-order correlation;
- append-oriented broker evidence;
- fill projection that cannot regress to delayed nonterminal state.

### Market-data safety

Implemented:

- completed-bar-only decisions;
- continuity tracking;
- gap detection;
- bounded historical recovery;
- verification before continuity is restored;
- provenance for live versus recovered bars;
- dispatch barrier against retroactive orders generated from repaired historical buckets.

## September 22 PAPER result

The September 22 SPY `ema_rsi_v1` session proved the complete PAPER execution path can operate and produce real Alpaca PAPER fills while preserving durable evidence.

The same run also showed that the initial 1-minute strategy is not ready to be treated as validated alpha. It generated substantial short-horizon turnover and negative realized performance in that sample. The correct next research action is to preserve the run, reproduce it offline, and test prospectively defined turnover-suppression variants rather than tune thresholds against that day after seeing the result.

## Runtime matrix

| Asset | Strategy/runtime | Durable market evidence | Broker authority |
| --- | --- | ---: | ---: |
| SPY | 15Min `ema_trend` | yes | PAPER |
| SPY | 1Min `ema_rsi_v1` | yes | PAPER |
| QQQ | 1Min `ema_rsi_v1` | yes | none |
| IWM | 1Min `ema_rsi_v1` | yes | none |
| AAPL | 1Min `ema_rsi_v1` | yes | none |
| MSFT | 1Min `ema_rsi_v1` | yes | none |
| BTC/USD | crypto read-only durable runtime | yes | none |

Capability is explicit: market/evidence support does not imply dispatch authority.

## Open correctness work

### 1. Worker lifecycle persistence

Observed durable `worker_runs.state` can remain `STARTING` after the runtime is operationally READY.

Target durable lifecycle:

```text
STARTING -> RECONCILING -> READY
                          |  |
                          |  +-> STOPPED
                          +----> HALTED

abandoned predecessor -> SUPERSEDED
```

This is the active runtime hardening item.

### 2. PAPER experiment manifest

The database already preserves the underlying bars, decisions, intents, broker observations, trade updates, positions, checkpoint, recovery, and worker evidence.

Missing: one immutable experiment/session manifest that binds those records to code/configuration identity and terminal metrics.

### 3. Live/replay execution parity

The evaluator must reproduce the live deterministic decision sequence and explicitly model the timing convention used by PAPER fills. Historical evaluation cannot silently use a different execution convention.

### 4. Operator telemetry

No-position-change reconciliation can currently look like a broker cancellation in the verbose observer. Preserve the evidence semantics but make the operator presentation distinguish local no-op resolution from an externally submitted/cancelled Alpaca order.

### 5. Exchange calendar

US regular-session eligibility still uses a weekday/time heuristic rather than a complete exchange calendar.

## Multi-asset boundary

The bounded US equity universe is SPY, QQQ, IWM, AAPL, and MSFT.

Only SPY may dispatch.

Before multi-symbol evidence collection is considered validated, the local relay must prove bounded subscription-union behavior over one Alpaca upstream equity WebSocket.

Before multi-symbol PAPER execution, implement portfolio-level authority for total exposure, per-symbol limits, buying power, simultaneous intent arbitration, account drawdown, cross-symbol open orders, and correlated exposure.

## BTC boundary

BTC/USD B0-B3 infrastructure is complete:

- SPY behavior frozen before refactor;
- explicit `AssetSpec`;
- Alpaca crypto market source;
- independent durable worker identity/lease/checkpoint/evidence.

BTC now has a dedicated continuous read-only operator: `npm run btc:worker -- start`
and database-only observer: `npm run btc:observe`. It records durable run, lease,
checkpoint and completed minute-bar evidence, with bounded source reconnect and
restart recovery. Authority remains `READ_ONLY_DURABLE / MARKET_EVIDENCE_ONLY`,
with zero broker authority or order submission. The operational bar-age limit is
three minutes, active 24/7. Verified historical crypto recovery uses the Alpaca US
bars endpoint, exact
inclusive minute requests, complete pagination and REST_BACKFILL provenance.
Startup is bounded to 24 hours and skips already verified durable intervals;
live gaps are repaired before the next bar is accepted. Recovery/checkpoint
writes are fenced. Incomplete or conflicting recovery remains GAP_DETECTED and
halts; only exact durable verification produces VERIFIED. Zero-volume bars are
valid. No migration or broker authority is added. Stop using SIGINT/SIGTERM. See the
[BTC soak procedure](BTC_PAPER_RUNTIME.md#24h--72h-soak-procedure).

24h/72h observation soak is pending. The next BTC milestone is PAPER execution
after soak; fractional execution, broker reconciliation and strategy/cost tuning
remain outside this slice.

## Repository state

`main` is the canonical baseline, including merged BTC B0-B3 and worker lifecycle
persistence. Historical recovery is stacked on observer commit `40efc45430fc7d92458b59c94dac22244a5dcd4b`
on `feat/btc-historical-recovery`, targeting `feat/btc-24x7-observer` for review.
Neither PR is merged by this task.

Do not delete inherited builder/Grok substrate until runtime dependencies have been audited.

## Near-term definition of sustained SPY PAPER readiness

- canonical integration code on `main`;
- CI green;
- one dispatch-capable SPY worker;
- durable lifecycle equals runtime lifecycle;
- graceful stop and crash/takeover evidence are correct;
- broker fill projection converges;
- market recovery remains fail closed;
- immutable PAPER experiment manifest exists;
- frozen session replays reproduce deterministic decisions;
- evaluator uses explicit live-compatible execution timing;
- multi-day PAPER soak completed.

No item above requires live-money brokerage.
