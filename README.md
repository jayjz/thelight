# LIGHTLIGHT

LIGHTLIGHT (`thelight`) is an evidence-driven quantitative research system with a bounded Alpaca PAPER execution runtime. Its purpose is to make strategy research, decision state, broker execution, and recovery inspectable and reproducible. It is not a profitability claim and it has no live-money execution path.

## Research thesis

Deterministic quantitative signals should remain independently reproducible. Typed model outputs may assist regime classification or strategy gating, while deterministic code retains decision, risk, sizing, and execution authority.

```text
market data
  -> deterministic features
  -> candidate strategy
  -> optional typed classification
  -> deterministic policy
  -> deterministic risk
  -> PAPER execution
  -> durable evidence
  -> independent evaluation
```

The model does **not** calculate indicators, position sizing, P&L, or broker authority, and it does not receive free-form BUY/SELL control.

## Current runtime status

The repository now contains both a research plane and a PAPER execution plane.

| Runtime | Market data | Strategy | Authority |
| --- | --- | --- | --- |
| SPY / 15Min | Alpaca IEX via the bounded market path | `ema_trend` / Arm C | PAPER dispatch capable |
| SPY / 1Min | Alpaca IEX via the bounded market path | `ema_rsi_v1` | PAPER dispatch capable |
| QQQ / 1Min | bounded equity runtime | `ema_rsi_v1` | read-only durable evidence |
| IWM / 1Min | bounded equity runtime | `ema_rsi_v1` | read-only durable evidence |
| AAPL / 1Min | bounded equity runtime | `ema_rsi_v1` | read-only durable evidence |
| MSFT / 1Min | bounded equity runtime | `ema_rsi_v1` | read-only durable evidence |
| BTC/USD / 1Min observations | continuous Alpaca crypto WebSocket | market evidence only | READ_ONLY_DURABLE; broker authority NONE |

Only SPY currently has broker dispatch authority. Multi-equity and BTC capability boundaries are intentionally narrower than their market-data/evidence capabilities.

The September 22, 2026 SPY PAPER session exercised the live path through closed bars, deterministic decisions, fenced dispatch, Alpaca PAPER fills, broker reconciliation, trade updates, position observations, and durable Postgres evidence. That run is evidence that the execution harness operates end-to-end; it is **not** evidence that the current strategy has positive expectancy.

## Safety boundaries

- PAPER only. No live-money Alpaca domain is supported.
- Broker account, position, open orders, and broker order state are authoritative for execution truth.
- Dispatch is single-owner across processes through a Postgres lease and monotonic fencing token.
- `UNKNOWN` and `SUBMISSION_ATTEMPTED` recovery fail closed; uncertainty never authorizes a retry.
- Alpaca `trade_updates` are retained as durable evidence and correlated to deterministic client-order identities.
- Terminal intent projection is monotonic: a confirmed fill cannot be regressed by a delayed nonterminal broker observation.
- Market-data gaps invalidate continuity and must be recovered and verified before dispatch resumes.
- Vercel serves the web boundary only; it never owns the long-lived PAPER worker.
- Non-SPY runtimes do not receive broker authority merely because they can persist market evidence.

## Local setup

Use Node.js 22 and the checked-in lockfile.

```sh
npm ci
cp .env.example .env
npm run dev
```

Keep credentials in the untracked `.env`. A durable `DATABASE_URL` is required for PAPER dispatch authority.

## Verification

```sh
npm run typecheck
npm run lint
npm run test:lightlight
npm run build
```

The ownership integration suite uses a real configured database and makes no Alpaca order request:

```sh
npm run test:alpaca-worker-ownership
```

## BTC/USD 24/7 observation

```sh
npm run btc:worker -- start
npm run btc:observe -- --once
npm run btc:observe
```

The worker requires durable `DATABASE_URL` and `ALPACA_API_KEY_ID` /
`ALPACA_API_SECRET_KEY`; native Node environment loading reads an optional `.env`
without overriding host variables. Apply existing migrations before first start.
Run on an always-on host; stop gracefully with SIGINT (Ctrl+C) or SIGTERM.
The observer only needs `DATABASE_URL` and opens a read-only database session.

BTC has **zero broker authority and zero order submission**. It persists completed
BTC/USD minute bars, worker runs, a fenced lease and an owned checkpoint. Reconnect
is bounded inside the source; restart uses a new run and preserves prior evidence.
The observer reports lease, subscription, bar/checkpoint freshness, reconnect and
halt evidence. A three-minute bar-age threshold is operational only, active 24/7.
Exact historical BTC recovery repairs missing closed minutes using fully paginated
Alpaca US crypto bars, with REST_BACKFILL provenance and fenced writes. Startup
verification is bounded to 24 hours; failures halt with visible GAP_DETECTED
continuity. `npm run btc:historical-smoke` manually verifies three completed
minutes without database or broker mutation.
See [BTC operation and soak procedure](docs/BTC_PAPER_RUNTIME.md#247-read-only-operation).
Next BTC milestone: PAPER execution after an observation soak, not strategy optimization.

## PAPER operation

Default SPY worker:

```sh
npm run alpaca:worker -- start
```

The 1-minute EMA/RSI arm can be selected explicitly:

```sh
npm run alpaca:worker -- start --arm ema_rsi_v1 --symbol SPY
```

Read-only durable observer:

```sh
npm run alpaca:observe -- --arm ema_rsi_v1 --symbol SPY --verbose
```

The observer requires `DATABASE_URL` only. It does not acquire dispatch ownership or use Alpaca credentials.

Read-only smoke paths:

```sh
npm run alpaca:worker:smoke -- --observe-only
npm run alpaca:crypto-smoke
```

See [docs/ALPACA_PAPER_WORKER.md](docs/ALPACA_PAPER_WORKER.md) for authority, recovery, and operator semantics.

## Current engineering priorities

1. Make durable `worker_runs` lifecycle state faithfully track `STARTING -> RECONCILING -> READY` and terminal states.
2. Package PAPER sessions as immutable experiment manifests that reference existing durable evidence.
3. Make offline replay reproduce live decision and execution timing before comparing PAPER and historical results.
4. Improve operator telemetry so no-position-change reconciliation is not visually confused with a broker cancellation.
5. Complete repository/main-branch consolidation and remove merged stale branches.
6. Only then resume strategy iteration, starting with prospectively defined turnover-suppression experiments.

## Known limitations

- Regular-hours eligibility uses a weekday/time heuristic rather than a full exchange calendar.
- `ema_rsi_v1` thresholds are uncalibrated research heuristics; the September 22 run showed substantial short-horizon churn.
- PAPER execution timing observed live must still be encoded exactly in the evaluator/replay contract.
- Formal immutable `ExperimentRun` packaging is not yet implemented.
- Multi-symbol PAPER authority does not exist; portfolio-level exposure and arbitration controls are intentionally deferred.
- The bounded equity relay contract requires explicit subscription-union behavior before multi-symbol live evidence collection is considered complete.
- BTC/USD is read-only durable infrastructure, not a PAPER execution runtime.
- The repository still contains inherited app-builder/Grok substrate that requires a dependency-aware cleanup rather than blind deletion.

## Documentation

- [Project status](docs/PROJECT_STATUS.md) — current implementation, proven boundaries, known gaps, and branch state.
- [Architecture](docs/ARCHITECTURE.md) — research/execution boundaries and causal invariants.
- [Evidence contract](docs/EVIDENCE_CONTRACT.md) — decision/execution provenance and immutability.
- [Experiment contract](docs/EXPERIMENT_CONTRACT.md) — reproducibility and controlled-comparison rules.
- [Alpaca PAPER worker](docs/ALPACA_PAPER_WORKER.md) — dispatch authority, reconciliation, persistence, and operator controls.
- [BTC PAPER runtime](docs/BTC_PAPER_RUNTIME.md) — B0-B3 foundation, continuous read-only operation, soak procedure and deferred execution scope.
- [Relay capability](docs/lightlight-relay-capability.md) — bounded single-upstream equity subscription contract.
- [Execution model](docs/EXECUTION_MODEL.md) — causal fills, accounting, and unknown execution state.
- [Roadmap](docs/ROADMAP.md) — current milestones and sequencing.

## SPY strategy research (read-only)

`npm run research:paper-session -- --strategy ema_rsi_v1 --symbol SPY --date 2026-09-23`
exports and analyzes existing durable evidence using DATABASE_URL only. Offline
fixtures require no database or broker access. `ema_rsi_v2` is a frozen research
candidate, not a registered PAPER worker arm; V1 and execution authority are unchanged.
See [reproduction and evidence limits](docs/experiments/PAPER_SESSION_RESEARCH.md),
[prospective specification](docs/experiments/EMA_RSI_V2.md), and
[development results](docs/experiments/SPY_DEVELOPMENT_RESULTS.md).
