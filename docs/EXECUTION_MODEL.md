# LIGHTLIGHT Execution Model

## Purpose

This document defines when a LIGHTLIGHT decision becomes economic exposure.

The execution model is the canonical source for:

- fills,
- positions,
- costs,
- slippage,
- equity,
- performance metrics.

Metrics must not implement a second, independent interpretation of execution timing.

---

# Current replay assumption

LIGHTLIGHT evaluates strategies using closed bars.

For decision bar `t`:

```text
bar t closes
→ features calculated from data through t
→ strategy calculated
→ Jev classification calculated
→ policy evaluated
→ risk evaluated
→ execution intent created

The current replay model assumes:

An intent created after bar t closes may fill at the close of bar t+1.

This is a deliberately conservative and simple placeholder execution assumption.

It is not intended to model realistic intrabar execution.

Causal timing

Suppose closes are:

C[t-1]
C[t]
C[t+1]
C[t+2]

The system observes C[t].

It decides after C[t].

The declared fill occurs at C[t+1].

Therefore the newly selected position cannot earn:

C[t] → C[t+1]

because the fill does not exist until C[t+1].

The earliest subsequent close-to-close return attributable to the new position is:

C[t+1] → C[t+2]

This is the core causal invariant.

State transitions

Execution should follow:

Decision
    ↓
ExecutionIntent
    ↓
Pending
    ↓
Fill
    ↓
PositionTransition
    ↓
Equity accrual

Not:

Decision
    ↓
immediate retrospective exposure
Canonical ledger

Implement one ledger containing ordered execution state.

Conceptually:

type ExecutionIntent = {
  intentId: string;
  decisionId: string;
  createdAtBar: number;
  desiredPosition: number;
};

type Fill = {
  fillId: string;
  intentId: string;
  decisionId: string;
  fillBarIndex: number;
  fillTimestamp: number;
  fillPrice: number;
  positionBefore: number;
  positionAfter: number;
  transactionCost: number;
  slippage: number;
};

type PositionPoint = {
  barIndex: number;
  position: number;
};

type EquityPoint = {
  barIndex: number;
  equity: number;
  periodReturn: number;
  positionApplied: number;
};

Exact implementation types may evolve.

Chronology may not.

Position convention

Initial position mapping:

LONG  → +1
FLAT  →  0
SHORT → -1

Position size remains deterministic.

Jev does not set position size.

Decision versus position

A desired action is not synonymous with actual position.

Example:

strategy wants LONG
Jev gate passes
policy wants LONG
risk vetoes
actual intent = FLAT

Or:

intent LONG
fill not yet occurred
actual position remains previous position

The ledger must preserve both distinctions.

Fill model

Initial replay model:

NEXT_BAR_CLOSE

Properties:

decision created from closed bar t,
fill eligibility occurs at t+1,
fill price = close of t+1,
new position begins after that fill,
no fill exists after the final dataset bar.

This model must be named and versioned.

Future models may include:

NEXT_BAR_OPEN
VWAP
PAPER_BROKER

but results from different fill models must never be mixed without explicit labeling.

Transaction costs

Costs belong to execution.

Do not subtract costs inside strategy logic.

A transaction cost should be associated with a position transition.

Example:

0 → +1
+1 → 0
+1 → -1

A reversal may imply larger turnover than a close.

Cost calculation must happen exactly once.

Slippage

Slippage also belongs to execution.

Current configuration may be:

0 bps

but a configured slippage value must actually affect the ledger.

Do not expose a slippage setting that has no economic effect.

Position reversal

A direct transition:

LONG → SHORT

is:

+1 → -1

Absolute turnover:

2

The execution model must make explicit whether that is represented as:

one reversal fill,
close + open pair.

Metrics must not count it inconsistently.

Risk

Risk executes before creation of the final execution intent.

Example:

policy desired = LONG
risk target = FLAT

Execution receives:

FLAT

not:

LONG + veto metadata

Decision evidence retains both policy and risk states.

Final bar

If a decision occurs on the final available replay bar and the fill model requires a future bar:

no fill occurs

Do not synthesize a future price.

The intent may remain:

PENDING / UNFILLED

depending on experiment semantics.

Metrics

All portfolio metrics must derive from the canonical ledger.

Examples:

total return,
maximum drawdown,
turnover,
exposure,
trade count,
hit rate,
Sharpe,
Sortino.

Forbidden architecture:

pipeline computes one equity history
evaluate.ts independently reconstructs another

Required architecture:

execution ledger
       │
       ├──► equity
       ├──► metrics
       ├──► terminal
       └──► evidence
Known prototype defect

The initial Grok-exported prototype records fills at:

bar t+1 close

while its independent evaluation path can attribute the position to:

return from t → t+1

This is causally inconsistent.

P0.2 exists to remove that mismatch.

Historical prototype metrics must not be interpreted as validated strategy performance until this is corrected.

Required regression tests
No pre-fill exposure

Changing the return between decision and declared fill must not change P&L attributable to the new position.

Post-fill exposure

Changing a return after the fill may change P&L.

Ledger parity
reported equity == canonical execution-ledger equity
Risk veto

A vetoed directional policy cannot create directional exposure.

Costs once

Transaction costs are neither omitted nor double-counted.

Slippage once

Slippage is neither omitted nor double-counted.

Final-bar behavior

No future bar means no impossible fill.

Future mutation

Changing bars strictly after decision t cannot alter:

features[t],
signal[t],
Jev request[t],
policy[t],
risk[t].

It may alter later execution/evaluation outcomes where causally appropriate.

Future paper broker

The future paper-broker engine must preserve the same logical boundary:

decision
≠
broker submission
≠
broker acknowledgement
≠
fill
≠
position

Broker state becomes authoritative for broker execution.

A deterministic client order ID is identity, not proof that an order was accepted.

Unknown/uncertain submission state must not be interpreted as rejection or absence.

Principle

A strategy earns only the returns that occur after it actually has exposure.