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

Restart inspects the newest persisted BTC timestamp and at most the preceding
24 hours of bars (1,440 one-minute timestamps). The recovered count is for that
bounded window, not lifetime storage. A bar inserted before a crash but ahead of
the checkpoint repairs the latest timestamp on restart. Bar identity remains
`(symbol, timestamp_ms)`; identical duplicates are idempotent and conflicting
OHLCV evidence halts. Old runs are preserved; an abandoned active predecessor is
marked SUPERSEDED only by the existing database lease takeover semantics. A
crashed owner must expire before replacement. Stale fencing cannot update the
checkpoint. Historical rows are never reconstructed or deleted.

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

**No verified historical crypto backfill exists.** Continuity starts UNVERIFIED;
a jump over missing minutes becomes sticky GAP_DETECTED and degrades health even
after fresh bars resume. The service continues collecting later evidence, labels
uncertainty and invents no missing bars. It cannot determine whether a missing
minute represents absent provider activity or lost delivery. Updated bars (`u`)
are excluded and old evidence is immutable. READY means current observation is
healthy, not historically verified continuity. Storage failure halts; if the
database itself is unavailable, durable failure recording may also fail, so the
process logs `persistenceError` and exits nonzero and the lease expires.

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
