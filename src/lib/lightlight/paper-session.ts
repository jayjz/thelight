import { createHash } from "node:crypto";
import { emaRsiV1Strategy, type TargetPosition, type TradingStrategy } from "./ema-rsi-v1.ts";
import { crossoverFeatures, emaRsiV2Strategy, EMA_RSI_V2_CONFIG } from "./ema-rsi-v2.ts";
import { computeFeatures } from "./features.ts";
import { evaluateRisk } from "./policy.ts";
import { ReplayExecution } from "./execution.ts";
import { SPY_SPEC, isMarketSessionOpen } from "./assets.ts";
import { validateSelection, type PaperSession, type Row } from "./paper-session-store.ts";
import type { ClosedBar, Evidence } from "./types.ts";
export function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((value as Row)[k])}`)
    .join(",")}}`;
}
export const digest = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;
const sessionCache = new Map<number, boolean>();
function regular(t: number) {
  if (!sessionCache.has(t)) {
    if (sessionCache.size > 100000) sessionCache.clear();
    sessionCache.set(t, isMarketSessionOpen(SPY_SPEC, t));
  }
  return sessionCache.get(t)!;
}
const time = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
const num = (v: unknown): number | null =>
  v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
export function distribution(values: (number | null)[]) {
  const xs = values
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  const q = (p: number) => (xs.length ? xs[Math.floor((xs.length - 1) * p)]! : null);
  return {
    count: xs.length,
    min: q(0),
    p25: q(0.25),
    median: q(0.5),
    p75: q(0.75),
    max: q(1),
    mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
  };
}
export function continuousPrefix(bars: readonly ClosedBar[], through: number): ClosedBar[] {
  const out: ClosedBar[] = [];
  for (const b of bars) {
    if (b.t > through) break;
    if (!regular(b.t)) continue;
    if (out.length && b.t !== out.at(-1)!.t + 60000) out.length = 0;
    out.push(b);
  }
  return out.at(-1)?.t === through ? out : [];
}
export function signalParity(session: PaperSession) {
  let prior: TargetPosition | null = null;
  let previousTimestamp: number | null = null;
  return session.decisions.map((row) => {
    const e = parse<Evidence>(row.evidence_json),
      d = e.strategyDecision;
    if (!d) return { decisionId: e.id, status: "FAIL", issues: ["Missing strategyDecision"] };
    const issues: string[] = [];
    const available = session.bars
      .filter((r) => time(r.received_at) <= d.decisionTimestamp)
      .map((r) => parse<ClosedBar>(r.bar_json));
    const bars = continuousPrefix(available, e.timestamp).slice(-23);
    if (e.timestamp + 60000 > d.decisionTimestamp) issues.push("Decision before bar completion");
    if (bars.length !== d.features.completedBarCount)
      issues.push("Captured feature window length differs");
    if (!bars.length || canonical(bars.at(-1)) !== canonical(e.marketSnapshot))
      issues.push("Source bar differs or unavailable");
    if (previousTimestamp !== null && e.timestamp !== previousTimestamp + 60000)
      issues.push("Decision sequence gap: prior target continuity unproven");
    if (prior !== null && prior !== d.priorTarget) issues.push("Prior target sequence differs");
    const replay = emaRsiV1Strategy.evaluate({
      completedBars: bars,
      priorTarget: prior ?? d.priorTarget,
    });
    const featureDifferences: Record<string, number | null> = {};
    for (const key of ["ema9", "ema21", "rsi14"]) {
      const live = num(d.features[key]),
        offline = num(replay.features[key]);
      featureDifferences[key] = live !== null && offline !== null ? offline - live : null;
      if (live !== offline) issues.push(`${key} differs`);
    }
    const f = computeFeatures(bars).at(-1);
    const risk = f
      ? evaluateRisk({
          desired: replay.targetPosition === 1 ? "LONG" : "FLAT",
          features: f,
          equityDrawdown: e.risk.equityDrawdown,
        })
      : null;
    const replayRiskTarget = risk ? (risk.target === "LONG" ? 1 : 0) : null;
    if (replay.targetPosition !== d.proposedTarget) issues.push("Strategy target differs");
    if (replayRiskTarget !== e.targetPosition) issues.push("Risk-approved target differs");
    prior = replayRiskTarget === 1 ? 1 : 0;
    previousTimestamp = e.timestamp;
    const position = session.positions
      .filter((p) => time(p.reconciled_at) <= d.decisionTimestamp)
      .at(-1);
    return {
      decisionId: e.id,
      sourceBarTimestamp: e.timestamp,
      decisionTimestamp: d.decisionTimestamp,
      priorTarget: d.priorTarget,
      liveTarget: d.proposedTarget,
      replayTarget: replay.targetPosition,
      liveRiskTarget: e.targetPosition,
      replayRiskTarget,
      featureDifferences,
      status: issues.length ? "FAIL" : "PASS",
      issues,
      brokerPosition: position ? num(position.quantity) : null,
      brokerPositionObservedAt: position?.reconciled_at ?? null,
      ...crossoverFeatures(bars),
    };
  });
}
export type ResearchFill = {
  id: string;
  decisionId: string;
  orderId: string;
  timestamp: number;
  timestampExact: string;
  timestampNanoseconds: string;
  price: number;
  quantity: number;
  before: number;
  after: number;
  side: "buy" | "sell";
};
/** Preserve Alpaca's RFC3339 submillisecond precision without floating-point epoch loss. */
function nanoseconds(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(iso))
    throw new Error("Unsupported fill timestamp precision");
  const fractional = iso.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "";
  return (
    BigInt(Date.parse(iso)) * 1000000n +
    BigInt(fractional.padEnd(9, "0").slice(3))
  ).toString();
}
function orderFills(fills: ResearchFill[]): ResearchFill[] {
  const sorted = [...fills].sort((a, b) =>
    BigInt(a.timestampNanoseconds) < BigInt(b.timestampNanoseconds)
      ? -1
      : BigInt(a.timestampNanoseconds) > BigInt(b.timestampNanoseconds)
        ? 1
        : 0,
  );
  const out: ResearchFill[] = [];
  for (let i = 0; i < sorted.length;) {
    const group: ResearchFill[] = [];
    const stamp = sorted[i]!.timestampNanoseconds;
    while (i < sorted.length && sorted[i]!.timestampNanoseconds === stamp) group.push(sorted[i++]!);
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }
    // True timestamp ties require a unique path through broker position evidence.
    // Never choose an arbitrary execution ID or ingestion ordering.
    let prior = out.at(-1)?.after;
    while (group.length) {
      const candidates = group.filter((f) =>
        prior === undefined
          ? !group.some((other) => other !== f && Math.abs(other.after - f.before) < 1e-8)
          : Math.abs(f.before - prior) < 1e-8,
      );
      if (candidates.length !== 1)
        throw new Error("Ambiguous simultaneous fill ordering; exact round trips unavailable");
      const next = candidates[0]!;
      out.push(next);
      prior = next.after;
      group.splice(group.indexOf(next), 1);
    }
  }
  return out;
}
export function extractFills(session: PaperSession) {
  const fills: ResearchFill[] = [],
    unavailable: string[] = [];
  const seen = new Map<string, string>();
  for (const row of session.updates) {
    const envelope = parse<Row>(row.update_json);
    const d = (envelope.data ?? envelope) as Row;
    if (d.event !== "fill" && d.event !== "partial_fill") continue;
    const o = d.order as Row | undefined;
    const i = session.intents.find((i) => i.client_order_id === row.client_order_id);
    if (!o || !i || o.symbol !== "SPY" || o.client_order_id !== row.client_order_id) {
      unavailable.push(`Unmatched fill ${row.update_id}`);
      continue;
    }
    const price = num(d.price),
      quantity = num(d.qty),
      after = num(d.position_qty),
      timestamp = time(d.timestamp);
    if (
      price === null ||
      price <= 0 ||
      quantity === null ||
      quantity <= 0 ||
      after === null ||
      !Number.isFinite(timestamp) ||
      !["buy", "sell"].includes(String(o.side))
    ) {
      unavailable.push(`Incomplete fill ${row.update_id}`);
      continue;
    }
    if (timestamp < session.selection.start || timestamp >= session.selection.end) continue;
    const id = String(
      d.execution_id ??
        d.event_id ??
        `${o.id}:${d.timestamp}:${d.qty}:${d.price}:${d.position_qty}`,
    );
    const fill: ResearchFill = {
      id,
      decisionId: String(i.decision_id),
      orderId: String(o.id),
      timestamp,
      timestampExact: String(d.timestamp),
      timestampNanoseconds: nanoseconds(String(d.timestamp)),
      price,
      quantity,
      before: after - (o.side === "buy" ? quantity : -quantity),
      after,
      side: o.side as "buy" | "sell",
    };
    if (seen.has(id)) {
      if (seen.get(id) !== canonical(fill)) throw new Error(`Conflicting duplicate fill ${id}`);
      continue;
    }
    seen.set(id, canonical(fill));
    fills.push(fill);
  }
  const ordered = orderFills(fills);
  const represented = new Set(fills.map((f) => f.orderId));
  for (const row of session.orders)
    if (row.status === "FILLED" && !represented.has(String(row.broker_order_id)))
      unavailable.push(`FILLED order without priced trade update: ${row.broker_order_id}`);
  return { fills: ordered, unavailable: [...new Set(unavailable)] };
}
export function roundTrips(fills: ResearchFill[], bars: ClosedBar[]) {
  const trips: Array<{
    entry: ResearchFill;
    exit: ResearchFill;
    holdMinutes: number;
    pnl: number;
    return: number;
    notional: number;
    mae: number | null;
    mfe: number | null;
    excursionCoverage: string;
  }> = [];
  let cycle: ResearchFill[] = [];
  let previous: number | null = null;
  for (const f of fills) {
    if (previous !== null && Math.abs(f.before - previous) > 1e-8) cycle = [];
    if (f.before === 0 && f.side === "buy") cycle = [];
    if ((f.before === 0 && f.side === "buy") || cycle.length > 0) cycle.push(f);
    if (f.after === 0 && cycle.length) {
      const entry = cycle[0]!;
      if (entry.before === 0 && cycle.every((v) => v.before >= 0 && v.after >= 0)) {
        const notional = cycle
          .filter((v) => v.side === "buy")
          .reduce((a, v) => a + v.price * v.quantity, 0);
        const pnl = cycle.reduce(
          (a, v) => a + (v.side === "sell" ? 1 : -1) * v.price * v.quantity,
          0,
        );
        const inside = bars.filter((b) => b.t >= entry.timestamp && b.t + 60000 <= f.timestamp);
        const simple = cycle.length === 2 && entry.quantity === f.quantity;
        trips.push({
          entry,
          exit: f,
          holdMinutes:
            Number(BigInt(f.timestampNanoseconds) - BigInt(entry.timestampNanoseconds)) /
            60000000000,
          pnl,
          return: pnl / notional,
          notional,
          mae:
            simple && inside.length
              ? Math.min(...inside.map((b) => b.low / entry.price - 1))
              : null,
          mfe:
            simple && inside.length
              ? Math.max(...inside.map((b) => b.high / entry.price - 1))
              : null,
          excursionCoverage:
            "Interior completed minutes only; boundary-minute extrema unavailable. Not exact whole-trade MAE/MFE.",
        });
      }
      cycle = [];
    }
    previous = f.after;
  }
  return trips;
}
export const COST_SCENARIOS = Object.freeze([
  { transactionCostBps: 0, slippageBps: 0 },
  { transactionCostBps: 0, slippageBps: 1 },
  { transactionCostBps: 0, slippageBps: 5 },
  { transactionCostBps: 1, slippageBps: 5 },
]);
export function compareStrategies(session: PaperSession) {
  const all = session.bars.map((r) => parse<ClosedBar>(r.bar_json));
  const decisions = session.decisions.map((r) => parse<Evidence>(r.evidence_json));
  const first = decisions[0]?.timestamp,
    last = decisions.at(-1)?.timestamp;
  const bars = all.filter(
    (b) => first !== undefined && last !== undefined && b.t >= first && b.t <= last && regular(b.t),
  );
  const opportunities = new Set(decisions.map((e) => e.timestamp));
  return [emaRsiV1Strategy, emaRsiV2Strategy].map((strategy: TradingStrategy) => {
    let prior: TargetPosition = 0;
    const targets = bars.map((b) => {
      const prefix = continuousPrefix(all, b.t);
      const decision = opportunities.has(b.t)
        ? strategy.evaluate({
            completedBars: strategy.id === "ema_rsi_v1" ? prefix.slice(-23) : prefix,
            priorTarget: prior,
          })
        : null;
      const before = prior;
      if (decision) prior = decision.targetPosition;
      return {
        timestamp: b.t,
        target: prior,
        prior: before,
        decision,
        strength: crossoverFeatures(prefix).signedStrength,
      };
    });
    const scenarios = COST_SCENARIOS.map((cost) => {
      const execution = new ReplayExecution(cost);
      bars.forEach((bar, i) => {
        // Never execute a pending minute intent across a data gap.
        if (i && bar.t !== bars[i - 1]!.t + 60000)
          throw new Error("Counterfactual requires contiguous frozen bars");
        execution.advanceBar(i, bar, bars[i - 1]);
        if (targets[i]!.decision)
          execution.createIntent({
            decisionId: `research:${strategy.id}:${bar.t}`,
            createdAtBar: i,
            createdAtTimestamp: bar.t + 60000,
            action: targets[i]!.target === 1 ? "LONG" : "FLAT",
          });
      });
      const ledger = execution.snapshot();
      const holds: number[] = [];
      let entry: number | null = null;
      for (const f of ledger.fills) {
        if (f.positionBefore === 0 && f.positionAfter === 1) entry = f.fillTimestamp;
        else if (f.positionBefore === 1 && f.positionAfter === 0 && entry !== null) {
          holds.push((f.fillTimestamp - entry) / 60000);
          entry = null;
        }
      }
      let peak = 1,
        drawdown = 0;
      for (const p of ledger.equity) {
        peak = Math.max(peak, p.equity);
        drawdown = Math.max(drawdown, 1 - p.equity / peak);
      }
      return {
        cost,
        entries: ledger.transitions.filter((t) => t.positionAfter === 1).length,
        transitions: ledger.transitions.length,
        turnover: ledger.transitions.reduce((s, t) => s + t.turnover, 0),
        exposure:
          ledger.equity.length > 1
            ? ledger.equity.slice(1).reduce((s, p) => s + p.positionApplied, 0) /
              (ledger.equity.length - 1)
            : 0,
        holdMinutes: distribution(holds),
        netReturn: ledger.finalEquity - 1,
        maxDrawdown: drawdown,
        transactionCosts: ledger.totalTransactionCost,
        slippageCosts: ledger.totalSlippage,
        openPosition: ledger.finalPosition,
        ledger,
      };
    });
    return {
      strategy: strategy.id,
      barsHash: digest(bars),
      timingModel:
        "NEXT_BAR_CLOSE/v1 (existing ReplayExecution; bar timestamps label minute starts)",
      scope:
        "Strategy-only unit exposure; starts flat; no PAPER risk/dispatch replay; no forced terminal liquidation",
      signalFlips: targets.filter((t) => t.target !== t.prior).length,
      weakEntries: scenarios[0]!.ledger.fills.filter((f) => {
        const strength = targets[f.fillBarIndex - 1]?.strength;
        return (
          f.positionBefore === 0 &&
          f.positionAfter === 1 &&
          strength !== null &&
          strength !== undefined &&
          strength < EMA_RSI_V2_CONFIG.entryStrength
        );
      }).length,
      grossReturn: scenarios[0]?.netReturn ?? null,
      targets,
      scenarios,
    };
  });
}
export function analyzePaperSession(session: PaperSession) {
  if (session.schemaVersion !== "paper-session-v1") throw new Error("Unsupported session schema");
  validateSelection(session.selection);
  const bars = session.bars.map((r) => parse<ClosedBar>(r.bar_json));
  if (
    bars.some(
      (b, i) =>
        !Number.isFinite(b.t) ||
        b.t % 60000 !== 0 ||
        ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
        b.low <= 0 ||
        b.volume < 0 ||
        b.low > Math.min(b.open, b.close) ||
        b.high < Math.max(b.open, b.close) ||
        session.bars[i]!.symbol !== "SPY" ||
        Number(session.bars[i]!.timestamp_ms) !== b.t ||
        (i > 0 && b.t <= bars[i - 1]!.t),
    )
  )
    throw new Error("Invalid or unordered frozen bars");
  for (let i = 0; i < session.decisions.length; i++) {
    const row = session.decisions[i]!,
      e = parse<Evidence>(row.evidence_json);
    if (
      row.worker_key !== session.selection.workerKey ||
      row.symbol !== "SPY" ||
      String(e.strategyId) !== "ema_rsi_v1" ||
      e.timeframe !== "1Min" ||
      e.id !== row.decision_id ||
      e.symbol !== "SPY" ||
      e.timestamp !== Number(row.decision_timestamp_ms) ||
      e.timestamp < session.selection.start ||
      e.timestamp >= session.selection.end ||
      (session.selection.runId !== null &&
        e.strategyDecision?.runtime.runId !== session.selection.runId) ||
      (i > 0 && e.timestamp <= Number(session.decisions[i - 1]!.decision_timestamp_ms))
    )
      throw new Error("Frozen decisions violate selection/order");
  }
  const parity = signalParity(session);
  const extracted = extractFills(session),
    fills = extracted.fills,
    trips = roundTrips(fills, bars);
  const positions = session.positions.map((r) => ({
    id: r.position_id,
    timestamp: time(r.reconciled_at),
    quantity: num(r.quantity),
  }));
  const transitions = positions.flatMap((p, i) =>
    i > 0 &&
    p.quantity !== null &&
    positions[i - 1]!.quantity !== null &&
    p.quantity !== positions[i - 1]!.quantity
      ? [
          {
            ...p,
            before: positions[i - 1]!.quantity,
            after: p.quantity,
            intervalStart: positions[i - 1]!.timestamp,
          },
        ]
      : [],
  );
  const changes = parity.filter((p) => "liveTarget" in p && p.liveTarget !== p.priorTarget);
  const entries = changes.filter((p) => "liveTarget" in p && p.liveTarget === 1),
    exits = changes.filter((p) => "liveTarget" in p && p.liveTarget === 0);
  const winners = trips.filter((t) => t.pnl > 0),
    losers = trips.filter((t) => t.pnl < 0);
  const grossWinners = winners.reduce((s, t) => s + t.pnl, 0),
    grossLosses = -losers.reduce((s, t) => s + t.pnl, 0);
  const timing = fills.map((f) => {
    const p = parity.find((p) => p.decisionId === f.decisionId);
    return {
      fillId: f.id,
      afterDecisionMs: p && "decisionTimestamp" in p ? f.timestamp - p.decisionTimestamp! : null,
      afterCompletedBarMs:
        p && "sourceBarTimestamp" in p ? f.timestamp - p.sourceBarTimestamp! - 60000 : null,
    };
  });
  const unavailable = [
    ...extracted.unavailable,
    "Broker snapshot transitions are symbol-scoped observations, not exact fill times or run-attributed transitions.",
    "Live source revision/config hash and absolute account equity are not persisted in selected immutable decisions.",
    "Fees and spread unavailable; priced fill P&L is before explicit fees.",
    "Exact full-trade MAE/MFE unavailable at minute resolution; interior-minute extrema only.",
    "Session boundaries may censor positions/orders; complete-account P&L is not inferred.",
  ];
  const hourlyTransitions = Object.entries(
    transitions.reduce<Record<string, number>>((out, t) => {
      const hour = new Date(t.timestamp).toISOString().slice(0, 13);
      out[hour] = (out[hour] ?? 0) + 1;
      return out;
    }, {}),
  ).map(([utcHour, count]) => ({ utcHour, count }));
  const tripStrengthGroups = ["weak", "strong"].map((group) => {
    const selected = trips.filter((t) => {
      const p = parity.find((p) => p.decisionId === t.entry.decisionId);
      return (
        p &&
        "signedStrength" in p &&
        p.signedStrength !== null &&
        (group === "weak" ? p.signedStrength! < 0.5 : p.signedStrength! >= 0.5)
      );
    });
    return {
      group,
      threshold: 0.5,
      count: selected.length,
      losses: selected.filter((t) => t.pnl < 0).length,
      pnl: selected.reduce((v, t) => v + t.pnl, 0),
      holds: distribution(selected.map((t) => t.holdMinutes)),
    };
  });
  let comparison: ReturnType<typeof compareStrategies> | null = null;
  try {
    if (!parity.length || parity.some((p) => p.status !== "PASS"))
      throw new Error("Counterfactual withheld: captured signal parity incomplete or failed");
    comparison = compareStrategies(session);
  } catch (e) {
    unavailable.push(e instanceof Error ? e.message : String(e));
  }
  return {
    schemaVersion: "paper-session-analysis-v1",
    manifest: {
      selection: session.selection,
      evidenceHash: digest(session),
      barsHash: digest(session.bars),
      config: EMA_RSI_V2_CONFIG,
      configHash: digest(EMA_RSI_V2_CONFIG),
      decisionIds: session.decisions.map((r) => r.decision_id),
      runIds: session.runs.map((r) => r.run_id),
      liveCodeRevision: null,
    },
    parity: {
      status: parity.length && parity.every((p) => p.status === "PASS") ? "PASS" : "FAIL",
      scope:
        "Captured strategy and risk targets; first recorded prior target is a boundary input, not independently proven; dispatch eligibility not replayed",
      count: parity.length,
      failures: parity.filter((p) => p.status !== "PASS").length,
      decisions: parity,
    },
    paper: {
      fills,
      positionObservations: positions,
      observedTransitions: transitions,
      roundTrips: trips,
      metrics: {
        fillCount: fills.length,
        observedTransitions: transitions.length,
        roundTrips: trips.length,
        realizedPnlOnCompleteTrips: trips.reduce((s, t) => s + t.pnl, 0),
        notional: fills.reduce((s, f) => s + f.price * f.quantity, 0),
        accountTurnover: null,
        winCount: winners.length,
        lossCount: losers.length,
        flatCount: trips.length - winners.length - losers.length,
        grossWinners,
        grossLosses,
        profitFactor: grossLosses > 0 ? grossWinners / grossLosses : null,
        holdMinutes: distribution(trips.map((t) => t.holdMinutes)),
        timeInMarketMinutesOnCompleteTrips: trips.reduce((s, t) => s + t.holdMinutes, 0),
      },
    },
    diagnostics: {
      changes,
      hourlyTransitions,
      transitionsPerObservedHour: distribution(hourlyTransitions.map((h) => h.count)),
      tripStrengthGroups,
      entryEmaSpreadBps: distribution(
        entries.map((p) => ("emaSpreadBps" in p ? p.emaSpreadBps! : null)),
      ),
      exitEmaSpreadBps: distribution(
        exits.map((p) => ("emaSpreadBps" in p ? p.emaSpreadBps! : null)),
      ),
      entryRsi: distribution(entries.map((p) => ("rsi14" in p ? p.rsi14! : null))),
      exitRsi: distribution(exits.map((p) => ("rsi14" in p ? p.rsi14! : null))),
      holdMinutes: distribution(trips.map((t) => t.holdMinutes)),
      roundTripReturns: distribution(trips.map((t) => t.return)),
      flipIntervalsMinutes: distribution(
        changes
          .slice(1)
          .map((p, i) =>
            "sourceBarTimestamp" in p && "sourceBarTimestamp" in changes[i]!
              ? (p.sourceBarTimestamp! - changes[i]!.sourceBarTimestamp!) / 60000
              : null,
          ),
      ),
      signalFlips: changes.length,
      transitionsPerSelectedHour:
        transitions.length / ((session.selection.end - session.selection.start) / 3600000),
    },
    timing: {
      liveModel: "PAPER_OBSERVED_TRADE_UPDATE/v1",
      replayModel: "NEXT_BAR_CLOSE/v1",
      executionParity: "NOT_CLAIMED",
      fills: timing,
      afterCompletedBarMs: distribution(timing.map((t) => t.afterCompletedBarMs)),
    },
    comparison,
    unavailable,
  };
}
