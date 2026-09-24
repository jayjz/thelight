# LIGHTLIGHT Roadmap

## Mission

Build a causally correct, evidence-producing quantitative research system that can run bounded PAPER experiments, preserve enough state to reconstruct every decision and execution event, and compare deterministic or typed-model treatments without collapsing research, risk, and broker authority.

This roadmap reflects repository state as of **2026-09-24**. Older phase descriptions that treated live observation and PAPER brokerage as future work are superseded by the status below.

---

## Current baseline

### Proven in repository and PAPER operation

- deterministic feature and strategy pipelines;
- replay/evaluation foundations;
- immutable decision evidence;
- durable Postgres PAPER evidence;
- Alpaca IEX market-data ingestion;
- local bounded equity relay contract;
- market-gap detection, historical recovery, and provenance;
- Alpaca PAPER broker reconciliation;
- deterministic client-order identity;
- durable `SUBMISSION_ATTEMPTED` marker;
- Postgres lease ownership and monotonic fencing;
- restart/recovery semantics that fail closed on uncertainty;
- broker trade-update ingestion;
- broker-authoritative fill projection;
- SPY 15-minute `ema_trend` PAPER path;
- SPY 1-minute `ema_rsi_v1` PAPER path;
- bounded read-only equity runtimes for QQQ, IWM, AAPL, and MSFT;
- read-only durable BTC/USD runtime and crypto market-data adapter;
- read-only operational observer;
- Vercel/web isolation from long-lived worker authority.

The September 22, 2026 SPY PAPER run produced actual PAPER fills and durable execution evidence. It also exposed strategy churn and several evidence/operational issues that now drive the next milestones.

---

# P0 — Research and causal contracts

**Status: substantially implemented**

The project has deterministic features, strategies, policy/risk boundaries, replay foundations, evidence contracts, and explicit causal rules.

Remaining cleanup:

- reconcile older documentation with current runtime behavior;
- ensure evaluation timing matches observed PAPER execution semantics;
- continue separating research claims from implementation heuristics.

---

# P1 — Bounded PAPER execution foundation

**Status: implemented and live-tested**

Implemented:

- durable worker runs and checkpoints;
- Alpaca PAPER account/position/open-order reconciliation;
- append-oriented broker order and position observations;
- `trade_updates` persistence;
- deterministic order/client identity;
- uncertain-submission recovery;
- `UNKNOWN` fail-closed behavior;
- `SUBMISSION_ATTEMPTED` crash-window protection;
- single-owner Postgres lease;
- monotonic fencing token;
- final pre-POST authority check;
- market-data continuity and verified gap recovery;
- PAPER equity/drawdown evidence;
- SPY PAPER order/fill path.

Recent hardening:

- fill projection now treats Alpaca `fill` as terminal;
- delayed nonterminal broker observations cannot regress a terminal intent;
- duplicate/replayed fills remain idempotent;
- stale fencing cannot apply execution projection or gain POST authority.

### Lifecycle follow-through

The prior durable lifecycle persistence defect was fixed on `main`. Retain
multi-session soak validation for READY, STOPPED, HALTED and takeover evidence;
this is operational verification, not an open reason to change authority.

---

# P2 — Reproducible PAPER experiment harness

**Status: next major milestone**

## Goal

Turn a live PAPER session into a first-class immutable experiment artifact without duplicating existing durable evidence.

Implement an `ExperimentRun`/session manifest that records or references:

- experiment/run ID;
- worker run ID;
- source-code revision;
- strategy ID/version;
- symbol and timeframe;
- configuration identity/hash;
- market-data source/provenance;
- start/end timestamps;
- starting/ending PAPER equity;
- decision IDs;
- execution-intent IDs;
- broker order/fill references;
- recovery/halt events;
- terminal experiment status;
- derived metrics.

The manifest should reference existing append-oriented evidence rather than copy it into a second competing ledger.

### Acceptance criteria

A completed PAPER session can be exported and audited without relying on the terminal/observer process that happened to be open during the session.

---

# P2.1 — Live-to-offline parity

**Status: required before strategy optimization**

## Goal

Replay an observed PAPER session from frozen bars and reproduce its deterministic decisions exactly.

Require parity for:

- feature warmup;
- EMA/RSI values;
- strategy target;
- risk-approved target;
- decision timestamps;
- transition count;
- dispatch eligibility.

The evaluator must then encode the execution timing actually used by PAPER. Live observation on September 22 showed decisions after a completed minute followed by PAPER fills near the start of the next minute; do not compare PAPER results with a materially different historical fill convention.

### Acceptance criteria

For a frozen PAPER session:

```text
live deterministic target sequence == replay deterministic target sequence
```

and any modeled fill difference is explicit, versioned, and attributable to the execution model.

---

# P3 — Strategy research with costs

**Status: blocked on P2/P2.1**

The `ema_rsi_v1` run demonstrated that execution works but the initial 1-minute heuristic can churn around small EMA crossings.

Do not retrospectively tune September 22 until it becomes profitable.

Freeze candidate experiments prospectively. Initial controlled variants may test one change at a time:

- minimum EMA separation;
- multi-bar entry confirmation;
- minimum hold interval;
- post-exit cooldown;
- explicit transaction-cost/turnover gate.

Metrics must include at least:

- return;
- Sharpe/Sortino where sample size supports them;
- max drawdown;
- exposure;
- round trips;
- hit rate;
- turnover;
- average/median hold;
- signal flips;
- gross winner/loss totals;
- profit factor;
- modeled spread/slippage sensitivity.

Use chronological development/validation partitions and retain failed experiments.

### BTC research slice

`btc_momentum_v1` is a separate, read-only BTC/USD minute-bar experiment. Its
first frozen, cost-aware result is retained as a failure; it grants no broker
authority and is not evidence for PAPER activation. See
[BTC Momentum V1](experiments/BTC_MOMENTUM_V1.md). Future BTC candidates require
a new strategy identity, wider verified data and a prospective OOS contract.

---

# P4 — Operational hardening and soak

**Status: partially complete**

Before treating the worker as a routine PAPER experiment service:

- repair durable lifecycle-state persistence;
- make no-position-change observer semantics explicit;
- add/verify exchange-calendar behavior beyond the weekday/time heuristic;
- verify graceful stop, crash, lease expiry, takeover, reconnect, and reconciliation over multiple sessions;
- complete multi-day SPY PAPER soak;
- preserve exact operator and recovery evidence.

---

# P5 — Bounded multi-equity evidence

**Status: implementation exists; infrastructure validation incomplete**

Bounded universe:

- SPY;
- QQQ;
- IWM;
- AAPL;
- MSFT.

Only SPY is dispatch capable.

QQQ/IWM/AAPL/MSFT remain `READ_ONLY_DURABLE`.

Before a five-symbol evidence soak, prove the local relay can merge explicit downstream symbol requests into one bounded Alpaca upstream subscription. Do not open multiple upstream Alpaca equity sockets as a workaround.

---

# P6 — Portfolio PAPER authority

**Status: deferred**

Do not grant non-SPY broker authority until there is an explicit account/portfolio control plane for:

- gross exposure;
- per-symbol exposure;
- buying power;
- simultaneous intent arbitration;
- account-level drawdown;
- cross-symbol open orders;
- duplicate/correlated exposure.

This is a separate execution milestone, not an incidental flag change.

---

# P7 — Crypto PAPER execution

**Status: continuous read-only observation implemented; PAPER execution deferred until observation soak**

Completed for BTC/USD:

- B0: freeze SPY behavior;
- B1: explicit asset/runtime contract;
- B2: read-only Alpaca crypto market-data adapter;
- B3: independent durable runtime identity, lease, checkpoint, and evidence namespace;
- continuous BTC/USD observer/runtime via `btc:worker -- start` and `btc:observe`;
- durable lifecycle, owned checkpoint, bounded reconnect and restart evidence;
- explicit 24/7 operational freshness;
- bounded sparse BTC bootstrap recovery that qualifies only a recent contiguous
  60-minute suffix, exact live-gap recovery, complete pagination,
  LIVE_WS/REST_BACKFILL provenance, fenced completion and VERIFIED continuity;
- valid zero-volume bars and fail-closed incomplete/conflicting live recovery, with
  active/last recovery evidence in the observer.

Recovery is limited to 24 hours; older history and provider revisions are not
automatically certified or overwritten. See the historical contract and failure
semantics in [BTC runtime](BTC_PAPER_RUNTIME.md#verified-historical-recovery).

Run the [24h/72h observation soak](BTC_PAPER_RUNTIME.md#24h--72h-soak-procedure)
before the next BTC milestone: PAPER execution. Stop with SIGINT/SIGTERM. BTC
remains `READ_ONLY_DURABLE / MARKET_EVIDENCE_ONLY`, with zero broker authority.

Not implemented:

- fractional broker execution;
- BTC broker reconciliation;
- BTC-specific risk/cost calibration;
- 24/7 execution soak.

Keep BTC read-only until the single-asset PAPER research loop is reproducible and operationally stable.

---

# P8 — Typed-model / Jev experiments

**Status: deferred behind deterministic controls**

The model may classify bounded supplied state but must not own:

- indicator calculation;
- position sizing;
- P&L;
- transaction costs;
- risk limits;
- dispatch.

Before evaluating a real Jev treatment:

- freeze deterministic control behavior;
- freeze execution rules;
- freeze evaluation rules;
- preserve exact request/response evidence;
- evaluate model classification quality separately from trading P&L.

---

# Repository cleanup

**Status: needed, not a trading-runtime blocker**

The integration branch has accumulated the current execution/runtime work while `main` remains behind it. Consolidate the proven integration baseline onto `main`, then remove merged stale branches.

Dependency-audit inherited builder substrate before deleting it:

- `.grok/`;
- auth/app-data/multiplayer support;
- preview bridge files;
- generic server/database scaffolding;
- Grok PWA test utilities.

Also rename the generic package name `app-builder-workspace` when the dependency boundary is understood.

Do not mix this cleanup with strategy changes.

---

# Immediate sequence

1. Durable `worker_runs` lifecycle truth.
2. Immutable PAPER experiment-session manifest.
3. Live-to-offline replay parity and exact execution-timing model.
4. Observer no-op semantics and operational soak hardening.
5. Consolidate integration branch to `main`; prune merged branches.
6. Prospectively defined SPY strategy experiments with costs.
7. Five-symbol read-only soak after relay subscription-union proof.
8. Portfolio PAPER authority only after explicit portfolio risk/arbitration design.
9. BTC PAPER execution later.
10. Typed-model/Jev treatments only after deterministic controls are stable.

## Principle

Change one meaningful thing, preserve everything else, and retain enough evidence to prove what actually changed.
