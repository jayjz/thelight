# LIGHTLIGHT Architecture

## Purpose

LIGHTLIGHT is an evidence-producing quantitative research terminal.

It exists to test whether a typed decision model such as Jev can add measurable value as a bounded market-state classifier when:

1. market data is independently sourced,
2. features are deterministic,
3. trading strategies are deterministic,
4. Jev only classifies supplied state,
5. policy and risk remain deterministic,
6. execution is simulated independently,
7. every decision and execution event is reconstructable.

LIGHTLIGHT is not a stock picker.

It is not a profitability claim.

It is not currently a live-trading system.

---

## Core invariant

> No component may infer or use information unavailable at the timestamp of the decision it is producing.

This invariant applies to:

- feature calculation,
- strategy generation,
- Jev requests,
- policy evaluation,
- risk evaluation,
- execution,
- evidence generation,
- backtests,
- metrics.

A decision produced after bar `t` closes must not receive economic exposure to the return that already occurred between `t-1` and `t`.

---

## System model

```text
AssetSpec
    │
    ▼
MarketSource
    │
    ▼
ClosedBar
    │
    ▼
FeatureEngine
    │
    ├──────────────► StrategyEngine
    │                     │
    │                     ▼
    │              DeterministicSignal
    │
    └──────────────► JevAdapter
                          │
                          ▼
                   TypedClassification
                          │
DeterministicSignal ──────┤
                          ▼
                       Router
                          │
                          ▼
                    RiskGovernor
                          │
                          ▼
                   DecisionEvidence
                          │
                          ▼
                   ExecutionEngine
                          │
                          ▼
                    Fill / Position
                          │
                          ▼
                    EquityLedger
                          │
                          ▼
                  ExecutionEvidence
                          │
                          ▼
                  EvaluationEngine
                          │
                          ▼
                       Terminal
Architectural boundaries
1. Data

Responsible for:

closed market bars,
dataset identity,
timestamps,
source provenance,
normalization,
missing-data policy.

Must not:

generate strategy decisions,
calculate Jev classifications,
inspect future bars.

The runtime selects data source, session eligibility, quantity semantics, and
direction capability through an explicit `AssetSpec`. These capabilities do
not contain strategy thresholds or risk parameters. The SPY PAPER worker remains
the only dispatch-capable runtime consumer (`US_EQUITY`, Alpaca IEX, US regular
session, whole units, long/short). B2 also provides a separate, read-only
`AlpacaCryptoMarketSource` for `BTC/USD` (`CRYPTO`, Alpaca crypto, always-open,
fractional, long-only). B3 gives both assets a deterministic
`WorkerRuntimeIdentity`: worker run/lease/fencing and checkpoint state use its
`workerKey`; raw closed-bar evidence uses its asset symbol. BTC's runtime is
`READ_ONLY_DURABLE`, so it may recover bars and its checkpoint under a fenced
lease but has no broker-reconciliation or dispatch capability. SPY alone is
`DISPATCH_CAPABLE` at the equity broker boundary.

Planned interface:

interface MarketSource {
  id: string;
  bars(): AsyncIterable<ClosedBar>;
}

Initial implementations:

SyntheticMarketSource
HistoricalFileMarketSource

Later:

LiveMarketSource

The crypto adapter accepts only Alpaca's completed `bars` channel (`T: "b"`),
normalizes it into `ClosedBar` with the provider's minute-start timestamp, and
excludes later updated-bar corrections (`T: "u"`) so already-consumed data is
never revised. Its market-data WebSocket is provider-specific and separate from
the IEX protocol parser; it has no broker or order capability.
2. Feature engine

Transforms market history available at time t into deterministic quantitative state.

Examples:

log return,
EMA return signal,
EMA price,
RSI,
realized volatility,
displacement,
drawdown.

Properties:

pure where practical,
reproducible,
versioned,
tested against known fixtures,
past-only.

Feature computation must not depend on Jev or execution state unless a feature is explicitly defined as portfolio state.

3. Strategy engine

Produces candidate intent from deterministic features.

Current strategies:

EMA trend
RSI mean reversion

Output:

LONG
SHORT
FLAT

The strategy describes candidate intent only.

It does not imply that execution is authorized.

4. Jev adapter

Jev receives a bounded, already-computed market state.

Jev may classify:

regime,
setup presence,
trend conditions,
mean-reversion conditions,
market quality.

Jev must not calculate:

indicators,
P&L,
position size,
transaction costs,
slippage,
portfolio risk,
execution authority.

Jev must not directly own an order endpoint.

Adapter boundary:

interface JevAdapter {
  id: string;
  model: string;
  classify(features: FeatureVector): JevResponse;
}

Expected implementations:

MockJevAdapter
RecordedJevAdapter
TypeSafeJevAdapter

The rest of the domain must not depend on which adapter is active.

5. Router / policy

The router combines:

experiment arm,
deterministic strategy signal,
deterministic regime,
Jev classification.

It produces a desired action:

LONG
SHORT
FLAT

Current experimental arms:

A — baseline
B — deterministic strategy
C — deterministic strategy + deterministic regime gate
D — deterministic strategy + Jev gate

Policy thresholds must be versioned and included in experiment provenance.

6. Risk governor

Risk is deterministic.

It may veto requested exposure.

Examples:

incomplete warmup,
excessive realized volatility,
excessive market drawdown,
excessive paper-equity drawdown,
invalid state.

Risk may reduce:

LONG → FLAT
SHORT → FLAT

It must never transform one directional intent into its opposite.

Jev does not bypass risk.

7. Decision evidence

Decision evidence records what the system knew and decided at time t.

It must contain no future fill information.

Decision evidence is immutable after creation.

See:

docs/EVIDENCE_CONTRACT.md
8. Execution engine

Execution is independent from decision production.

A decision can create an execution intent.

An execution engine determines what happens afterward.

Current execution modes:

- `ReplayExecutionEngine` for deterministic historical/replay evaluation;
- bounded Alpaca PAPER execution for SPY.

The PAPER path is operational and has produced broker fills; it is not a
live-money path. QQQ/IWM/AAPL/MSFT and BTC/USD remain read-only durable runtimes
without broker authority.

For the bounded Alpaca PAPER engine, Postgres is also the dispatch-authority
boundary: exactly one unexpired, fenced lease for the worker key may mark a
pending intent `SUBMISSION_ATTEMPTED` or enter the final broker-submit guard.
The broker remains authoritative for execution truth; the fence only prevents
multiple worker processes from possessing submission authority.

9. Execution ledger

There must be one canonical source of truth for:

pending intents,
fills,
position transitions,
transaction costs,
slippage,
realized exposure,
equity.

Metrics must consume this ledger.

Metrics must not independently reconstruct an alternative trading history from decisions.

10. Evaluation

Evaluation consumes completed experimental artifacts.

It must not influence historical decisions.

Metrics may include:

total return,
Sharpe ratio,
Sortino ratio,
maximum drawdown,
exposure,
turnover,
trade count,
hit rate,
transaction costs,
slippage.

Jev evaluation may include:

Brier score,
calibration,
selective accuracy,
confidence buckets,
classification outcomes by regime.

Any regime ground truth must be explicitly defined as a project-specific proxy unless externally established.

Research / decision / execution separation

LIGHTLIGHT maintains three conceptual layers.

Research
What hypothesis are we testing?
Decision
What information existed at time t?
What did the system decide from it?
Execution
What happened after the decision?
At what price and timestamp did exposure actually change?

These layers must not be collapsed.

Persistence direction

The browser/terminal is an observer of authoritative research and execution
state rather than the owner of PAPER authority.

Current PAPER persistence uses durable Postgres/Neon for worker runs, leases,
checkpoints, bars, decisions, execution intents, broker-order observations,
broker-position observations, trade updates, and market-recovery evidence.

Replay/local research may still use local persistence where appropriate, but it
must not become a second competing execution ledger.

The next persistence milestone is an immutable `ExperimentRun`/session
manifest that references the existing durable evidence and records code,
configuration, strategy, dataset/session, and terminal metric identity.

Event chronology and provenance must remain explicit.

UI boundary

React is presentation.

It may:

display state,
request replay actions,
inspect evidence,
select experiment arms,
visualize metrics.

It should not own:

indicator mathematics,
strategy logic,
execution timing,
portfolio accounting,
evidence construction,
research evaluation.
Current scope

Current:

- deterministic replay and features;
- deterministic strategies, policy, and risk;
- mock Jev research boundary;
- durable SPY Alpaca PAPER execution;
- 15-minute `ema_trend` and 1-minute `ema_rsi_v1` SPY runtimes;
- broker-authoritative reconciliation and fill evidence;
- Postgres lease/fencing authority;
- live market continuity and verified gap recovery;
- bounded read-only equity runtimes for QQQ/IWM/AAPL/MSFT;
- read-only durable BTC/USD market/runtime infrastructure;
- read-only operational observer.

Near-term:

- truthful durable worker lifecycle;
- immutable PAPER experiment-session manifests;
- live-to-offline replay parity;
- exact PAPER-compatible execution timing in evaluation;
- multi-day SPY PAPER soak;
- repository/main-branch consolidation;
- controlled strategy experiments with explicit costs/turnover.

Not currently in scope:

live-money brokerage
self-modifying strategies
LLM-generated orders
unbounded autonomous execution
profitability claims
Design principle

LIGHTLIGHT should prefer:

explicit contracts
deterministic computation
reconstructable evidence
causal correctness
small experimental surfaces

over:

agent autonomy
indicator accumulation
opaque scoring
dashboard spectacle
premature live execution

The terminal is valuable only if the evidence behind it is trustworthy.
