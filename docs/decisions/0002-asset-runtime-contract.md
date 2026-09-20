# ADR 0002: Explicit asset runtime contracts

## Status

Accepted. B0/B1 establishes the contract while retaining one SPY PAPER worker.
B2 adds a separate, read-only crypto market-data adapter; crypto execution
remains deferred.

## Context

LIGHTLIGHT's first PAPER runtime was implemented for SPY. That implementation
contains assumptions that are valid for US equities but are not universally
valid:

- IEX market data
- regular US trading session
- whole-share quantities
- equity directional semantics
- SPY-specific worker identity and runtime configuration

Adding `BTC/USD` by changing only the symbol would mix incompatible market-data,
session, sizing, and execution semantics into code that currently has strong
evidence and recovery guarantees.

## Decision

Introduce an explicit asset contract before adding BTC execution.

The contract will describe at minimum:

```ts
type AssetClass = "US_EQUITY" | "CRYPTO";

type MarketDataKind =
  | "ALPACA_IEX"
  | "ALPACA_CRYPTO";

type MarketSession =
  | "US_REGULAR"
  | "ALWAYS_OPEN";

type QuantityMode =
  | "WHOLE"
  | "FRACTIONAL";

type DirectionMode =
  | "LONG_SHORT"
  | "LONG_ONLY";

type AssetSpec = {
  symbol: string;
  assetClass: AssetClass;
  marketDataKind: MarketDataKind;
  session: MarketSession;
  quantityMode: QuantityMode;
  directionMode: DirectionMode;
};

Exact names may change during implementation, but these distinctions must remain
explicit.

Consequences
Positive
SPY behavior can remain frozen while asset assumptions are extracted.
Crypto transport does not contaminate the existing IEX adapter.
Session eligibility becomes an asset property rather than a SPY-specific rule.
Fractional execution becomes explicit.
Unsupported short exposure can be rejected or mapped deterministically.
Worker ownership, checkpoints, and evidence can be scoped by asset.
ETH can later reuse the validated crypto runtime without copying the worker.
Costs
Existing SPY assumptions must be identified and moved behind the contract.
Worker and evidence identities may require asset-aware generalization.
Tests must prove SPY behavior is unchanged through the refactor.
Authority rules

The asset contract describes broker/runtime capabilities. It does not grant
trading authority.

Authority remains:

market evidence
-> deterministic features
-> deterministic strategy
-> deterministic asset-aware policy
-> deterministic risk
-> durable intent
-> fenced worker ownership
-> broker reconciliation
-> PAPER dispatch

A strategy signal that requests an unsupported position is not automatically
translated into broker authority.

For the initial BTC runtime:

LONG signal  -> may request bounded long exposure
FLAT signal  -> request zero exposure
SHORT signal -> may reduce/exit long exposure, never open a broker short

The exact mapping must be deterministic and test-covered.

Rejected alternatives
Separate BTC repository

Rejected because it would duplicate fencing, reconciliation, evidence,
uncertainty, and worker lifecycle logic and allow those guarantees to drift.

Reuse SPY worker with symbol substitution

Rejected because crypto differs materially in market-data transport, session,
quantity, and directional execution semantics.

General multi-asset orchestration immediately

Rejected as premature. First prove one equity runtime and one crypto runtime
through the same explicit contract.

Verification requirement

The first implementation pass must prove:

SPY behavior is unchanged.
Asset semantics are explicit and test-covered.
No BTC broker transport or order submission is added until the contract is
established.

## Implementation record

B0/B1 is complete on `feat/btc-paper-runtime`:

- `src/lib/lightlight/assets.ts` owns the explicit `AssetSpec` vocabulary and
  canonical `SPY_SPEC`.
- The SPY worker derives its authority key, session eligibility, decision
  evidence symbol, and direction-capability boundary from that contract while
  preserving its legacy key and decision identities.
- `ALPACA_IEX`, the Alpaca stock stream protocol, and equity `day`
  time-in-force remain provider-transport behavior. B0/B1 introduced no crypto
  adapter, BTC subscription, fractional order, or migration.
- Focused regression tests freeze SPY's contract, IEX subscription, regular
  session boundaries, direction semantics, broker-position scope, and existing
  fenced recovery behavior.

B2 adds the canonical `BTC_USD_SPEC` and `AlpacaCryptoMarketSource` without
changing the SPY worker. The crypto adapter connects only to Alpaca's crypto
market-data WebSocket, authenticates and subscribes only to `BTC/USD` minute
bars, then normalizes completed `T: "b"` bars into the existing `ClosedBar`
contract. It excludes late updated-bar corrections (`T: "u"`) to preserve the
causal completed-bar boundary. Its reconnect lifecycle is generation-guarded
and it imports no broker execution, order, database, or worker path.

This implementation does not add BTC broker transport, fractional execution,
durable BTC dispatch, a migration, or live-money behavior.
