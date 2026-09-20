# ADR 0001: Causal Fill Model

- Status: Accepted
- Date: 2026-09-19
- Decision scope: replay execution and evaluation
- Project: LIGHTLIGHT

## Context

LIGHTLIGHT produces decisions from closed market bars.

The initial prototype correctly represented paper fills as occurring at the next bar close:

```text
decision on bar t
→ fill on bar t+1 close

However, an independent evaluation path reconstructed positions directly from decision evidence and could attribute the decision generated at bar t to the return:

t → t+1

That return occurred before the declared fill.

This creates a causal inconsistency and can contaminate:

total return,
Sharpe,
Sortino,
maximum drawdown,
hit rate,
regime-conditioned returns,
strategy comparisons.

A replay system requires one explicit rule describing when information becomes exposure.

Decision

LIGHTLIGHT will use a canonical execution ledger.

For the current replay model:

A decision created after bar t closes is eligible to fill at the close of bar t+1.

Therefore:

The resulting position cannot receive exposure to the return from bar t close to bar t+1 close.

The earliest close-to-close interval attributable to that newly filled position is:

bar t+1 close
→ bar t+2 close
Canonical chronology
BAR t CLOSE
    │
    ▼
features[t]
    │
    ▼
strategy[t]
    │
    ▼
Jev[t]
    │
    ▼
policy[t]
    │
    ▼
risk[t]
    │
    ▼
DecisionEvidence[t]
    │
    ▼
ExecutionIntent[t]
    │
    │ no new exposure yet
    │
BAR t+1 CLOSE
    │
    ▼
Fill[t+1]
    │
    ▼
PositionTransition[t+1]
    │
    │ new exposure exists
    │
BAR t+2 CLOSE
    │
    ▼
first complete close-to-close return under new position
Canonical source of truth

The execution ledger owns:

fill timing,
fill price,
position state,
turnover,
transaction costs,
slippage,
equity chronology.

Evaluation code consumes the ledger.

Evaluation code must not independently infer positions from decisions using different timing semantics.

Decision evidence

Decision evidence records:

what was known
what was classified
what was requested

It does not contain future fill facts at creation time.

Execution evidence

Future execution events reference the originating decision.

Example:

decision_id = LL-...
fill_bar = t+1
fill_price = close[t+1]

Execution history may be joined to decision history without mutating the original decision record.

Position changes

Actions map initially to:

LONG  = +1
FLAT  = 0
SHORT = -1

A position changes only after its fill event.

A desired action or execution intent is not itself proof of exposure.

Final-bar decision

If bar t is the final available bar and execution requires t+1:

no fill exists

The system must not synthesize a fill or assign exposure using unavailable future data.

Costs

Transaction cost and slippage are execution properties.

They are calculated from actual position transitions.

They must be applied exactly once.

Consequences
Positive
eliminates pre-fill return attribution,
creates one accounting source of truth,
improves reproducibility,
makes replay and future paper-broker execution share a conceptual model,
lets metrics be tested directly against ledger state.
Negative
current prototype metrics must be considered unvalidated until migrated,
some existing evaluation code must be rewritten,
strategy returns may decrease or materially change,
fills, equity, and metrics require explicit event state.

These costs are intentional.

Correctness takes precedence over preserving existing prototype numbers.

Rejected alternative: decision equals immediate position

Rejected because:

the strategy uses the close of bar t,
the decision therefore cannot exist before that close,
granting exposure to the already-completed t-1 → t interval is impossible,
granting t → t+1 exposure while simultaneously declaring a t+1 close fill is internally inconsistent.
Rejected alternative: keep two accounting implementations

Rejected because separate implementations can silently diverge.

There will be one canonical execution/equity ledger.

Alternative metric calculations may inspect it but not redefine exposure timing.

Required tests
Test 1 — no pre-fill exposure

Given a decision at t and fill at t+1, changing:

close[t+1] / close[t]

must not create return under the new position before its fill.

Test 2 — post-fill exposure

Changing:

close[t+2] / close[t+1]

may affect return attributable to the position filled at t+1.

Test 3 — ledger/metrics parity
final metric equity == final ledger equity
Test 4 — risk veto

A directional policy result vetoed to FLAT by risk cannot create exposure.

Test 5 — final bar

A decision without a future eligible fill bar remains unfilled.

Test 6 — costs

Each actual transition receives exactly one configured execution-cost treatment.

Migration target

P0.2 will:

introduce canonical execution events,
route replay fills through the ledger,
route equity through the ledger,
calculate metrics from the ledger,
delete duplicated exposure reconstruction,
add causal regression tests.

No live Jev, live market feed, or broker integration should be added as part of this ADR's implementation.

Principle

A decision may explain a future position. It may not retroactively create one.