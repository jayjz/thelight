# LIGHTLIGHT Evidence Contract

## Purpose

LIGHTLIGHT must preserve enough information to answer:

> What did the system know, what did it decide, why did it decide it, and what happened afterward?

Evidence exists to make experiments:

- inspectable,
- reproducible,
- independently evaluable,
- resistant to retrospective reinterpretation.

Evidence is not merely UI state.

---

# Evidence classes

LIGHTLIGHT separates evidence into two principal classes:


DecisionEvidence
ExecutionEvidence

This distinction is mandatory.

A decision cannot contain facts that did not yet exist when that decision was made.

DecisionEvidence

DecisionEvidence describes information available at the decision timestamp and the resulting system decision.

Conceptual schema:

type DecisionEvidence = {
  schemaVersion: string;

  decisionId: string;
  experimentRunId: string;

  timestamp: number;
  barIndex: number;

  dataset: {
    id: string;
    hash: string;
    symbol: string;
    timeframe: string;
    source: string;
  };

  code: {
    revision: string | null;
  };

  marketSnapshot: Candle;

  features: {
    version: string;
    values: FeatureVector;
  };

  strategy: {
    id: string;
    version: string;
    signal: Signal;
  };

  jev: {
    adapterId: string;
    modelId: string;
    request: JevRequest;
    response: JevResponse;
    latencyMs: number | null;
  };

  policy: {
    version: string;
    result: PolicyEvaluation;
  };

  risk: {
    version: string;
    result: RiskEvaluation;
  };

  configuration: {
    version: string;
    hash: string;
  };

  action: "LONG" | "SHORT" | "FLAT";

  researchRefs: string[];
};

Exact TypeScript may differ, but equivalent information must be preserved.

ExecutionEvidence

Execution is subsequent history.

It must not be inserted retroactively into immutable decision evidence.

Conceptual schema:

type ExecutionRecord = {
  schemaVersion: string;

  executionId: string;
  decisionId: string;
  experimentRunId: string;

  intentTimestamp: number;

  status:
    | "PENDING"
    | "FILLED"
    | "REJECTED"
    | "CANCELLED"
    | "UNKNOWN";

  requestedAction: "LONG" | "SHORT" | "FLAT";

  fillTimestamp: number | null;
  fillBarIndex: number | null;
  fillPrice: number | null;

  positionBefore: number;
  positionAfter: number | null;

  transactionCost: number | null;
  slippage: number | null;

  executionModel: string;
};

Future paper-broker records may add broker IDs and reconciliation metadata.

Evidence chronology

For a replay bar t:

bar t closes
    ↓
features[t]
    ↓
strategy[t]
    ↓
Jev classification[t]
    ↓
policy[t]
    ↓
risk[t]
    ↓
DecisionEvidence[t]
    ↓
execution intent
    ↓
future fill event
    ↓
ExecutionEvidence

A future fill must never appear as if it were known at DecisionEvidence[t] creation time.

Evidence immutability

Once persisted, historical decision evidence should be treated as immutable.

Corrections require:

new schema versions,
new experiment runs,
explicit migration where appropriate.

Do not silently update prior research outcomes because:

thresholds changed,
code changed,
a newer model exists,
a different dataset was loaded.
Configuration provenance

A version string alone is insufficient.

Each experiment must identify the exact configuration used.

Configuration includes relevant values such as:

EMA timescale,
RSI period,
volatility window,
regime thresholds,
Jev probability gates,
risk limits,
fill model,
transaction costs,
slippage.

Persist:

configuration version
configuration hash

The canonical configuration used to calculate the hash must remain retrievable.

Recommended process:

canonical JSON serialization
→ cryptographic hash
→ configHash

Do not depend on ordinary object iteration where canonical ordering is ambiguous.

Dataset provenance

Every experiment dataset must have an identity independent of its display symbol.

Minimum metadata:

dataset ID
dataset hash
symbol
timeframe
source/vendor
start timestamp
end timestamp
bar count
price adjustment policy
timezone

Synthetic datasets additionally record:

generator version
seed

Changing one bar creates a logically different dataset.

Code provenance

Where available, record the Git commit SHA that produced an experiment.

Example:

3f7cd1c4e29c17b75e00a7487dc7bafd58d9a694

Dirty working trees must not be silently represented as if they exactly match that commit.

If experiments are permitted from dirty trees, store that state explicitly.

Jev evidence

A Jev evaluation must preserve:

adapter ID
model ID
request state
questions
typed response
request ID
latency
error state where applicable

Do not persist only the chosen regime.

Probability distributions and typed answers are part of the evidence.

Model failure

These states must remain distinguishable:

valid classification
timeout
transport failure
schema failure
authentication failure
rate limit
adapter disabled

Do not convert failures into:

ambiguous
FLAT
mock response

without preserving the actual failure condition.

A downstream deterministic policy may choose FLAT after failure, but evidence must record why.

Research provenance

Each strategy should link to its relevant research references.

Example:

arXiv:1308.5658

A citation does not imply that LIGHTLIGHT exactly reproduces the cited method.

Documentation must distinguish:

paper method
LIGHTLIGHT adaptation
project heuristic
observed experiment result
Evidence completeness

Decision evidence is complete when another implementation can determine:

what bar closed,
what data was visible,
what features were calculated,
what strategy result existed,
what Jev saw,
what Jev returned,
what policy did,
what risk did,
what action was requested,
what versions/configuration produced those results.

Execution evidence is complete when another implementation can determine:

what decision caused the intent,
when execution became eligible,
whether it filled,
the actual simulated/broker fill,
position before and after,
costs,
slippage,
execution status.
Hashing direction

Future evidence may include hashes such as:

marketSnapshotHash
featureHash
decisionHash
configHash
datasetHash

Hashing is useful for integrity and identity.

Hash presence alone does not prove semantic correctness.

Storage

Sprint target:

SQLite

Potential tables:

datasets
experiment_runs
bars
decisions
jev_calls
execution_intents
fills
positions
equity

The physical schema may normalize fields while the logical evidence contract remains stable.

Evidence and UI

The terminal may render a convenient projection.

The evidence drawer must not be the authoritative evidence store.

UI formatting must never alter persisted numerical values.

Required tests

The evidence system should eventually prove:

same deterministic inputs → same deterministic decision evidence
decision evidence contains no future bars
decision evidence contains exact config identity
dataset mutation changes dataset identity
config mutation changes config identity
execution references an existing decision
fill timestamp cannot precede decision timestamp
risk veto is preserved in evidence
Jev failure cannot masquerade as successful Jev classification
Principle

Evidence should preserve history, not rewrite it into a cleaner story afterward.