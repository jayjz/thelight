# LIGHTLIGHT Roadmap

## Mission

Build a causally correct, evidence-producing quantitative research terminal for testing deterministic strategies and bounded Jev classifications against reproducible market data.

The roadmap prioritizes correctness and experimental integrity before live connectivity.

---

# P0 — Prototype baseline

Status: implemented, requires hardening.

Current capabilities:

- seeded synthetic candles,
- deterministic quantitative features,
- EMA trend candidate strategy,
- RSI mean-reversion candidate strategy,
- deterministic market regime,
- mock Jev adapter,
- experiment arms A–D,
- deterministic risk governor,
- replay terminal,
- evidence inspection,
- basic evaluation metrics.

Known limitations:

- synthetic data,
- in-sample results,
- mock Jev,
- uncalibrated thresholds,
- zero transaction costs,
- zero slippage,
- evidence primarily browser-memory state,
- exported Grok platform scaffolding,
- execution/evaluation timing mismatch identified during audit.

---

# P0.2 — Causal execution foundation

Priority: immediate.

## Goal

Establish one canonical execution model from which all positions, equity, fills, and performance metrics derive.

## Work

- define `ExecutionIntent`,
- define `Fill`,
- define `PositionTransition`,
- define `EquityPoint`,
- implement canonical execution ledger,
- remove duplicate P&L reconstruction,
- fix next-bar-close timing,
- apply transaction costs through execution,
- apply slippage through execution,
- derive metrics from ledger only.

## Hard invariant

A decision based on closed bar `t` cannot receive exposure to the return from `t` to its declared fill at `t+1`.

## Acceptance criteria

Tests prove:

```text
decision[t] cannot affect P&L before fill[t+1]
fill[t+1] can affect subsequent returns
risk veto cannot create exposure
metrics equity equals ledger equity
costs are applied exactly once
slippage is applied exactly once

No real market data or real Jev integration during this phase.

P0.3 — Evidence contract
Goal

Make every decision independently interpretable and reproducible.

Implement:

EvidenceEnvelope
DecisionEvidence
ExecutionRecord

Required provenance:

schema version,
decision ID,
timestamp,
dataset ID,
dataset hash,
feature version,
strategy version,
policy version,
risk version,
configuration version,
configuration hash,
Jev adapter ID,
Jev model ID,
research references,
source code revision where available.

Decision evidence must not be retroactively mutated with future fills.

Execution events reference decision IDs.

Acceptance criteria

Given:

dataset
configuration
source revision
decision evidence

the deterministic portion of a historical decision can be reconstructed.

P0.4 — Durable replay storage
Goal

Move research state out of transient browser memory.

Initial storage:

SQLite

Target records:

datasets
bars
experiment_runs
decisions
jev_calls
execution_intents
fills
positions
equity

Requirements:

append-oriented event history,
schema versioning,
deterministic IDs where appropriate,
explicit foreign-key relationships,
no silent overwriting of historical experiment state.

The terminal should consume persisted/replayable state through a data interface.

P0.5 — Repository cleanup
Goal

Separate LIGHTLIGHT from unnecessary Grok Build substrate.

Audit:

.grok/
src/lib/auth/
src/lib/app-data/
src/lib/multiplayer/
preview bridge files
generic database plumbing
server scaffolding

Remove only after determining actual runtime dependencies.

Also:

rename package from generic builder name,
add .env.example,
tighten .gitignore,
remove generated logs,
remove local deployment metadata where unnecessary,
create normal project README,
document supported development commands.

Do not mix repository cleanup with quantitative behavior changes unless required.

P1 — Market-source abstraction
Goal

Make replay independent of synthetic data generation.

Contract:

interface MarketSource {
  id: string;
  bars(): AsyncIterable<ClosedBar>;
}

Implement:

SyntheticMarketSource
HistoricalFileMarketSource

Each source must define:

timezone,
timestamp semantics,
bar-close semantics,
symbol identity,
timeframe,
missing-bar behavior,
dataset hash,
provenance.
P1.1 — Real historical dataset

Initial target:

SPY
1D

Reason:

Daily data reduces market-microstructure complexity while data, causal, and evaluation contracts are validated.

Required handling:

adjusted vs unadjusted prices explicitly declared,
corporate actions documented,
session calendar explicit,
missing sessions explicit,
duplicate bars rejected,
timestamps normalized,
provenance stored.

No optimization against final OOS data.

P1.2 — Experiment runner
Goal

Separate experimental execution from UI state.

Define:

ExperimentSpec
ExperimentRun

ExperimentSpec should identify:

dataset,
date range,
strategy,
experiment arm,
thresholds,
Jev adapter,
feature version,
policy version,
risk version,
fill model,
costs,
slippage,
random seed where applicable.

ExperimentRun produces:

decision evidence,
execution ledger,
metrics,
provenance,
run ID.

A run must be reproducible from its specification and immutable inputs.

P2 — Real TypeSafe Jev
Goal

Replace the mock adapter without changing downstream contracts.

Add:

TypeSafeJevAdapter

Keep:

MockJevAdapter
RecordedJevAdapter

Requirements:

API credentials server-side only,
model ID recorded,
exact request stored,
exact typed response stored,
latency stored,
API/schema failure distinguishable from valid negative classification,
timeout behavior explicit,
no automatic fallback masquerading as real Jev.

Freeze deterministic Arm C before evaluating live Arm D.

Compare:

A — baseline
B — deterministic strategy
C — deterministic strategy + deterministic regime
D — deterministic strategy + TypeSafe Jev

The treatment must not alter features, risk, execution, or accounting.

P2.1 — Jev evaluation

Evaluate Jev separately from trading P&L.

Potential metrics:

Brier score,
classification accuracy against declared proxy,
calibration curves,
confidence buckets,
selective accuracy,
abstention behavior,
classification stability,
latency,
cost per classification.

Any proxy regime labeling algorithm must be versioned and documented.

Do not call proxy-label calibration general model calibration.

P3 — Transaction-cost model

Replace zero-cost assumptions.

Implement explicit:

commission,
spread,
slippage,
turnover costs.

All assumptions versioned.

Run sensitivity analysis across plausible cost ranges rather than reporting a single favorable assumption.

P3.1 — Walk-forward evaluation
Goal

Move from diagnostic replay to valid out-of-sample experimentation.

Dataset separation:

development
calibration
validation
final untouched OOS

Rules:

thresholds may change during development,
calibration rules must be declared,
final OOS is evaluated once under frozen configuration,
failed experiments are retained,
experiment metadata is persisted,
no retrospective threshold adjustment against final OOS.

Support rolling / walk-forward experiments.

P4 — Intraday historical data

After daily-data correctness:

SPY 15m

Additional concerns:

exchange sessions,
half days,
timezone/DST handling,
gaps,
overnight returns,
volume semantics,
spread assumptions,
timestamp boundaries.

Do not add indicators merely because higher-resolution data is available.

P5 — Live market observation
Goal

Make the terminal genuinely live without adding brokerage authority.

Implement:

LiveMarketSource

Backend emits domain events such as:

BAR_CLOSED
FEATURES_COMPUTED
SIGNAL_GENERATED
JEV_REQUESTED
JEV_COMPLETED
POLICY_COMPLETED
RISK_COMPLETED
DECISION_WRITTEN

Frontend subscribes and visualizes.

The backend remains authoritative.

No partial/incomplete candle may be treated as closed unless explicitly supported by a separate experimental mode.

P5.1 — Live terminal

UI evolves from replay-only to replay/live observation.

Display:

market source,
connection health,
latest closed bar,
feature state,
strategy signal,
Jev typed classification,
policy result,
risk result,
evidence ID,
experiment/config version.

Historical evidence remains inspectable.

P6 — Paper broker
Goal

Test execution against a real paper-broker environment.

Execution interface:

ExecutionPort
├── ReplayExecution
└── PaperBrokerExecution

Requirements:

idempotent order identity,
broker-authoritative state reconciliation,
uncertain submission handling,
explicit rejection handling,
recovery after process restart,
execution evidence,
no assumption that client-side intent equals broker state.

Paper trading only.

P7 — Multi-asset research

Only after the single-asset pipeline is validated.

Potential additions:

cross-sectional mean reversion,
residual/factor strategies,
multiple simultaneous symbols,
portfolio exposure,
covariance-aware risk.

This is where Kakushadze-style cross-sectional methodology becomes substantially more appropriate than the current single-series heuristic.

Deferred

Explicitly deferred until earlier contracts are sound:

live-money trading,
strategy self-modification,
automatic parameter optimization,
large indicator libraries,
reinforcement-learning execution,
autonomous model-generated strategies,
model-controlled risk limits.
Immediate next milestone
P0.2 — canonical execution ledger + causal metrics + regression tests

Do not add live data, TypeSafe Jev, or brokerage connectivity until P0.2 passes.