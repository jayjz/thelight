# Alpaca PAPER worker

The worker is a server-side, single-symbol (`SPY`) owner for one PAPER session.
It uses Alpaca closed 1Min bars, emits decisions only for fully populated,
completed 15Min buckets, and uses the existing deterministic `ema_trend` / Arm
`C` / risk path. React observes its snapshot and has no broker submission API.
Server-only controls in `alpaca-worker-control.server.ts` provide `start`,
`stop`, `status`, and `reconcile`; they are deliberately not UI routes.

Run a session-owned worker process with:

```sh
npm run alpaca:worker -- start
```

It requires a durable `DATABASE_URL`; a process without it halts before it can
connect streams or submit an order. Stop that session process with `SIGINT` or
`SIGTERM`.

## Authority and state

Dispatch authority is durable and single-owner across processes. Before broker
reconciliation or streams start, a process must acquire the Postgres lease for
the worker key. The lease names its `worker_run`, has a monotonically increasing
fencing token, and expires on PostgreSQL time (30-second lease, renewed every
10 seconds). A concurrent process cannot acquire a live lease. After expiry or
a graceful release, its replacement gets a higher token; the old token can no
longer claim an intent or enter the final pre-POST guard.

Immediately before a new broker POST, the current token atomically changes the
intent from `PENDING` to durable `SUBMISSION_ATTEMPTED`. The worker then locks
and revalidates the lease row through the bounded broker call. This serializes
lease takeover with the unavoidable external HTTP boundary; it does not pretend
that a broker POST is transactional with Postgres. Missing, expired,
superseded, ambiguous, or unavailable ownership always fails closed with no
POST.

On a successful takeover, any prior non-terminal `worker_runs` for the same
worker key become `SUPERSEDED`, with the superseding run ID, timestamp, and
reason retained. This is crash/abandonment evidence, not a claim that the old
process stopped gracefully. `STOPPED` and `HALTED` retain their existing
graceful/operator and fail-closed meanings. Graceful shutdown terminalizes its
run and makes its exact lease immediately replaceable; expiry remains the
recovery path if it crashes.

The worker key is a pure `AssetSpec` runtime identity:
`alpaca-paper:<symbol>:15Min:alpaca-paper-worker-v1`. The existing SPY value is
unchanged. B3 also establishes `BTC/USD`'s distinct key and fenced durable
market/checkpoint namespace. This does not grant BTC dispatch: its
`READ_ONLY_DURABLE` runtime has no broker reconciliation, trade-update, intent
claim, or broker POST capability. The SPY worker remains the only
`DISPATCH_CAPABLE` implementation described by this document.

```text
STARTING -> RECONCILING -> READY
                    \-> HALTED
```

Market and trade-update streams have independent state. The market stream uses
`DISCONNECTED -> CONNECTING -> CONNECTED -> DEGRADED -> RECONCILING -> bounded
reconnect -> CONNECTED`. Only one market consumer may be active. A transport
failure reconciles durable intent/broker state before a replacement consumer is
created; stop and HALTED cancel pending reconnects.

At startup it reads the checkpoint before dispatch authority, reconciles the
PAPER account, SPY position, open orders, all unresolved intents, and every
UNKNOWN client order ID. An unrecognized open SPY order, unavailable position,
or persisted UNKNOWN that remains absent halts dispatch. A later broker lookup
that finds the order adopts it; absence never permits a second POST.

Before every new intent dispatch, the worker again reads PAPER account equity,
SPY position and open orders. Any open SPY order conservatively blocks the new
target. Broker position is the sole sizing input. The worker uses
`America/New_York`, weekdays, and bucket starts in `[09:30, 16:00)`: the 15:45
bucket is eligible and the 16:00 bucket is not. This is deliberately not a full
exchange calendar; market holidays and exceptional closures are not modeled in
this pass. Market data outside that window is retained but cannot create a
broker dispatch.

PAPER equity drawdown uses broker-authoritative account equity. The durable
high-water is `max(previousHighWater, currentEquity)` and the risk input is
`(highWater - currentEquity) / highWater`. Invalid or unavailable equity halts
the worker conservatively, and the value used is retained in decision evidence.
An existing pre-hardening checkpoint that has no high-water value also halts for
operator recovery rather than silently seeding a weaker peak from current equity.

A missing or incomplete regular 15-minute bucket invalidates feature continuity.
Returns, EMA, realized volatility, RSI and trend state restart from following
complete buckets; dispatch remains blocked until feature warmup completes. This
state is checkpointed, so a restart cannot bridge a gap.

## Persistence

`migrations/0002_alpaca_paper_worker.sql` stores append-only bars, immutable
decision evidence, current intent projections, append-only broker order and
position observations, trade updates, worker runs, and a checkpoint. The SQL
backend configured with `DATABASE_URL` is required before dispatch authority is
granted. The preview PGlite fallback is deliberately not used by this worker
because it resets with the process.

Decision evidence and its initial intent are inserted in one real database
transaction (`BEGIN`, decision insert, intent insert, `COMMIT`; failure rolls
back). A unique decision-to-intent constraint protects cardinality. Before a
broker POST, the fenced owner durably marks intent state
`SUBMISSION_ATTEMPTED`; restart reconciles that deterministic client order
identity and never treats it as new permission to submit again.

The lease mechanism has SQL-backed concurrency coverage via
`npm run test:alpaca-worker-ownership`. It makes no Alpaca request. Market-hours
soak is still required to observe lease renewal and takeover behavior alongside
real stream disconnect/reconnect timing.

## Manual smoke

The default command authenticates, reconciles account/position/open orders, and
observes a SPY bar. It never submits an order:

```sh
npm run alpaca:worker:smoke -- --observe-only
```

An actual PAPER dispatch is a separate, explicit operator action:

```sh
ALPACA_PAPER_WORKER_SMOKE_DISPATCH=YES npm run alpaca:worker:smoke -- --paper-dispatch
```

Neither command supports a live-money Alpaca domain.

The dispatch smoke reads actual Alpaca 1-minute history into durable worker
storage and invokes the worker path itself. It reports the deterministic
decision/intent/client-order identities, reconciled position, persisted broker
order state, and whether policy actually produced a dispatch. It never
constructs a raw order POST.
