# LIGHTLIGHT Experiment Contract

## Purpose

An experiment must define enough state that its result can be reproduced, compared, rejected, or audited without relying on the UI session that created it.

LIGHTLIGHT experiments compare bounded changes while holding unrelated components fixed.

---

# Experimental question

Initial research question:

> Does typed Jev classification improve the behavior of an otherwise deterministic quantitative strategy when compared with deterministic controls under identical data, execution, risk, and evaluation assumptions?

This is not equivalent to:

> Can Jev predict markets?

And it is not equivalent to:

> Is the resulting strategy profitable?

Those require separate evidence.

---

# Experiment arms

Initial arms:

## Arm A — baseline

Reference behavior.

Current prototype:

```text
unit long / baseline

The precise baseline must be declared per experiment.

Arm B — deterministic strategy
deterministic features
→ deterministic strategy
→ risk
→ execution

No regime gate.

Arm C — deterministic regime control
deterministic features
→ deterministic strategy
→ deterministic regime classifier
→ router
→ risk
→ execution

This is the primary non-Jev regime-gating control.

Arm D — Jev regime treatment
deterministic features
→ deterministic strategy
→ Jev typed classification
→ router
→ risk
→ execution

Jev must not alter:

feature computation,
strategy mathematics,
execution model,
position sizing,
risk logic,
metric definitions.
ExperimentSpec

Conceptual schema:

type ExperimentSpec = {
  schemaVersion: string;

  experimentId: string;

  dataset: {
    id: string;
    hash: string;
    range: {
      start: number;
      end: number;
    };
  };

  strategy: {
    id: string;
    version: string;
  };

  arm: "A" | "B" | "C" | "D";

  features: {
    version: string;
  };

  policy: {
    version: string;
  };

  risk: {
    version: string;
  };

  configuration: {
    version: string;
    hash: string;
  };

  jev: {
    adapterId: string;
    modelId: string;
  };

  execution: {
    model: string;
    transactionCostBps: number;
    slippageBps: number;
  };

  randomSeed: number | null;

  codeRevision: string | null;
};
ExperimentRun

A completed run should identify:

run ID
experiment specification
start time
completion time
status
decision evidence set
execution ledger
metric set
error state

Runs are historical artifacts.

Changing code/configuration creates a new run rather than rewriting prior results.

Controlled comparison

When comparing Arm C against Arm D, the following should remain identical:

dataset
date range
feature code
strategy code
risk code
execution model
cost assumptions
slippage assumptions
position sizing
metric definitions

The meaningful treatment difference is:

deterministic regime gate
vs
Jev regime gate
Mock Jev

The existing mock Jev adapter is useful for:

UI integration,
schema testing,
deterministic fixtures,
pipeline tests.

It is not evidence of TypeSafe/Jev performance.

Comparing:

Arm C
vs
Arm D using mock Jev

means:

deterministic classifier A
vs
deterministic classifier B

Do not describe this as a Jev evaluation.

Real Jev introduction

Before enabling real Jev:

freeze deterministic Arm C,
freeze evaluation rules,
freeze execution rules,
freeze relevant thresholds or define calibration procedure,
preserve the mock adapter,
record exact TypeSafe model identity.

Do not inspect Arm D results and then modify Arm C until it looks worse.

That destroys the control.

Data partitions

Performance-oriented experiments must eventually separate data.

Minimum direction:

development
calibration
validation
final untouched OOS

Possible walk-forward form:

train/calibrate window
→ forward validation window
→ advance
→ repeat

The precise method must be documented before final evaluation.

Final OOS rule

Once final OOS is observed:

do not change thresholds and continue calling that same interval untouched,
do not discard unfavorable runs,
do not redefine metrics because of the outcome,
do not redefine regime ground truth because Jev performed poorly.

Further changes require a new experimental cycle and new untouched data.

Thresholds

Current thresholds are explicitly:

UNCALIBRATED

Examples:

EMA entry threshold,
RSI 30/70 gates,
Jev Noul floors,
Jev regime-confidence threshold,
risk-volatility cutoff,
drawdown cutoff.

A scholarly citation does not automatically validate a LIGHTLIGHT-specific threshold.

The experiment contract records the exact threshold configuration used.

Research hypothesis versus implementation

Every strategy should describe separately:

research hypothesis
paper methodology
LIGHTLIGHT implementation
LIGHTLIGHT-specific heuristic
observed result

Example:

RSI appearing as a feature in a scholarly model does not establish that:

RSI < 30 = profitable long signal

LIGHTLIGHT must preserve that distinction.

Regime labels

Current Jev evaluation uses a project-defined future outcome proxy.

This is acceptable for an explicitly scoped experiment.

It must be described as:

LIGHTLIGHT proxy regime label

not:

objective market regime ground truth

The proxy algorithm requires its own version.

Changing the proxy creates a different evaluation.

Metrics

Trading-path metrics may include:

total return
Sharpe ratio
Sortino ratio
max drawdown
turnover
exposure
trade count
hit rate
transaction costs
slippage

Jev-specific metrics may include:

Brier score
classification accuracy
confidence calibration
selective accuracy
abstention
latency
classification cost
performance conditional on predicted regime

Trading return alone is not sufficient evidence that Jev classification is useful.

Classification quality alone is not sufficient evidence that a trading strategy is useful.

Evaluate both.

Multiple comparisons

As strategies, parameters, assets, and timeframes increase, false discovery risk increases.

LIGHTLIGHT should track:

experiments attempted
parameter sets attempted
datasets inspected
failed experiments

Do not preserve only successful configurations.

Costs

Zero-cost replay is diagnostic only.

Before meaningful market-performance claims, include:

transaction fees,
spread assumptions where relevant,
slippage,
turnover sensitivity.

Run cost sensitivity rather than choosing only a favorable assumption.

Reproducibility

A reproducible experiment requires:

dataset identity
configuration identity
source-code identity
model identity
execution-model identity
experiment specification

If one cannot be recovered, explicitly mark the run as partially reproducible.

Failure semantics

An experiment can end as:

COMPLETED
FAILED
INVALID
INCONCLUSIVE

Examples:

FAILED

API unavailable
storage failure
runtime failure

INVALID

future leakage discovered
dataset corruption
wrong execution timing
configuration provenance missing

INCONCLUSIVE

insufficient observations
confidence intervals too broad
treatment effect unstable

Do not force every experiment into success/failure based solely on return.

Initial experiment sequence

Recommended progression:

EXP-0001
Causal replay correctness

EXP-0002
Deterministic EMA baseline on declared historical dataset

EXP-0003
Deterministic regime-gating ablation

EXP-0004
Real Jev regime-gating ablation

EXP-0005
Walk-forward replication with costs

Exact IDs can change, but causal correctness precedes model comparison.

Principle

Change one meaningful thing, preserve everything else, and retain enough evidence to prove what actually changed.