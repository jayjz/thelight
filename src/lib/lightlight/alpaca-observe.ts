/**
 * Read-only projection and terminal formatting for the durable Alpaca PAPER
 * evidence. This module intentionally has no dependency on worker, broker, or
 * Alpaca transport code: it can only normalize rows that already exist.
 */

export const DEFAULT_ALPACA_PAPER_WORKER_KEY = "alpaca-paper:SPY:15Min:alpaca-paper-worker-v1";
export const EMA_RSI_V1_ALPACA_PAPER_WORKER_KEY = "alpaca-paper:SPY:1Min:ema-rsi-v1-paper-worker-v1";
export const DEFAULT_OBSERVER_SYMBOL = "SPY";

export type ObserverQuery = {
  query<T extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
};

type JsonRecord = Record<string, unknown>;

export type ObserverCheckpoint = {
  marketStreamState: string | null;
  tradeUpdateStreamState: string | null;
  featureContinuity: string | null;
  recoveryState: string | null;
  latestRawBarTimestamp: number | null;
  latestClosedDecisionBarTimestamp: number | null;
  latestDecisionId: string | null;
  lastReconciliationTimestamp: string | null;
  paperEquity: number | null;
  haltReason: string | null;
  updatedAt: string | null;
};

export type ObserverRecovery = {
  recoveryAttemptId: string;
  state: string;
  missingStartMs: number | null;
  missingEndMs: number | null;
  detectedAt: string | null;
  requestedAt: string | null;
  verifiedAt: string | null;
  completedAt: string | null;
  returnedBarCount: number;
  verifiedBarCount: number;
  result: string | null;
  reason: string | null;
};

export type ObserverLease = {
  runId: string;
  fencingToken: number | null;
  expiresAt: string | null;
  renewedAt: string | null;
  live: boolean;
};

export type ObserverRun = {
  runId: string;
  state: string;
  haltReason: string | null;
  startedAt: string | null;
};

export type ObserverDecision = {
  decisionId: string;
  timestamp: number | null;
  createdAt: string | null;
  strategySignal: string | null;
  strategyReason: string | null;
  policyDesired: string | null;
  policyReason: string | null;
  action: string | null;
  targetPosition: number | null;
  riskReasons: string[];
  strategyId?: string | null;
  strategyVersion?: string | null;
  ema9?: number | null;
  ema21?: number | null;
  rsi14?: number | null;
  proposedTarget?: number | null;
  finalRiskApprovedTarget?: number | null;
  blockReason?: string | null;
  intent: ObserverIntent | null;
};

export type ObserverIntent = {
  intentId: string;
  decisionId: string;
  status: string;
  desiredAction: string | null;
  desiredPosition: number | null;
  dispatchBlockReason: string | null;
  updatedAt: string | null;
};

export type ObserverBrokerOrder = {
  eventId: string;
  intentId: string;
  brokerOrderId: string | null;
  status: string;
  lookup: string;
  observedAt: string | null;
};

export type ObserverTradeUpdate = {
  updateId: string;
  clientOrderId: string | null;
  receivedAt: string | null;
};

export type ObserverSnapshot = {
  workerKey: string;
  symbol: string;
  checkpoint: ObserverCheckpoint | null;
  lease: ObserverLease | null;
  run: ObserverRun | null;
  latestRawBarTimestamp: number | null;
  latestTradeUpdateAt: string | null;
  paperPosition: { quantity: number; reconciledAt: string | null } | null;
  decisions: ObserverDecision[];
  brokerOrders: ObserverBrokerOrder[];
  tradeUpdates: ObserverTradeUpdate[];
  recovery: ObserverRecovery | null;
};

export type ObserverEvent =
  | { kind: "bar"; timestamp: number | null }
  | { kind: "decision"; decision: ObserverDecision }
  | { kind: "intent"; intent: ObserverIntent }
  | { kind: "broker"; order: ObserverBrokerOrder }
  | { kind: "trade-update"; update: ObserverTradeUpdate }
  | { kind: "recovery"; recovery: ObserverRecovery };

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function parseJson(value: unknown): JsonRecord {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function asReasons(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((reason): reason is string => typeof reason === "string") : [];
}

function checkpointFrom(row: JsonRecord | undefined): ObserverCheckpoint | null {
  if (!row) return null;
  const checkpoint = parseJson(row.checkpoint_json);
  return {
    marketStreamState: asString(checkpoint.marketStreamState ?? checkpoint.streamState),
    tradeUpdateStreamState: asString(checkpoint.tradeUpdateStreamState),
    featureContinuity: asString(checkpoint.featureContinuity),
    recoveryState: asString(checkpoint.recoveryState),
    latestRawBarTimestamp: asNumber(checkpoint.latestRawBarTimestamp),
    latestClosedDecisionBarTimestamp: asNumber(checkpoint.latestClosedDecisionBarTimestamp),
    latestDecisionId: asString(checkpoint.latestDecisionId),
    lastReconciliationTimestamp: asString(checkpoint.lastReconciliationTimestamp),
    paperEquity: asNumber(checkpoint.lastPaperEquity),
    haltReason: asString(checkpoint.haltReason),
    updatedAt: asString(row.updated_at),
  };
}

function intentFrom(row: JsonRecord | undefined): ObserverIntent | null {
  if (!row || !asString(row.intent_id)) return null;
  const intent = parseJson(row.intent_json);
  return {
    intentId: asString(row.intent_id)!,
    decisionId: asString(row.decision_id) ?? asString(intent.decisionId) ?? "unknown",
    status: asString(row.intent_status) ?? asString(intent.status) ?? "UNKNOWN",
    desiredAction: asString(intent.desiredAction),
    desiredPosition: asNumber(intent.desiredPosition),
    dispatchBlockReason: asString(row.dispatch_block_reason),
    updatedAt: asString(row.intent_updated_at),
  };
}

function decisionFrom(row: JsonRecord): ObserverDecision {
  const evidence = parseJson(row.evidence_json);
  const signal = asRecord(evidence.deterministicSignal);
  const policy = asRecord(evidence.policy);
  const risk = asRecord(evidence.risk);
  const strategyDecision = asRecord(evidence.strategyDecision);
  const strategyFeatures = asRecord(strategyDecision.features);
  return {
    decisionId: asString(row.decision_id) ?? "unknown",
    timestamp: asNumber(row.decision_timestamp_ms) ?? asNumber(evidence.timestamp),
    createdAt: asString(row.decision_created_at),
    strategySignal: asString(signal.desired),
    strategyReason: asString(signal.reason),
    policyDesired: asString(policy.desired),
    policyReason: asString(policy.reason),
    action: asString(evidence.action),
    targetPosition: asNumber(evidence.targetPosition),
    riskReasons: asReasons(risk.reasons),
    strategyId: asString(evidence.strategyId),
    strategyVersion: asString(evidence.strategyVersion),
    ema9: asNumber(strategyFeatures.ema9),
    ema21: asNumber(strategyFeatures.ema21),
    rsi14: asNumber(strategyFeatures.rsi14),
    proposedTarget: asNumber(strategyDecision.proposedTarget),
    finalRiskApprovedTarget: asNumber(strategyDecision.finalRiskApprovedTarget),
    blockReason: asString(strategyDecision.blockReason),
    intent: intentFrom(row),
  };
}

/** Loads bounded, durable evidence only. Every statement is a SELECT. */
export async function loadObserverSnapshot(
  query: ObserverQuery,
  workerKey = DEFAULT_ALPACA_PAPER_WORKER_KEY,
  symbol = DEFAULT_OBSERVER_SYMBOL,
): Promise<ObserverSnapshot> {
  // Keep a single pg client strictly sequential inside BEGIN READ ONLY. It
  // gives a coherent snapshot without driver-level concurrent-query warnings.
  const checkpointResult = await query.query("select checkpoint_json, updated_at::text from runtime_checkpoint where worker_key = $1", [workerKey]);
  const leaseResult = await query.query("select owner_run_id, fencing_token::text, lease_expires_at::text, renewed_at::text, lease_expires_at > clock_timestamp() as live from worker_leases where worker_key = $1", [workerKey]);
  const runResult = await query.query("select run_id, state, halt_reason, started_at::text from worker_runs where worker_key = $1 order by started_at desc limit 1", [workerKey]);
  const barResult = await query.query("select timestamp_ms::text from closed_bars where symbol = $1 order by timestamp_ms desc limit 1", [symbol]);
  const positionResult = await query.query("select quantity, reconciled_at::text from broker_positions where symbol = $1 order by reconciled_at desc, position_id desc limit 1", [symbol]);
  const tradeResult = await query.query("select received_at::text from trade_updates order by received_at desc limit 1");
  const decisionResult = await query.query("select d.decision_id, d.decision_timestamp_ms::text, d.evidence_json, d.created_at::text as decision_created_at, i.intent_id, i.decision_id, i.status as intent_status, i.intent_json, i.dispatch_block_reason, i.updated_at::text as intent_updated_at from decisions d left join execution_intents i on i.decision_id = d.decision_id where d.symbol = $1 and d.worker_key = $2 order by d.decision_timestamp_ms desc, d.created_at desc limit 12", [symbol, workerKey]);
  const brokerResult = await query.query("select b.event_id, b.intent_id, b.broker_order_id, b.status, b.lookup_state, b.observed_at::text from broker_orders b join execution_intents i on i.intent_id = b.intent_id join decisions d on d.decision_id = i.decision_id where d.symbol = $1 and d.worker_key = $2 order by b.observed_at desc, b.event_id desc limit 20", [symbol, workerKey]);
  const updateResult = await query.query("select update_id, client_order_id, received_at::text from trade_updates order by received_at desc, update_id desc limit 20");
  const recoveryResult = await query.query("select recovery_attempt_id, state, missing_start_ms::text, missing_end_ms::text, detected_at::text, requested_at::text, verified_at::text, completed_at::text, returned_bar_count, verified_bar_count, result, reason from market_gap_recovery_attempts where worker_key = $1 and symbol = $2 order by detected_at desc limit 1", [workerKey, symbol]);

  const checkpoint = checkpointFrom(checkpointResult.rows[0]);
  const leaseRow = leaseResult.rows[0];
  const runRow = runResult.rows[0];
  const positionRow = positionResult.rows[0];
  const recoveryRow = recoveryResult.rows[0];
  return {
    workerKey,
    symbol,
    checkpoint,
    lease: leaseRow ? {
      runId: asString(leaseRow.owner_run_id) ?? "unknown",
      fencingToken: asNumber(leaseRow.fencing_token),
      expiresAt: asString(leaseRow.lease_expires_at),
      renewedAt: asString(leaseRow.renewed_at),
      live: asBoolean(leaseRow.live),
    } : null,
    run: runRow ? {
      runId: asString(runRow.run_id) ?? "unknown",
      state: asString(runRow.state) ?? "UNKNOWN",
      haltReason: asString(runRow.halt_reason),
      startedAt: asString(runRow.started_at),
    } : null,
    latestRawBarTimestamp: asNumber(barResult.rows[0]?.timestamp_ms) ?? checkpoint?.latestRawBarTimestamp ?? null,
    latestTradeUpdateAt: asString(tradeResult.rows[0]?.received_at),
    paperPosition: positionRow ? { quantity: asNumber(positionRow.quantity) ?? 0, reconciledAt: asString(positionRow.reconciled_at) } : null,
    decisions: decisionResult.rows.map(decisionFrom),
    brokerOrders: brokerResult.rows.map((row) => ({
      eventId: asString(row.event_id) ?? "unknown",
      intentId: asString(row.intent_id) ?? "unknown",
      brokerOrderId: asString(row.broker_order_id),
      status: asString(row.status) ?? "UNKNOWN",
      lookup: asString(row.lookup_state) ?? "UNRESOLVED",
      observedAt: asString(row.observed_at),
    })),
    tradeUpdates: updateResult.rows.map((row) => ({
      updateId: asString(row.update_id) ?? "unknown",
      clientOrderId: asString(row.client_order_id),
      receivedAt: asString(row.received_at),
    })),
    recovery: recoveryRow ? {
      recoveryAttemptId: asString(recoveryRow.recovery_attempt_id) ?? "unknown",
      state: asString(recoveryRow.state) ?? "UNKNOWN",
      missingStartMs: asNumber(recoveryRow.missing_start_ms), missingEndMs: asNumber(recoveryRow.missing_end_ms),
      detectedAt: asString(recoveryRow.detected_at), requestedAt: asString(recoveryRow.requested_at),
      verifiedAt: asString(recoveryRow.verified_at), completedAt: asString(recoveryRow.completed_at),
      returnedBarCount: asNumber(recoveryRow.returned_bar_count) ?? 0, verifiedBarCount: asNumber(recoveryRow.verified_bar_count) ?? 0,
      result: asString(recoveryRow.result), reason: asString(recoveryRow.reason),
    } : null,
  };
}

const ET = "America/New_York";
const timeFormatter = new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const clockFormatter = new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

function dateFrom(value: number | string | null): Date | null {
  if (value === null) return null;
  const date = new Date(typeof value === "number" ? value : value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function formatEt(value: number | string | null, withSeconds = false): string {
  const date = dateFrom(value);
  if (!date) return "--:-- ET";
  return `${(withSeconds ? clockFormatter : timeFormatter).format(date)} ET`;
}

/** Prevent credential-shaped strings and URLs from crossing the terminal boundary. */
export function sanitizeTerminalText(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "<database-url-redacted>")
    .replace(/\b(api[_-]?key|secret|authorization|password)\s*[=:]\s*\S+/gi, "$1=<redacted>")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 180);
}

export function sanitizeIdentifier(value: string | null): string {
  if (!value) return "";
  const compact = value.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!compact) return "";
  return compact.length > 12 ? `${compact.slice(0, 12)}…` : compact;
}

type Health = { icon: string; label: string };

export function classifyStream(state: string | null): Health {
  if (state === "CONNECTED") return { icon: "🟢", label: "connected" };
  if (state === "CONNECTING" || state === "RECONCILING") return { icon: "🟡", label: state.toLowerCase() };
  if (state === "DEGRADED" || state === "DISCONNECTED") return { icon: "🔴", label: state.toLowerCase() };
  return { icon: "🟡", label: "waiting" };
}

export function classifyContinuity(state: string | null): Health {
  if (state === "HEALTHY") return { icon: "🟢", label: "continuous" };
  if (state === "REBUILDING") return { icon: "🟡", label: "rebuilding (safe gate)" };
  return { icon: "🟡", label: "waiting" };
}

export function classifyRecovery(state: string | null): Health {
  if (state === "HEALTHY") return { icon: "🟢", label: "healthy" };
  if (state === "GAP_DETECTED") return { icon: "⚠", label: "gap detected (safe gate)" };
  if (state === "BACKFILLING") return { icon: "🔧", label: "backfilling (safe gate)" };
  if (state === "VERIFYING") return { icon: "🔎", label: "verifying (safe gate)" };
  if (state === "REBUILDING") return { icon: "🟡", label: "rebuilding (safe gate)" };
  return { icon: "🟡", label: "waiting" };
}

export function classifyLease(lease: ObserverLease | null): Health {
  if (!lease) return { icon: "🔴", label: "no durable lease" };
  return lease.live ? { icon: "🟢", label: "lease live" } : { icon: "🔴", label: "lease expired" };
}

function formatMoney(value: number | null): string {
  return value === null ? "waiting" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function decisionSummary(decision: ObserverDecision): string {
  if (decision.strategyId === "ema_rsi_v1") {
    const target = decision.finalRiskApprovedTarget ?? decision.targetPosition;
    return `${decision.strategyId}\n      EMA9=${decision.ema9?.toFixed(3) ?? "--"}  EMA21=${decision.ema21?.toFixed(3) ?? "--"}  RSI14=${decision.rsi14?.toFixed(1) ?? "--"}\n      ${target === 1 ? "LONG" : "FLAT"} → target ${target ?? "?"}`;
  }
  const strategy = decision.strategySignal ?? decision.action ?? "UNKNOWN";
  const target = decision.targetPosition === null ? "?" : String(decision.targetPosition);
  return `🧠 ${strategy} → target ${target}`;
}

function intentSummary(intent: ObserverIntent): string {
  const block = intent.dispatchBlockReason ? ` — ${sanitizeTerminalText(intent.dispatchBlockReason)}` : "";
  return `🎯 intent ${intent.status}${block}`;
}

function brokerIcon(status: string): string {
  if (status === "ACCEPTED" || status === "FILLED" || status === "PARTIALLY_FILLED") return "✅";
  if (status === "REJECTED" || status === "CANCELLED" || status === "UNKNOWN") return "⛔";
  return "📤";
}

export function renderCurrentState(snapshot: ObserverSnapshot, options: { verbose?: boolean; now?: Date } = {}): string {
  const checkpoint = snapshot.checkpoint;
  const market = classifyStream(checkpoint?.marketStreamState ?? null);
  const trade = classifyStream(checkpoint?.tradeUpdateStreamState ?? null);
  const continuity = classifyContinuity(checkpoint?.featureContinuity ?? null);
  const recovery = classifyRecovery(checkpoint?.recoveryState ?? snapshot.recovery?.state ?? null);
  const lease = classifyLease(snapshot.lease);
  const haltReason = checkpoint?.haltReason ?? snapshot.run?.haltReason;
  const leaseToken = snapshot.lease?.fencingToken === null || !snapshot.lease ? "" : ` token=${snapshot.lease.fencingToken}`;
  const lines = [
    `LIGHTLIGHT / ${snapshot.symbol} PAPER                         ${formatEt((options.now ?? new Date()).toISOString(), true)}`,
    "",
    "CURRENT STATE",
    `${market.icon} MARKET       ${market.label.padEnd(16)} last bar ${formatEt(snapshot.latestRawBarTimestamp)}`,
    `${trade.icon} TRADE FEED   ${trade.label.padEnd(16)} last update ${formatEt(snapshot.latestTradeUpdateAt)}`,
    `${continuity.icon} CONTINUITY   ${continuity.label}`,
    `${recovery.icon} RECOVERY     ${recovery.label}${snapshot.recovery?.missingStartMs === null || !snapshot.recovery ? "" : ` ${formatEt(snapshot.recovery.missingStartMs)}–${formatEt((snapshot.recovery.missingEndMs ?? snapshot.recovery.missingStartMs) - 60_000)}`}`,
    `🔐 OWNERSHIP    ${lease.label}${leaseToken}`,
    `💰 PAPER        position=${snapshot.paperPosition?.quantity ?? "waiting"}  equity=${formatMoney(checkpoint?.paperEquity ?? null)}`,
    haltReason ? `🔴 SAFETY       HALTED — ${sanitizeTerminalText(haltReason)}` : "🟢 SAFETY       no durable halt",
    "",
    "── DECISION TAPE ─────────────────────────────────────────",
  ];
  if (snapshot.decisions.length === 0) {
    lines.push("waiting for first decision");
  } else {
    for (const decision of snapshot.decisions.slice(0, 3)) {
      lines.push(`${formatEt(decision.timestamp)} ${decisionSummary(decision)}`);
      const blockReason = decision.intent?.dispatchBlockReason ?? decision.blockReason;
      if (blockReason) lines.push(`      ⛔ blocked: ${sanitizeTerminalText(blockReason)}`);
      else if (decision.intent) lines.push(`      ${intentSummary(decision.intent)}`);
      if (options.verbose) {
        const reasons = [decision.strategyReason, decision.policyReason, ...decision.riskReasons].filter(Boolean).map((reason) => sanitizeTerminalText(reason)).filter(Boolean);
        if (reasons.length) lines.push(`      🛡 ${reasons.join("; ")}`);
        lines.push(`      id: ${sanitizeIdentifier(decision.decisionId)}`);
      }
    }
  }
  return lines.join("\n");
}

function eventTime(event: ObserverEvent): number {
  if (event.kind === "bar") return event.timestamp ?? 0;
  if (event.kind === "decision") return event.decision.timestamp ?? (Date.parse(event.decision.createdAt ?? "") || 0);
  if (event.kind === "intent") return Date.parse(event.intent.updatedAt ?? "") || 0;
  if (event.kind === "broker") return Date.parse(event.order.observedAt ?? "") || 0;
  if (event.kind === "recovery") return Date.parse(event.recovery.completedAt ?? event.recovery.verifiedAt ?? event.recovery.requestedAt ?? event.recovery.detectedAt ?? "") || 0;
  return Date.parse(event.update.receivedAt ?? "") || 0;
}

export function renderEvent(event: ObserverEvent): string {
  if (event.kind === "bar") return `${formatEt(event.timestamp, true)} 📈 1m bar closed`;
  if (event.kind === "decision") return `${formatEt(event.decision.timestamp, true)} ${decisionSummary(event.decision)}`;
  if (event.kind === "intent") return `${formatEt(event.intent.updatedAt, true)} ${intentSummary(event.intent)}`;
  if (event.kind === "broker") {
    const id = sanitizeIdentifier(event.order.brokerOrderId);
    return `${formatEt(event.order.observedAt, true)} ${brokerIcon(event.order.status)} broker ${event.order.status}${id ? ` id=${id}` : ""}`;
  }
  if (event.kind === "recovery") {
    const recovery = event.recovery;
    const time = recovery.completedAt ?? recovery.verifiedAt ?? recovery.requestedAt ?? recovery.detectedAt;
    const range = recovery.missingStartMs === null ? "" : ` ${formatEt(recovery.missingStartMs)}–${formatEt((recovery.missingEndMs ?? recovery.missingStartMs) - 60_000)}`;
    if (recovery.state === "GAP_DETECTED") return `${formatEt(time, true)} ⚠ gap detected${range}`;
    if (recovery.state === "BACKFILLING") return `${formatEt(time, true)} 🔧 backfill requested SPY/IEX${range}`;
    if (recovery.state === "VERIFYING") return `${formatEt(time, true)} 🔎 backfill verifying ${recovery.returnedBarCount} bar${recovery.returnedBarCount === 1 ? "" : "s"}`;
    if (recovery.state === "HEALTHY") return `${formatEt(time, true)} ✅ backfill verified ${recovery.verifiedBarCount} bar${recovery.verifiedBarCount === 1 ? "" : "s"}; 🧠 continuity restored`;
    return `${formatEt(time, true)} 🟡 recovery rebuilding — ${sanitizeTerminalText(recovery.reason ?? recovery.result ?? "trusted history incomplete")}`;
  }
  const id = sanitizeIdentifier(event.update.clientOrderId);
  return `${formatEt(event.update.receivedAt, true)} 📤 trade update received${id ? ` client=${id}` : ""}`;
}

class BoundedSeen {
  private readonly values = new Set<string>();
  private readonly queue: string[] = [];
  private readonly limit: number;
  constructor(limit = 512) { this.limit = limit; }
  has(value: string): boolean { return this.values.has(value); }
  add(value: string): void {
    if (this.values.has(value)) return;
    this.values.add(value);
    this.queue.push(value);
    while (this.queue.length > this.limit) this.values.delete(this.queue.shift()!);
  }
}

/** Process-memory change detector; construction seeds existing evidence silently. */
export class ObserverChangeDetector {
  private initialized = false;
  private readonly bars = new BoundedSeen();
  private readonly decisions = new BoundedSeen();
  private readonly intents = new BoundedSeen();
  private readonly brokerOrders = new BoundedSeen();
  private readonly tradeUpdates = new BoundedSeen();
  private readonly recoveries = new BoundedSeen();

  observe(snapshot: ObserverSnapshot): ObserverEvent[] {
    const events: ObserverEvent[] = [];
    const add = (seen: BoundedSeen, key: string, event: ObserverEvent) => {
      if (seen.has(key)) return;
      seen.add(key);
      if (this.initialized) events.push(event);
    };
    if (snapshot.latestRawBarTimestamp !== null) add(this.bars, String(snapshot.latestRawBarTimestamp), { kind: "bar", timestamp: snapshot.latestRawBarTimestamp });
    for (const decision of snapshot.decisions) {
      add(this.decisions, decision.decisionId, { kind: "decision", decision });
      if (decision.intent) add(this.intents, `${decision.intent.intentId}:${decision.intent.status}:${decision.intent.dispatchBlockReason ?? ""}`, { kind: "intent", intent: decision.intent });
    }
    for (const order of snapshot.brokerOrders) add(this.brokerOrders, order.eventId, { kind: "broker", order });
    for (const update of snapshot.tradeUpdates) add(this.tradeUpdates, update.updateId, { kind: "trade-update", update });
    if (snapshot.recovery) add(this.recoveries, `${snapshot.recovery.recoveryAttemptId}:${snapshot.recovery.state}:${snapshot.recovery.result ?? ""}`, { kind: "recovery", recovery: snapshot.recovery });
    this.initialized = true;
    return events.sort((left, right) => eventTime(left) - eventTime(right));
  }
}
