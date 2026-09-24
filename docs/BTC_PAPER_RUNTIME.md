# BTC PAPER Runtime

## Purpose

Extend LIGHTLIGHT's existing Alpaca PAPER runtime to support `BTC/USD` without
weakening the causal, deterministic, evidence, reconciliation, or dispatch
invariants already established for SPY.

This phase proves crypto execution infrastructure. It does not claim that the
existing SPY strategy or thresholds are valid for BTC.

## 24/7 read-only operation

The production-shaped observer slice extends B0-B3. Its complete active path is:

```text
Alpaca BTC/USD crypto WebSocket -> completed 1Min bars -> DurableMarketWorker
  -> Postgres/Neon closed_bars + market_bar_observations
  -> owned runtime_checkpoint + worker_runs + worker_leases
  -> read-only terminal observer
```

**READ_ONLY_DURABLE / MARKET_EVIDENCE_ONLY. BROKER AUTHORITY: NONE.**
The canonical `BTC_USD_RUNTIME_IDENTITY` is unchanged, including its compatibility
worker key `alpaca-paper:BTC/USD:15Min:alpaca-paper-worker-v1`. The `15Min` label is
inherited identity metadata; this service only records completed 1Min bars and
creates no strategy decisions or execution intents. No broker module, trading
REST endpoint, order submission, position reconciliation or trade-update
subscription is reachable from the BTC operator import graph. Shared transport
primitives are isolated from the existing equity broker implementation.

```sh
npm run btc:worker -- start
npm run btc:observe -- --once
npm run btc:observe
```

Use Node 22 on an always-on host, with existing migrations applied. Both commands
load an optional `.env` using `--env-file-if-exists`; exported host values take
precedence. Worker requirements: durable `DATABASE_URL`, `ALPACA_API_KEY_ID` and
`ALPACA_API_SECRET_KEY`. The observer requires only `DATABASE_URL`; it uses a
read-only database session and transaction, and never connects to Alpaca or
acquires/renews a lease. A SELECT-only database role is suitable for the observer.
Database connection/statement/query timeouts are ten seconds. Vercel cannot run
the worker. No process-manager dependency is introduced.

Startup creates a new run, acquires a 30-second BTC lease, recovers the checkpoint
and durable bars, then connects. READY requires subscription acknowledgement and
a persisted READY run. A referenced heartbeat keeps the process alive, renews
ownership every ten seconds and persists stream status changes (observed every
second) plus ten-second checkpoint heartbeats. Stop with Ctrl+C, SIGINT or
SIGTERM. Graceful stop closes the source, drains serialized writes, persists
STOPPED and releases ownership. HALTED is preserved as terminal evidence during
cleanup and exits nonzero. Signals are handled during startup as well.

Only the source reconnects: exponential delays of 250ms, 500ms, 1s, 2s, 4s, 8s,
16s, then 30s, with at most eight consecutive replacement attempts. Receiving a
valid completed bar resets the budget; acknowledgement alone does not reset it.
Each generation authenticates and subscribes to exactly BTC/USD bars. A ten-second
handshake deadline reconnects stalled transports; a socket must close before its
replacement opens (ten-second close deadline). Old callbacks and queued bars are
invalidated on replacement. Auth, subscription and malformed/protocol failures
are terminal. Completed-bar queues are bounded at 120; overflow halts rather than
silently losing evidence. There is no process-level reconnect loop.

### Verified historical recovery

Historical data uses only `GET https://data.alpaca.markets/v1beta3/crypto/us/bars`
with `symbols=BTC/USD`, `timeframe=1Min`, RFC3339 `start` and `end`, `sort=asc`,
and `limit=10000`. Both provider bounds are **inclusive**. Every non-null
`next_page_token` is followed, even on a short or apparently full page. Repeated
tokens, missing tokens, malformed responses, unexpected symbols and conflicting
duplicates fail closed. The client has no broker dependency or configurable host.
See [Alpaca's endpoint contract](https://docs.alpaca.markets/us/reference/cryptobars-1).

On startup, acquire ownership and read the latest durable BTC bar, bounded bar
history and prior checkpoint. The bootstrap scope ends at the last completed
minute and begins no earlier than 1,439 minutes before it (24 hours inclusive).
Cold start fetches that bounded scope, validates every returned provider bar,
records each actual bar as `REST_BACKFILL`, and records provider-absent minutes
and ranges as bootstrap evidence. It never synthesizes OHLCV. Alpaca historical
crypto data may be sparse before LIGHTLIGHT owns the live stream, so bootstrap
certifies only the newest contiguous returned suffix ending at that completed
minute. `MIN_BOOTSTRAP_VERIFIED_MINUTES = 60`: fewer than 60 consecutive minutes
fails closed; 60 or more permits READY with `verifiedStartMs` and
`verifiedThroughMs` limited to that suffix. Older sparse history remains visible
but outside VERIFIED continuity.

An existing verified suffix can shorten the rolling read. Only missing or
previously unverified contiguous ranges after that suffix are fetched; an already
complete verified interval requires no REST request. Bars inserted before a crash
but beyond the verified checkpoint are checked against REST, not silently trusted.
History older than the reported `verifiedStartMs` is not certified.

For a live jump from 12:00 to 12:04, persist the recovery attempt/checkpoint in
BACKFILLING with GAP_DETECTED continuity, request precisely 12:01 through 12:03,
validate the entire response, persist recovered evidence, re-read and verify the
durable range, and then accept 12:04 as LIVE_WS. Gaps exceeding 24 hours halt;
a restart can establish a new explicitly bounded scope. There is no strategy or
dispatch barrier in this market-only worker.

Every returned minute must have one valid, aligned provider bar. Positive finite
OHLC, valid high/low bounds and finite nonnegative volume are mandatory.
Identical duplicates collapse idempotently; conflicting evidence is never
overwritten. Once LIGHTLIGHT has VERIFIED continuity, every expected minute in a
new live-gap repair must also be returned in exact timestamp order; an incomplete
or conflicting live repair halts. Zero-volume bars are valid: Alpaca
can use quote midpoint prices when no trade occurs, per its
[historical crypto documentation](https://docs.alpaca.markets/us/docs/historical-crypto-data-1).
REST parsing is separate from WebSocket b/u message parsing.

No new ledger or migration is needed. `closed_bars` remains immutable canonical
evidence; `market_bar_observations` records LIVE_WS versus REST_BACKFILL, provider
timestamp and recovery-attempt ID. `market_gap_recovery_attempts` retains its
existing **half-open** storage bounds: a one-minute request at 12:01 is stored as
[12:01,12:02). This does not widen the provider request. The checkpoint's recovery
summary distinguishes `BOOTSTRAP_QUALIFICATION` from `EXACT_LIVE_GAP_REPAIR` and
includes the explicit inclusive `requestedStartMs`/`requestedEndMs`,
requested/fetched/accepted/identical/conflicting counts, result/reason and times.
Bootstrap evidence additionally retains provider-returned count, missing-minute
and range counts, the ranges themselves, verified suffix bounds and contiguous
minute count. Older attempt counts can be derived from its bounds and linked
observations.

BTC observation, recovery-attempt and checkpoint writes acquire the current
lease row lock inside one transaction and validate run ID, fencing token and
expiry. The transaction checks expiry again before completion and rolls back if
expired. Cumulative accepted backfill counts advance in the same transaction as
the corresponding immutable bar observations, so crash/restart retries do not
lose or double-count them. GETs hold no database lock; ownership is renewed before and after each
bounded fetch and before each batch of at most 32 recovered observations.
Subscription startup timeout begins after historical recovery. Stale runs cannot
insert recovered evidence, finish attempts or
mark continuity healthy. Old runs are preserved and abandoned runs are superseded
only through lease takeover.

Historical reads have three attempts per page, deterministic 250/500ms backoff,
a four-second request/body timeout and a 20-second whole-interval deadline.
429/5xx and transport failures may retry; 401/403 and protocol failures are
terminal. Retry-After and X-RateLimit-Reset are respected; a provider delay over
five seconds fails rather than retrying early. Pagination is also bounded to
1,441 pages. No outer worker retry loop repeats a failed recovery.

Manual read-only smoke (not CI, no database mutation):

```sh
npm run btc:historical-smoke
```

It validates three completed minutes, leaving one extra minute of provider
publication margin, and prints only their timestamps and count.

### Health and continuity

The durable worker states remain STARTING, READY, HALTED and STOPPED. DEGRADED is
an observer projection, never a new persisted lifecycle state. Output includes
symbol, capability/reason, worker key, run/lease owner, token, database-time lease
expiration/live status, crypto stream state, acknowledgement, latest bar/time
age, checkpoint update/age/caught-up status, last advancing bar persistence time,
recovered count/window, reconnect generation/attempt, stream error and halt reason.
The lease owner's run takes precedence over a later rejected startup contender.

`BTC_MAX_COMPLETED_BAR_AGE_MS = 180_000` measures age from the provider's minute
**start** timestamp (one minute is already elapsed when the bar completes).
`BTC_MAX_CHECKPOINT_AGE_MS = 30_000` bounds checkpoint heartbeat age. Thresholds
are inclusive, tested, operational and apply around the clock, including weekends.
A delayed minute degrades health without halting or changing a strategy threshold.
Freshness, subscribed status and a live lease are separate evidence; a checkpoint
heartbeat alone is not evidence of new bars. Database time drives observer ages.

Continuity is UNVERIFIED before bootstrap begins, GAP_DETECTED during bootstrap,
recovery or failure, and VERIFIED only for the provider-backed suffix or exact
post-verification repair. Adjacent valid live bars
extend that verified chronology. The observer reports continuity, verification
bounds, bootstrap sparse-history evidence, active/last recovery kind, inclusive
requested range, counts, result/reason and whether historical continuity is
verified. UNVERIFIED and GAP_DETECTED degrade health.

A failed bootstrap qualification, or failed incomplete/conflicting exact live
recovery, halts and preserves GAP_DETECTED; the arriving live bar is not accepted.
Restart re-verifies the unresolved range; a prior live-bar conflict invalidates
the trusted prefix and requires REST revalidation. Conflict invalidation is
committed atomically with the observation result, including across a crash or
ownership loss before the worker can persist its terminal halt.
Storage failure also halts; if the database itself is unavailable, failure
recording may fail, so `persistenceError` is logged and exit is nonzero. Updated
bars (`u`) cannot revise immutable evidence. Provider revisions may therefore
require investigation rather than automatic overwrite. Verification proves
minute coverage within the reported scope, not independent price accuracy or
completeness of older history. No 24h/72h soak or BTC execution is implied.

### 24h / 72h soak procedure

1. Apply migrations, start one worker, save an initial `btc:observe -- --once`
   snapshot and confirm subscribed state, a live lease and advancing BTC bars.
2. Keep worker logs and observer samples externally for 24 hours. Sample at least
   once per minute; inspect maximum bar/checkpoint age, reconnect attempts,
   ownership stability and all continuity warnings. No trading smoke is needed.
3. During a controlled maintenance window send SIGTERM, verify durable STOPPED
   and an expired/released lease, then restart. Confirm a new run ID, larger fencing
   token, recovered count and preserved bars/checkpoint. Repeat with SIGINT.
4. In a controlled read-only soak, interrupt network access and restore it within
   the reconnect budget. Confirm reauthentication/resubscription, one owner, no
   overlapping sockets, advancing bars and explicit gaps. Exhaustion must HALT;
   restart manually after the cause is resolved.
5. Optionally terminate the worker abruptly, wait past its 30-second lease, then
   restart. Confirm the predecessor is SUPERSEDED and no bars were duplicated.
6. Extend to 72 hours including a weekend. Acceptance requires explainable gaps,
   no silent stalls, no duplicate durable bars, correct terminal run states and
   **zero decisions/intents/orders/positions created by BTC**. Archive observations
   and investigate HALTED/DEGRADED episodes before authorizing the next milestone.

This implementation is not a completed 24h/72h soak. The next milestone is BTC
PAPER execution **after soak**, not strategy optimization. Out of scope: BTC PAPER
order submission, fractional execution, crypto broker reconciliation, strategy
calibration, cost/slippage tuning, ETH, portfolio execution and live-money trading.

The retained manual `npm run alpaca:crypto-smoke` only observes one completed bar;
it does not run a durable worker. Do not run it concurrently where Alpaca's
connection allowance is one. Unit tests inject sockets and forbid real networking.
The official [crypto stream contract](https://docs.alpaca.markets/us/docs/real-time-crypto-pricing-data)
and [authentication/error contract](https://docs.alpaca.markets/us/docs/streaming-market-data)
were checked on 2026-09-22.

## Branch scope

Target progression:

1. Freeze current SPY behavior. **Complete (B0)**
2. Introduce an explicit asset/runtime contract. **Complete (B1)**
3. Add Alpaca crypto market-data transport. **Complete (B2)**
4. Scope worker identity, leases, checkpoints, evidence, and broker state by asset. **Complete (B3)**
   Continuous BTC market observation is implemented; observation soak remains pending.
5. Add `BTC/USD` long-only fractional PAPER execution.
6. Add BTC-specific deterministic risk and cost configuration.
7. Exercise the complete BTC PAPER path.
8. Run a 24/7 soak including stop/restart/reconciliation.
9. Add `ETH/USD` only after BTC validates the shared crypto path.

## Shared pipeline

```text
AssetSpec
  -> MarketSource
  -> normalized closed bars
  -> completed decision buckets
  -> deterministic features
  -> strategy signal
  -> asset-aware deterministic policy
  -> deterministic risk
  -> immutable decision evidence
  -> execution intent
  -> fenced dispatch authority
  -> Alpaca PAPER
  -> broker observations
  -> durable execution evidence
```

Shared infrastructure does not imply shared strategy parameters.

Initial asset contracts
SPY
asset class: US equity
Alpaca market data: IEX
session: US regular hours
decision timeframe: 15 minutes
quantity: whole-share
directional capability: long/short/flat according to existing policy
existing strategy/risk behavior must remain unchanged during the asset refactor
BTC/USD
asset class: crypto
Alpaca crypto market-data transport
session: always open
decision timeframe: initially 15 minutes
quantity: fractional
initial execution capability: long/flat only
strategy parameters: explicitly uncalibrated until separately evaluated

A negative strategy signal on a long-only crypto asset does not authorize a
broker short. Policy must deterministically map unsupported negative exposure to
flat/reduced long exposure.

## B0/B1 implementation status

The current runtime remains a single `SPY` PAPER worker. Its explicit contract
is `US_EQUITY` / `ALPACA_IEX` / `US_REGULAR` / `WHOLE` / `LONG_SHORT`; its
decision timeframe remains 15 minutes and its durable worker key remains
`alpaca-paper:SPY:15Min:alpaca-paper-worker-v1`.

The current US regular-hours heuristic is now selected through the asset
contract and still means weekdays in `America/New_York` with decision-bucket
starts in `[09:30, 16:00)`. A pure `ALWAYS_OPEN` session capability and generic
long-only direction mapping exist only at the contract boundary; neither has a
runtime consumer yet.

This phase adds no BTC order path, fractional execution, multi-asset worker,
migration, or live-money behavior.

## B2 implementation status

B2 adds a read-only `AlpacaCryptoMarketSource` for the canonical
`BTC_USD_SPEC`. It uses Alpaca's dedicated crypto market-data WebSocket,
authenticates with the existing market-data credentials, and subscribes only to
the `BTC/USD` minute-bars channel. The adapter is separate from the IEX parser.

Only `T: "b"` minute bars enter the normalized `ClosedBar` contract. Alpaca
defines those messages as the preceding completed minute; their RFC-3339 `t`
value is retained as the bar-start timestamp, matching LIGHTLIGHT's existing
one-minute and 15-minute aggregation convention. `updatedBars` (`T: "u"`) are
deliberately excluded: a late correction cannot revise evidence already used by
a downstream decision.

The crypto adapter has its own ordered frame processing, explicit
authentication/subscription state, bounded reconnect, and generation guard, so
callbacks from an old socket cannot emit after reconnect or close. Its read-only
smoke authenticates, receives the subscription acknowledgement, and observes a
completed BTC/USD bar without starting the PAPER worker or using a broker API.

B2 proves:

- provider connectivity;
- BTC/USD subscription;
- crypto message parsing;
- normalized completed bars; and
- reconnect lifecycle.

B2 does not prove:

- BTC trading;
- fractional execution;
- BTC profitability;
- BTC risk calibration;
- durable BTC dispatch; or
- BTC restart/reconciliation.

## B3 implementation status

B3 centralizes a pure `WorkerRuntimeIdentity` derived from `AssetSpec`. It
preserves SPY's legacy identity exactly:

```text
alpaca-paper:SPY:15Min:alpaca-paper-worker-v1
```

and gives BTC/USD its independent identity:

```text
alpaca-paper:BTC/USD:15Min:alpaca-paper-worker-v1
```

The identity has an explicit capability discriminant. SPY is
`DISPATCH_CAPABLE` at the existing equity broker boundary. BTC/USD is
`READ_ONLY_DURABLE` (`MARKET_EVIDENCE_ONLY`): it can acquire its own fenced
lease, restore/write its own checkpoint, and persist/recover normalized closed
bars, but its runtime type receives neither broker reconciliation nor dispatch
operations.

No schema migration is required. Existing tables already isolate worker runs,
leases, and checkpoints by `worker_key`, raw bars by `(symbol, timestamp_ms)`,
decisions and positions by `symbol`, and downstream intent/order/update records
by global deterministic IDs. Decision, intent, and client-order IDs now derive
from the asset identity, so same-timestamp SPY and BTC records cannot collide.
Legacy SPY rows remain valid because its worker key and deterministic decision
hash input are byte-for-byte unchanged.

Real Postgres tests use independent connections and random test-only keys to
prove one-owner-per-asset, simultaneous SPY/BTC leases, per-key fencing
generations, stale-token rejection, cross-asset checkpoint rejection, and
same-timestamp bar isolation. They do not call Alpaca.

B3 proves:

- deterministic BTC runtime identity;
- independent worker/lease namespace;
- independent checkpoint and closed-bar evidence namespace;
- real Postgres fencing isolation; and
- a safe durable-versus-dispatch capability boundary.

B3 does not prove:

- BTC order submission;
- fractional execution;
- BTC broker reconciliation or position mutation;
- BTC profitability or strategy calibration; or
- live-money trading.

Non-negotiable invariants
no component may use information unavailable at the decision timestamp
decisions use only completed bars
no retrospective exposure
decision evidence remains separate from later execution facts
deterministic strategy/policy/risk code retains authority
model/Jev output never owns sizing, P&L, risk, or dispatch
broker state is authoritative for PAPER execution state
client-order IDs are identities, never dispatch authority
UNKNOWN fails closed
SUBMISSION_ATTEMPTED fails closed
uncertain submissions are never blindly retried
reconciliation occurs before dispatch/recovery
only the currently fenced Postgres lease owner may dispatch
stale fencing tokens cannot mutate dispatch state or checkpoints
Vercel never owns the long-lived worker
PAPER only; no live-money execution path
Durable identity

Asset identity must participate in every durable authority/evidence boundary
where collisions would otherwise be possible, including:

worker key
worker run
lease/fencing scope
checkpoint
bar identity
decision identity
intent identity
client-order identity
broker observation
position evidence

SPY and BTC workers must be independently recoverable and independently fenced.

Market data

Equity and crypto transports remain separate provider adapters.

Both normalize into the same internal closed-bar contract before feature
calculation.

Do not scatter checks such as if (symbol === "BTC/USD") through worker logic.
Asset-specific behavior should enter through explicit runtime contracts.

Execution

The first BTC implementation should prefer simple, inspectable sizing.

Initial PAPER sizing may use fixed notional or another explicitly bounded,
deterministic rule. Portfolio optimization is out of scope.

The unavoidable execution boundary remains:

durable SUBMISSION_ATTEMPTED
  -> external broker request
  -> durable broker observation/reconciliation

Postgres fencing protects dispatch authority but does not make the broker HTTP
request transactional with the database.

Strategy boundary

SPY parameters are not evidence for BTC parameters.

Any reused EMA/regime values during plumbing validation must be labeled
UNCALIBRATED.

Infrastructure validation and strategy validation are separate milestones.

BTC runtime acceptance criteria

Before B8 is considered complete:

existing SPY tests and semantics remain unchanged
BTC/USD market data normalizes into completed bars
always-open session semantics are explicit
BTC uses an asset-specific worker key and fenced ownership scope
fractional PAPER execution is supported deterministically
unsupported short exposure maps safely to flat/reduced long exposure
durable BTC decisions, intents, orders, positions, and checkpoints are isolated
UNKNOWN and SUBMISSION_ATTEMPTED remain fail-closed
stale worker/fencing state cannot dispatch
real Alpaca PAPER BTC execution is exercised
stop/restart reconciles from Neon + broker truth without duplicate submission
resulting evidence is inspectable afterward
Out of scope
live-money trading
ETH before BTC proves the shared crypto path
strategy optimization
portfolio optimization
leverage/margin
broker shorting of crypto
replacing deterministic risk authority
merging crypto transport directly into the IEX adapter
