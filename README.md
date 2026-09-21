# LIGHTLIGHT

LIGHTLIGHT (thelight) is an evidence-driven quantitative research system with a
bounded Alpaca PAPER execution worker. It is designed to make market research
inspectable and reproducible, not to make performance claims or provide a
live-trading path.

## Research thesis

Deterministic quantitative signals should remain independently reproducible.
Typed model outputs may assist regime classification or strategy gating, while
the deterministic system retains decision, risk, and execution authority.

```text
market data
  -> deterministic features
  -> candidate strategy
  -> typed classification
  -> deterministic router
  -> deterministic risk
  -> PAPER execution
  -> durable evidence
```

The model does **not** calculate indicators, position sizing, or P&L, and it
does not receive independent free-form BUY/SELL authority. Its input and typed
response are retained as evidence alongside the deterministic decision path.

## Current scope and safety boundaries

- The worker is PAPER-only, single-symbol (`SPY`), and derives decisions from
  closed 1-minute bars aggregated into completed 15-minute buckets.
- Causal timing is a core invariant: a decision can use only information
  available at its timestamp and cannot receive exposure to an already-known
  return.
- Durable Neon/Postgres evidence records decision inputs, intent, broker
  observations, and reconciliation history. Broker account, position, and open
  order state are authoritative before dispatch.
- `UNKNOWN` and `SUBMISSION_ATTEMPTED` states fail closed. A restart reconciles
  the deterministic client-order identity; it never treats uncertainty or an
  absent lookup as permission to submit again.

## Local setup

Use Node.js 22 and the checked-in lockfile.

```sh
npm ci
cp .env.example .env
npm run dev
```

Keep credentials in the untracked `.env` file. `DATABASE_URL` is required for
the durable PAPER worker to receive dispatch authority; without it, the worker
halts before it can submit an order.

## Development and verification

```sh
npm run typecheck
npm run lint
npm run test:lightlight
npm run build
```

`npm run test:lightlight` is the CI-aligned application suite: deterministic
research, execution, Alpaca PAPER boundary, and worker-invariant tests. The
repository also retains `npm test`, which runs inherited platform/scaffold tests
in addition to the application tests.

`npm run build` is safe without `DATABASE_URL`: its migration step explicitly
skips when no database URL is configured.

## Alpaca PAPER worker

With PAPER credentials and a durable `DATABASE_URL` configured, start the
session-owned worker with:

```sh
npm run alpaca:worker -- start
```

The read-only operational smoke command authenticates, reconciles, and observes
a SPY bar without submitting an order:

```sh
npm run alpaca:worker:smoke -- --observe-only
```

For a compact, read-only stream of the worker's durable PAPER evidence in a
separate terminal window, run:

```sh
npm run alpaca:observe
```

The observer requires only `DATABASE_URL`; it does not connect to Alpaca or
need Alpaca credentials. Use `-- --once`, `-- --interval 2`, or `-- --verbose`
for a one-shot snapshot, a custom polling interval, or decision reasons.

The worker and smoke commands are intentionally excluded from CI. See the
[Alpaca PAPER worker guide](docs/ALPACA_PAPER_WORKER.md) for operator controls,
the explicit dispatch procedure, and its fail-closed recovery behavior.

## Web deployment boundary

Vercel serves the UI and web-server boundary only. The persistent Alpaca PAPER
worker belongs on a separate always-on host and is never started by a Vercel
build, request, or server function. See the [Vercel deployment guide](docs/VERCEL_DEPLOYMENT.md)
for the environment-variable matrix and deployment procedure.

## Limitations

- PAPER only; no live-money execution path.
- SPY only.
- Regular-hours eligibility uses a weekday/time heuristic, not a complete
  exchange calendar.
- Strategy thresholds are research heuristics, not validated production alpha.
- Deployment and market-hours soak testing remain pending.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — boundaries, deterministic pipeline,
  and causal invariant.
- [Evidence contract](docs/EVIDENCE_CONTRACT.md) — decision/execution evidence,
  provenance, and immutability.
- [Alpaca PAPER worker](docs/ALPACA_PAPER_WORKER.md) — authority, reconciliation,
  persistence, and operator controls.
- [Vercel deployment](docs/VERCEL_DEPLOYMENT.md) — web/worker boundary and
  deployment environment contract.
- [Execution model](docs/EXECUTION_MODEL.md) — causal fills, accounting, and
  unknown execution state.
- [Roadmap](docs/ROADMAP.md) — research milestones and known work remaining.
