# BTC PAPER Runtime

## Purpose

Extend LIGHTLIGHT's existing Alpaca PAPER runtime to support `BTC/USD` without
weakening the causal, deterministic, evidence, reconciliation, or dispatch
invariants already established for SPY.

This phase proves crypto execution infrastructure. It does not claim that the
existing SPY strategy or thresholds are valid for BTC.

## Branch scope

Target progression:

1. Freeze current SPY behavior. **Complete (B0)**
2. Introduce an explicit asset/runtime contract. **Complete (B1)**
3. Add Alpaca crypto market-data transport. **Complete (B2)**
4. Scope worker identity, leases, checkpoints, evidence, and broker state by asset. **Complete (B3)**
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
