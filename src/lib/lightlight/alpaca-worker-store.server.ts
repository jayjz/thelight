import { randomUUID } from "node:crypto";
import type { Sql } from "../db.ts";
import type { BrokerOrderState, BrokerPositionSnapshot } from "./alpaca.server.ts";
import type { ClosedBar, Evidence, ExecutionIntent, ExecutionStatus } from "./types.ts";

import type { DurableMarketEvidence } from "./durable-market-worker.server.ts";

export type WorkerCheckpoint = {
  /** Read-only market runtime evidence, absent on existing execution checkpoints. */
  marketEvidence?: DurableMarketEvidence;
  latestRawBarTimestamp: number | null;
  latestClosedDecisionBarTimestamp: number | null;
  latestDecisionId: string | null;
  lastReconciliationTimestamp: string | null;
  /** Legacy summary retained for existing status readers. */
  streamState: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "RECONCILING";
  marketStreamState: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "RECONCILING";
  tradeUpdateStreamState: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "RECONCILING";
  featureContinuity: "HEALTHY" | "REBUILDING";
  recoveryState: "HEALTHY" | "GAP_DETECTED" | "BACKFILLING" | "VERIFYING" | "REBUILDING";
  recoveryAttemptId: string | null;
  recoveryMissingStartMs: number | null;
  recoveryMissingEndMs: number | null;
  recoveryCompletedAt: string | null;
  recoveryDispatchNotBeforeBucketMs: number | null;
  paperEquityHighWater: number | null;
  lastPaperEquity: number | null;
  /** Last risk-approved long/flat target for target-retention strategies. */
  priorRiskApprovedTarget: 0 | 1 | null;
  haltReason: string | null;
};

export type MarketBarOrigin = "LIVE_WS" | "REST_BACKFILL";
export type MarketBarObservation = {
  symbol: string;
  bar: ClosedBar;
  providerEventTimestampMs: number;
  observedAt: string;
  origin: MarketBarOrigin;
  recoveryAttemptId: string | null;
};
export type MarketBarWriteResult = "ACCEPTED" | "IDENTICAL" | "CONFLICT";
export type GapRecoveryAttempt = {
  recoveryAttemptId: string;
  workerKey: string;
  symbol: string;
  missingStartMs: number;
  missingEndMs: number;
  state: "GAP_DETECTED" | "BACKFILLING" | "VERIFYING" | "HEALTHY" | "REBUILDING";
  detectedAt: string;
  requestedAt?: string | null;
  verifiedAt?: string | null;
  completedAt?: string | null;
  returnedBarCount?: number;
  verifiedBarCount?: number;
  result?: string | null;
  reason?: string | null;
};

export type StoredIntent = {
  intent: ExecutionIntent;
  dispatchBlockReason: string | null;
};

export type WorkerLease = {
  workerKey: string;
  runId: string;
  fencingToken: number;
  leaseExpiresAt: string;
};

/** Minimal durable scope required to bind an intent operation to its runtime. */
export type DurableWorkerScope = {
  workerKey: string;
  asset: { symbol: string };
};

export interface AlpacaWorkerStore {
  /** True only when state survives a process recreation. */
  readonly durable: boolean;
  createRun(runId: string, workerKey: string, state: string): Promise<void>;
  updateRun(runId: string, state: string, haltReason: string | null): Promise<void>;
  /** Atomically acquires an expired/unowned durable lease and fences prior owners. */
  acquireOwnership(workerKey: string, runId: string, leaseSeconds: number): Promise<WorkerLease | null>;
  /** Database-time renewal. A null result means this run has lost authority. */
  renewOwnership(lease: WorkerLease, leaseSeconds: number): Promise<WorkerLease | null>;
  /** Makes this exact lease immediately replaceable; recovery never depends on it. */
  releaseOwnership(lease: WorkerLease): Promise<void>;
  /** Marks PENDING -> SUBMISSION_ATTEMPTED only for the current fenced owner. */
  claimIntentForDispatch(lease: WorkerLease, intent: ExecutionIntent, scope: DurableWorkerScope): Promise<boolean>;
  /**
   * Revalidates and renews the fenced lease under a row lock immediately before
   * the external POST. The lock serializes lease takeover with the bounded POST.
   */
  withDispatchAuthority<T>(lease: WorkerLease, intentId: string, scope: DurableWorkerScope, submit: () => Promise<T>): Promise<T | null>;
  insertClosedBar(symbol: string, bar: ClosedBar): Promise<boolean>;
  recordMarketBar(observation: MarketBarObservation): Promise<MarketBarWriteResult>;
  /** Reads the newest persisted raw bar without loading feature history. */
  latestClosedBarTimestamp(symbol: string): Promise<number | null>;
  /** Optional bounds keep restart recovery reads limited to feature history. */
  listClosedBars(symbol: string, fromTimestampMs?: number, throughTimestampMs?: number): Promise<ClosedBar[]>;
  createGapRecoveryAttempt(attempt: GapRecoveryAttempt): Promise<void>;
  updateGapRecoveryAttempt(attempt: GapRecoveryAttempt): Promise<void>;
  /** Atomically creates immutable evidence and its initial durable intent. */
  persistDecisionAndIntent(workerKey: string, evidence: Evidence, intent: ExecutionIntent, dispatchBlockReason?: string | null): Promise<{ inserted: boolean }>;
  putIntent(intent: ExecutionIntent, dispatchBlockReason?: string | null): Promise<void>;
  listIntents(symbol?: string, workerKey?: string): Promise<StoredIntent[]>;
  /** Append broker evidence and advance its fenced intent projection atomically. */
  recordBrokerOrder(lease: WorkerLease, scope: DurableWorkerScope, state: BrokerOrderState, dispatchBlockReason?: string | null): Promise<ExecutionStatus | null>;
  latestBrokerOrder(intentId: string): Promise<BrokerOrderState | null>;
  appendBrokerPosition(position: BrokerPositionSnapshot): Promise<void>;
  appendTradeUpdate(update: Record<string, unknown>, clientOrderId: string | null): Promise<void>;
  readCheckpoint(workerKey: string): Promise<WorkerCheckpoint | null>;
  writeCheckpoint(workerKey: string, checkpoint: WorkerCheckpoint): Promise<void>;
  /** Prevents a fenced-out callback from overwriting the current owner's checkpoint. */
  writeCheckpointOwned(lease: WorkerLease, checkpoint: WorkerCheckpoint): Promise<boolean>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const nowIso = () => new Date().toISOString();
const terminalStatus = (status: ExecutionStatus) => status === "FILLED" || status === "REJECTED" || status === "CANCELLED";

function projectedBrokerStatus(current: ExecutionStatus, state: BrokerOrderState): ExecutionStatus {
  if (terminalStatus(current)) return current;
  // submit() returns this exact absent state when the reconciled position
  // already matches the target and no order was sent.
  if (state.lookup === "ABSENT") return current === "SUBMISSION_ATTEMPTED" && state.status === "CANCELLED" && !state.brokerOrderId && !state.rawStatus ? "CANCELLED" : current;
  if (state.status === "UNKNOWN") return current === "ACCEPTED" || current === "PARTIALLY_FILLED" ? current : "UNKNOWN";
  if (state.status === "PENDING" || state.status === "SUBMISSION_ATTEMPTED") return current;
  if (state.lookup !== "FOUND" && state.status !== "REJECTED" && state.status !== "CANCELLED") return current;
  if (state.lookup !== "FOUND" && (current === "ACCEPTED" || current === "PARTIALLY_FILLED")) return current;
  if (state.status === "ACCEPTED" && current === "PARTIALLY_FILLED") return current;
  return state.status;
}
async function getWorkerSql(): Promise<Sql> {
  const { getSql } = await import("../db.ts");
  return getSql();
}

/** SQL implementation: Neon is durable; PGlite is intentionally fail-closed for dispatch. */
export class SqlAlpacaWorkerStore implements AlpacaWorkerStore {
  readonly durable = Boolean(process.env.DATABASE_URL?.trim());
  private readonly sqlProvider: () => Promise<Sql>;

  constructor(sqlProvider: () => Promise<Sql> = getWorkerSql) {
    this.sqlProvider = sqlProvider;
  }

  async createRun(runId: string, workerKey: string, state: string): Promise<void> {
    const sql = await this.sqlProvider();
    await sql.query(
      "insert into worker_runs (run_id, worker_key, started_at, state) values ($1, $2, $3, $4) on conflict (run_id) do nothing",
      [runId, workerKey, nowIso(), state],
    );
  }

  async updateRun(runId: string, state: string, haltReason: string | null): Promise<void> {
    const sql = await this.sqlProvider();
    const updated = await sql.query<{ run_id: string }>(
      "update worker_runs set state = $2, halt_reason = $3, stopped_at = case when $2 in ('STOPPED', 'HALTED', 'SUPERSEDED') then coalesce(stopped_at, now()) else null end where run_id = $1 and $2 <> 'SUPERSEDED' and (state = $2 or state not in ('STOPPED', 'HALTED', 'SUPERSEDED')) returning run_id",
      [runId, state, haltReason],
    );
    if (updated.length !== 1) throw new Error("WORKER_RUN_LIFECYCLE_UPDATE_REJECTED");
  }

  async acquireOwnership(workerKey: string, runId: string, leaseSeconds: number): Promise<WorkerLease | null> {
    const sql = await this.sqlProvider();
    return sql.transaction(async (tx) => {
      // INSERT .. ON CONFLICT takes the unique worker-key row lock. Under READ
      // COMMITTED PostgreSQL rechecks this expiry predicate after a contender
      // waiting on that lock wakes, so two contenders cannot both succeed.
      const rows = await tx.query<{ fencing_token: number; lease_expires_at: string }>(
        "insert into worker_leases (worker_key, owner_run_id, fencing_token, lease_expires_at, acquired_at, renewed_at) values ($1, $2, 1, clock_timestamp() + $3::double precision * interval '1 second', clock_timestamp(), clock_timestamp()) on conflict (worker_key) do update set owner_run_id = excluded.owner_run_id, fencing_token = worker_leases.fencing_token + 1, lease_expires_at = clock_timestamp() + $3::double precision * interval '1 second', acquired_at = clock_timestamp(), renewed_at = clock_timestamp() where worker_leases.lease_expires_at <= clock_timestamp() returning fencing_token, lease_expires_at",
        [workerKey, runId, leaseSeconds],
      );
      const row = rows[0];
      if (!row) return null;
      const fencingToken = Number(row.fencing_token);
      await tx.query(
        "update worker_runs set fencing_token = $2 where run_id = $1",
        [runId, fencingToken],
      );
      // This is reached only after the predecessor's lease expired (or after
      // a graceful release made it replaceable), never merely because a second
      // process happened to start.
      await tx.query(
        "update worker_runs set state = 'SUPERSEDED', stopped_at = now(), superseded_by_run_id = $2, superseded_at = now(), supersede_reason = 'SUPERSEDED_BY_DURABLE_LEASE' where worker_key = $1 and run_id <> $2 and stopped_at is null and state not in ('STOPPED', 'HALTED', 'SUPERSEDED')",
        [workerKey, runId],
      );
      return { workerKey, runId, fencingToken, leaseExpiresAt: new Date(row.lease_expires_at).toISOString() };
    });
  }

  async renewOwnership(lease: WorkerLease, leaseSeconds: number): Promise<WorkerLease | null> {
    const sql = await this.sqlProvider();
    const rows = await sql.query<{ lease_expires_at: string }>(
      "update worker_leases set lease_expires_at = clock_timestamp() + $4::double precision * interval '1 second', renewed_at = clock_timestamp() where worker_key = $1 and owner_run_id = $2 and fencing_token = $3 and lease_expires_at > clock_timestamp() returning lease_expires_at",
      [lease.workerKey, lease.runId, lease.fencingToken, leaseSeconds],
    );
    return rows[0] ? { ...lease, leaseExpiresAt: new Date(rows[0].lease_expires_at).toISOString() } : null;
  }

  async releaseOwnership(lease: WorkerLease): Promise<void> {
    const sql = await this.sqlProvider();
    await sql.query(
      "update worker_leases set lease_expires_at = clock_timestamp(), renewed_at = clock_timestamp() where worker_key = $1 and owner_run_id = $2 and fencing_token = $3",
      [lease.workerKey, lease.runId, lease.fencingToken],
    );
  }

  async claimIntentForDispatch(lease: WorkerLease, intent: ExecutionIntent, scope: DurableWorkerScope): Promise<boolean> {
    if (lease.workerKey !== scope.workerKey) return false;
    const sql = await this.sqlProvider();
    const claimed = { ...intent, status: "SUBMISSION_ATTEMPTED" as const };
    const rows = await sql.query<{ intent_id: string }>(
      "update execution_intents set status = 'SUBMISSION_ATTEMPTED', intent_json = $6, dispatch_block_reason = null, updated_at = now() where intent_id = $1 and status = 'PENDING' and exists (select 1 from worker_leases where worker_key = $2 and owner_run_id = $3 and fencing_token = $4 and lease_expires_at > clock_timestamp()) and exists (select 1 from decisions where decision_id = execution_intents.decision_id and symbol = $5 and (worker_key = $2 or worker_key is null)) returning intent_id",
      [intent.intentId, lease.workerKey, lease.runId, lease.fencingToken, scope.asset.symbol, JSON.stringify(claimed)],
    );
    return rows.length === 1;
  }

  async withDispatchAuthority<T>(lease: WorkerLease, intentId: string, scope: DurableWorkerScope, submit: () => Promise<T>): Promise<T | null> {
    if (lease.workerKey !== scope.workerKey) return null;
    const sql = await this.sqlProvider();
    return sql.transaction(async (tx) => {
      const held = await tx.query<{ worker_key: string }>(
        "select worker_key from worker_leases where worker_key = $1 and owner_run_id = $2 and fencing_token = $3 and lease_expires_at > clock_timestamp() for update",
        [lease.workerKey, lease.runId, lease.fencingToken],
      );
      if (!held[0]) return null;
      const claimed = await tx.query<{ intent_id: string }>(
        "select execution_intents.intent_id from execution_intents join decisions on decisions.decision_id = execution_intents.decision_id where execution_intents.intent_id = $1 and execution_intents.status = 'SUBMISSION_ATTEMPTED' and decisions.symbol = $2 and (decisions.worker_key = $3 or decisions.worker_key is null) for update",
        [intentId, scope.asset.symbol, scope.workerKey],
      );
      if (!claimed[0]) return null;
      await tx.query(
        "update worker_leases set lease_expires_at = clock_timestamp() + interval '30 seconds', renewed_at = clock_timestamp() where worker_key = $1 and owner_run_id = $2 and fencing_token = $3",
        [lease.workerKey, lease.runId, lease.fencingToken],
      );
      return submit();
    });
  }

  async insertClosedBar(symbol: string, bar: ClosedBar): Promise<boolean> {
    return (await this.recordMarketBar({ symbol, bar, providerEventTimestampMs: bar.t, observedAt: nowIso(), origin: "LIVE_WS", recoveryAttemptId: null })) === "ACCEPTED";
  }

  async recordMarketBar(observation: MarketBarObservation): Promise<MarketBarWriteResult> {
    const sql = await this.sqlProvider();
    return sql.transaction(async (tx) => {
      const inserted = await tx.query<{ timestamp_ms: number }>(
        "insert into closed_bars (symbol, timestamp_ms, bar_json, received_at) values ($1, $2, $3, $4) on conflict do nothing returning timestamp_ms",
        [observation.symbol, observation.bar.t, JSON.stringify(observation.bar), observation.observedAt],
      );
      let result: MarketBarWriteResult = "ACCEPTED";
      if (inserted.length === 0) {
        const existing = await tx.query<{ bar_json: string }>("select bar_json from closed_bars where symbol = $1 and timestamp_ms = $2", [observation.symbol, observation.bar.t]);
        const prior = existing[0] ? JSON.parse(existing[0].bar_json) as ClosedBar : null;
        result = prior && prior.t === observation.bar.t && prior.open === observation.bar.open && prior.high === observation.bar.high && prior.low === observation.bar.low && prior.close === observation.bar.close && prior.volume === observation.bar.volume ? "IDENTICAL" : "CONFLICT";
      }
      await tx.query(
        "insert into market_bar_observations (observation_id, symbol, timestamp_ms, provider_event_timestamp_ms, observed_at, origin, recovery_attempt_id, verification_result, bar_json) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (symbol, timestamp_ms, origin, recovery_attempt_id) do nothing",
        [randomUUID(), observation.symbol, observation.bar.t, observation.providerEventTimestampMs, observation.observedAt, observation.origin, observation.recoveryAttemptId ?? "", result, JSON.stringify(observation.bar)],
      );
      return result;
    });
  }

  async latestClosedBarTimestamp(symbol: string): Promise<number | null> {
    const sql = await this.sqlProvider();
    const rows = await sql.query<{ timestamp_ms: number | string | null }>("select max(timestamp_ms) as timestamp_ms from closed_bars where symbol = $1", [symbol]);
    const timestamp = rows[0]?.timestamp_ms;
    return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp :
      typeof timestamp === "string" && Number.isFinite(Number(timestamp)) ? Number(timestamp) : null;
  }

  async listClosedBars(symbol: string, fromTimestampMs?: number, throughTimestampMs?: number): Promise<ClosedBar[]> {
    const sql = await this.sqlProvider();
    const rows = await sql.query<{ bar_json: string }>("select bar_json from closed_bars where symbol = $1 and ($2::bigint is null or timestamp_ms >= $2) and ($3::bigint is null or timestamp_ms <= $3) order by timestamp_ms asc", [symbol, fromTimestampMs ?? null, throughTimestampMs ?? null]);
    return rows.map((row) => JSON.parse(row.bar_json) as ClosedBar);
  }

  async createGapRecoveryAttempt(attempt: GapRecoveryAttempt): Promise<void> {
    const sql = await this.sqlProvider();
    await sql.query(
      "insert into market_gap_recovery_attempts (recovery_attempt_id, worker_key, symbol, missing_start_ms, missing_end_ms, state, detected_at, requested_at, verified_at, completed_at, returned_bar_count, verified_bar_count, result, reason) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
      [attempt.recoveryAttemptId, attempt.workerKey, attempt.symbol, attempt.missingStartMs, attempt.missingEndMs, attempt.state, attempt.detectedAt, attempt.requestedAt ?? null, attempt.verifiedAt ?? null, attempt.completedAt ?? null, attempt.returnedBarCount ?? 0, attempt.verifiedBarCount ?? 0, attempt.result ?? null, attempt.reason ?? null],
    );
  }

  async updateGapRecoveryAttempt(attempt: GapRecoveryAttempt): Promise<void> {
    const sql = await this.sqlProvider();
    await sql.query(
      "update market_gap_recovery_attempts set state = $2, requested_at = $3, verified_at = $4, completed_at = $5, returned_bar_count = $6, verified_bar_count = $7, result = $8, reason = $9 where recovery_attempt_id = $1",
      [attempt.recoveryAttemptId, attempt.state, attempt.requestedAt ?? null, attempt.verifiedAt ?? null, attempt.completedAt ?? null, attempt.returnedBarCount ?? 0, attempt.verifiedBarCount ?? 0, attempt.result ?? null, attempt.reason ?? null],
    );
  }

  async persistDecisionAndIntent(workerKey: string, evidence: Evidence, intent: ExecutionIntent, dispatchBlockReason: string | null = null): Promise<{ inserted: boolean }> {
    const sql = await this.sqlProvider();
    return sql.transaction(async (tx) => {
      const inserted = await tx.query<{ decision_id: string }>(
        "insert into decisions (decision_id, worker_key, symbol, decision_timestamp_ms, evidence_json, created_at) values ($1, $2, $3, $4, $5, $6) on conflict do nothing returning decision_id",
        [evidence.id, workerKey, evidence.symbol, evidence.timestamp, JSON.stringify(evidence), nowIso()],
      );
      if (inserted.length === 0) {
        const existing = await tx.query<{ intent_id: string }>("select intent_id from execution_intents where decision_id = $1", [evidence.id]);
        if (existing.length === 0) throw new Error("DURABILITY_INVARIANT_DECISION_WITHOUT_INTENT");
        return { inserted: false };
      }
      const clientOrderId = intent.clientOrderId ?? intent.intentId;
      await tx.query(
        "insert into execution_intents (intent_id, decision_id, client_order_id, status, intent_json, dispatch_block_reason, updated_at) values ($1, $2, $3, $4, $5, $6, $7)",
        [intent.intentId, intent.decisionId, clientOrderId, intent.status, JSON.stringify(intent), dispatchBlockReason, nowIso()],
      );
      return { inserted: true };
    });
  }

  async putIntent(intent: ExecutionIntent, dispatchBlockReason: string | null = null): Promise<void> {
    const sql = await this.sqlProvider();
    const clientOrderId = intent.clientOrderId ?? intent.intentId;
    await sql.query(
      "insert into execution_intents (intent_id, decision_id, client_order_id, status, intent_json, dispatch_block_reason, updated_at) values ($1, $2, $3, $4, $5, $6, $7) on conflict (intent_id) do update set status = excluded.status, intent_json = excluded.intent_json, dispatch_block_reason = excluded.dispatch_block_reason, updated_at = excluded.updated_at",
      [intent.intentId, intent.decisionId, clientOrderId, intent.status, JSON.stringify(intent), dispatchBlockReason, nowIso()],
    );
  }

  async listIntents(symbol?: string, workerKey?: string): Promise<StoredIntent[]> {
    const sql = await this.sqlProvider();
    const rows = await sql.query<{ intent_json: string; dispatch_block_reason: string | null }>("select execution_intents.intent_json, execution_intents.dispatch_block_reason from execution_intents join decisions on decisions.decision_id = execution_intents.decision_id where ($1::text is null or decisions.symbol = $1) and ($2::text is null or decisions.worker_key = $2) order by execution_intents.updated_at asc", [symbol ?? null, workerKey ?? null]);
    return rows.map((row) => ({ intent: JSON.parse(row.intent_json) as ExecutionIntent, dispatchBlockReason: row.dispatch_block_reason }));
  }

  async recordBrokerOrder(lease: WorkerLease, scope: DurableWorkerScope, state: BrokerOrderState, dispatchBlockReason: string | null = null): Promise<ExecutionStatus | null> {
    if (lease.workerKey !== scope.workerKey) return null;
    const sql = await this.sqlProvider();
    return sql.transaction(async (tx) => {
      const held = await tx.query<{ worker_key: string }>(
        "select worker_key from worker_leases where worker_key = $1 and owner_run_id = $2 and fencing_token = $3 and lease_expires_at > clock_timestamp() for update",
        [lease.workerKey, lease.runId, lease.fencingToken],
      );
      if (!held[0]) return null;
      const rows = await tx.query<{ status: ExecutionStatus; intent_json: string }>(
        "select i.status, i.intent_json from execution_intents i join decisions d on d.decision_id = i.decision_id where i.intent_id = $1 and i.decision_id = $2 and i.client_order_id = $3 and d.symbol = $4 and (d.worker_key = $5 or d.worker_key is null) for update of i",
        [state.intentId, state.decisionId, state.clientOrderId, scope.asset.symbol, scope.workerKey],
      );
      if (!rows[0]) return null;
      const prior = await tx.query<{ broker_order_id: string | null }>(
        "select broker_order_id from broker_orders where intent_id = $1 and broker_order_id is not null order by observed_at desc, event_id desc limit 1",
        [state.intentId],
      );
      if (state.brokerOrderId && prior[0]?.broker_order_id && prior[0].broker_order_id !== state.brokerOrderId) return null;
      await tx.query(
        "insert into broker_orders (event_id, intent_id, client_order_id, broker_order_id, status, lookup_state, raw_status, observed_at, state_json) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [randomUUID(), state.intentId, state.clientOrderId, state.brokerOrderId, state.status, state.lookup, state.rawStatus, state.updatedAt ?? nowIso(), JSON.stringify(state)],
      );
      const status = projectedBrokerStatus(rows[0].status, state);
      if (status !== rows[0].status) {
        const intent = JSON.parse(rows[0].intent_json) as ExecutionIntent;
        await tx.query(
          "update execution_intents set status = $2, intent_json = $3, dispatch_block_reason = $4, updated_at = now() where intent_id = $1",
          [state.intentId, status, JSON.stringify({ ...intent, status }), dispatchBlockReason],
        );
      }
      return status;
    });
  }

  async latestBrokerOrder(intentId: string): Promise<BrokerOrderState | null> {
    const sql = await this.sqlProvider();
    const rows = await sql.query<{ state_json: string }>("select state_json from broker_orders where intent_id = $1 order by observed_at desc, event_id desc limit 1", [intentId]);
    return rows[0] ? JSON.parse(rows[0].state_json) as BrokerOrderState : null;
  }

  async appendBrokerPosition(position: BrokerPositionSnapshot): Promise<void> {
    const sql = await this.sqlProvider();
    await sql.query(
      "insert into broker_positions (position_id, symbol, quantity, reconciled_at, position_json) values ($1, $2, $3, $4, $5)",
      [randomUUID(), position.symbol, position.quantity, position.reconciledAt, JSON.stringify(position)],
    );
  }

  async appendTradeUpdate(update: Record<string, unknown>, clientOrderId: string | null): Promise<void> {
    const sql = await this.sqlProvider();
    await sql.query("insert into trade_updates (update_id, client_order_id, received_at, update_json) values ($1, $2, $3, $4)", [randomUUID(), clientOrderId, nowIso(), JSON.stringify(update)]);
  }

  async readCheckpoint(workerKey: string): Promise<WorkerCheckpoint | null> {
    const sql = await this.sqlProvider();
    const rows = await sql.query<{ checkpoint_json: string }>("select checkpoint_json from runtime_checkpoint where worker_key = $1", [workerKey]);
    return rows[0] ? JSON.parse(rows[0].checkpoint_json) as WorkerCheckpoint : null;
  }

  async writeCheckpoint(workerKey: string, checkpoint: WorkerCheckpoint): Promise<void> {
    const sql = await this.sqlProvider();
    await sql.query(
      "insert into runtime_checkpoint (worker_key, checkpoint_json, updated_at) values ($1, $2, $3) on conflict (worker_key) do update set checkpoint_json = excluded.checkpoint_json, updated_at = excluded.updated_at",
      [workerKey, JSON.stringify(checkpoint), nowIso()],
    );
  }

  async writeCheckpointOwned(lease: WorkerLease, checkpoint: WorkerCheckpoint): Promise<boolean> {
    const sql = await this.sqlProvider();
    const rows = await sql.query<{ worker_key: string }>(
      "insert into runtime_checkpoint (worker_key, checkpoint_json, updated_at) select $1, $4, now() where exists (select 1 from worker_leases where worker_key = $1 and owner_run_id = $2 and fencing_token = $3 and lease_expires_at > clock_timestamp()) on conflict (worker_key) do update set checkpoint_json = excluded.checkpoint_json, updated_at = excluded.updated_at where exists (select 1 from worker_leases where worker_key = $1 and owner_run_id = $2 and fencing_token = $3 and lease_expires_at > clock_timestamp()) returning worker_key",
      [lease.workerKey, lease.runId, lease.fencingToken, JSON.stringify(checkpoint)],
    );
    return rows.length === 1;
  }
}

/** Small deterministic in-memory store for unit/integration tests only. */
export class MemoryAlpacaWorkerStore implements AlpacaWorkerStore {
  readonly durable: boolean;
  readonly posts: BrokerOrderState[] = [];
  readonly updates: Array<{ update: Record<string, unknown>; clientOrderId: string | null }> = [];
  checkpointReads = 0;
  private readonly bars = new Map<string, ClosedBar>();
  private readonly observations: Array<MarketBarObservation & { verificationResult: MarketBarWriteResult }> = [];
  private readonly recoveryAttempts = new Map<string, GapRecoveryAttempt>();
  private readonly decisions = new Map<string, Evidence>();
  private readonly decisionWorkerKeys = new Map<string, string>();
  private readonly intents = new Map<string, StoredIntent>();
  private readonly checkpoints = new Map<string, WorkerCheckpoint>();
  private readonly leases = new Map<string, WorkerLease>();
  private readonly runs = new Map<string, { workerKey: string; state: string; haltReason: string | null; stoppedAt: string | null; supersededByRunId: string | null; supersededAt: string | null; supersedeReason: string | null }>();
  readonly runTransitions: Array<{ runId: string; state: string }> = [];

  constructor(durable = true) { this.durable = durable; }
  async createRun(runId: string, workerKey: string, state: string): Promise<void> {
    this.runs.set(runId, { workerKey, state, haltReason: null, stoppedAt: null, supersededByRunId: null, supersededAt: null, supersedeReason: null });
    this.runTransitions.push({ runId, state });
  }
  async updateRun(runId: string, state: string, haltReason: string | null): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || state === "SUPERSEDED" || (run.state !== state && ["STOPPED", "HALTED", "SUPERSEDED"].includes(run.state))) throw new Error("WORKER_RUN_LIFECYCLE_UPDATE_REJECTED");
    run.state = state;
    run.haltReason = haltReason;
    if (["STOPPED", "HALTED"].includes(state)) run.stoppedAt ??= nowIso();
    else run.stoppedAt = null;
    this.runTransitions.push({ runId, state });
  }
  runEvidence(runId: string) { const run = this.runs.get(runId); return run ? clone(run) : null; }
  allRunEvidence() { return [...this.runs.entries()].map(([runId, run]) => ({ runId, ...clone(run) })); }
  leaseEvidence(workerKey: string) { const lease = this.leases.get(workerKey); return lease ? clone(lease) : null; }
  async acquireOwnership(workerKey: string, runId: string, leaseSeconds: number): Promise<WorkerLease | null> {
    const prior = this.leases.get(workerKey);
    if (prior && Date.parse(prior.leaseExpiresAt) > Date.now()) return null;
    const lease: WorkerLease = { workerKey, runId, fencingToken: (prior?.fencingToken ?? 0) + 1, leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString() };
    this.leases.set(workerKey, lease);
    for (const [id, run] of this.runs) if (id !== runId && run.workerKey === workerKey && !["STOPPED", "HALTED", "SUPERSEDED"].includes(run.state)) {
      run.state = "SUPERSEDED";
      run.stoppedAt ??= nowIso();
      run.supersededByRunId = runId;
      run.supersededAt ??= nowIso();
      run.supersedeReason ??= "SUPERSEDED_BY_DURABLE_LEASE";
      this.runTransitions.push({ runId: id, state: "SUPERSEDED" });
    }
    return clone(lease);
  }
  async renewOwnership(lease: WorkerLease, leaseSeconds: number): Promise<WorkerLease | null> {
    const current = this.leases.get(lease.workerKey);
    if (!current || current.runId !== lease.runId || current.fencingToken !== lease.fencingToken || Date.parse(current.leaseExpiresAt) <= Date.now()) return null;
    current.leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    return clone(current);
  }
  async releaseOwnership(lease: WorkerLease): Promise<void> {
    const current = this.leases.get(lease.workerKey);
    if (current && current.runId === lease.runId && current.fencingToken === lease.fencingToken) current.leaseExpiresAt = new Date(0).toISOString();
  }
  async claimIntentForDispatch(lease: WorkerLease, intent: ExecutionIntent, scope: DurableWorkerScope): Promise<boolean> {
    const current = await this.renewOwnership(lease, 30);
    const stored = this.intents.get(intent.intentId);
    if (lease.workerKey !== scope.workerKey || !current || !stored || stored.intent.status !== "PENDING" || this.decisions.get(stored.intent.decisionId)?.symbol !== scope.asset.symbol || this.decisionWorkerKeys.get(stored.intent.decisionId) !== scope.workerKey) return false;
    stored.intent = { ...clone(intent), status: "SUBMISSION_ATTEMPTED" };
    stored.dispatchBlockReason = null;
    return true;
  }
  async withDispatchAuthority<T>(lease: WorkerLease, intentId: string, scope: DurableWorkerScope, submit: () => Promise<T>): Promise<T | null> {
    const current = await this.renewOwnership(lease, 30);
    const stored = this.intents.get(intentId);
    if (lease.workerKey !== scope.workerKey || !current || stored?.intent.status !== "SUBMISSION_ATTEMPTED" || this.decisions.get(stored.intent.decisionId)?.symbol !== scope.asset.symbol || this.decisionWorkerKeys.get(stored.intent.decisionId) !== scope.workerKey) return null;
    return submit();
  }
  async insertClosedBar(symbol: string, bar: ClosedBar): Promise<boolean> {
    return (await this.recordMarketBar({ symbol, bar, providerEventTimestampMs: bar.t, observedAt: nowIso(), origin: "LIVE_WS", recoveryAttemptId: null })) === "ACCEPTED";
  }
  async recordMarketBar(observation: MarketBarObservation): Promise<MarketBarWriteResult> {
    const key = `${observation.symbol}:${observation.bar.t}`;
    const prior = this.bars.get(key);
    const result: MarketBarWriteResult = !prior ? "ACCEPTED" :
      prior.t === observation.bar.t && prior.open === observation.bar.open && prior.high === observation.bar.high && prior.low === observation.bar.low && prior.close === observation.bar.close && prior.volume === observation.bar.volume ? "IDENTICAL" : "CONFLICT";
    if (!prior) this.bars.set(key, clone(observation.bar));
    const duplicate = this.observations.some((existing) => existing.symbol === observation.symbol && existing.bar.t === observation.bar.t && existing.origin === observation.origin && existing.recoveryAttemptId === observation.recoveryAttemptId);
    if (!duplicate) this.observations.push({ ...clone(observation), verificationResult: result });
    return result;
  }
  async latestClosedBarTimestamp(symbol: string): Promise<number | null> {
    const timestamps = [...this.bars.entries()]
      .filter(([key]) => key.startsWith(`${symbol}:`))
      .map(([, bar]) => bar.t);
    return timestamps.length === 0 ? null : Math.max(...timestamps);
  }
  async listClosedBars(symbol: string, fromTimestampMs?: number, throughTimestampMs?: number): Promise<ClosedBar[]> {
    return [...this.bars.entries()].filter(([key, bar]) => key.startsWith(`${symbol}:`) &&
      (fromTimestampMs === undefined || bar.t >= fromTimestampMs) &&
      (throughTimestampMs === undefined || bar.t <= throughTimestampMs)).map(([, bar]) => clone(bar)).sort((a, b) => a.t - b.t);
  }
  async createGapRecoveryAttempt(attempt: GapRecoveryAttempt): Promise<void> { this.recoveryAttempts.set(attempt.recoveryAttemptId, clone(attempt)); }
  async updateGapRecoveryAttempt(attempt: GapRecoveryAttempt): Promise<void> { this.recoveryAttempts.set(attempt.recoveryAttemptId, clone(attempt)); }
  failNextIntentPersistence = false;
  async persistDecisionAndIntent(workerKey: string, evidence: Evidence, intent: ExecutionIntent, dispatchBlockReason: string | null = null): Promise<{ inserted: boolean }> {
    if (this.decisions.has(evidence.id)) {
      if (![...this.intents.values()].some((stored) => stored.intent.decisionId === evidence.id)) throw new Error("DURABILITY_INVARIANT_DECISION_WITHOUT_INTENT");
      return { inserted: false };
    }
    // Stage copies before mutating either map. This mirrors the all-or-nothing
    // contract exercised by the SQL transaction without pretending it is SQL.
    if (this.failNextIntentPersistence) {
      this.failNextIntentPersistence = false;
      throw new Error("INTENT_PERSISTENCE_FAILED");
    }
    this.decisions.set(evidence.id, clone(evidence));
    this.decisionWorkerKeys.set(evidence.id, workerKey);
    this.intents.set(intent.intentId, { intent: clone(intent), dispatchBlockReason });
    return { inserted: true };
  }
  async putIntent(intent: ExecutionIntent, dispatchBlockReason: string | null = null): Promise<void> { this.intents.set(intent.intentId, { intent: clone(intent), dispatchBlockReason }); }
  async listIntents(symbol?: string, workerKey?: string): Promise<StoredIntent[]> {
    return [...this.intents.values()]
      .filter((stored) => (!symbol || this.decisions.get(stored.intent.decisionId)?.symbol === symbol) && (!workerKey || this.decisionWorkerKeys.get(stored.intent.decisionId) === workerKey))
      .map(clone);
  }
  async recordBrokerOrder(lease: WorkerLease, scope: DurableWorkerScope, state: BrokerOrderState, dispatchBlockReason: string | null = null): Promise<ExecutionStatus | null> {
    const current = this.leases.get(lease.workerKey);
    const stored = this.intents.get(state.intentId);
    if (lease.workerKey !== scope.workerKey || !current || current.runId !== lease.runId || current.fencingToken !== lease.fencingToken || Date.parse(current.leaseExpiresAt) <= Date.now() ||
      !stored || stored.intent.decisionId !== state.decisionId || (stored.intent.clientOrderId ?? stored.intent.intentId) !== state.clientOrderId ||
      this.decisions.get(state.decisionId)?.symbol !== scope.asset.symbol || this.decisionWorkerKeys.get(state.decisionId) !== scope.workerKey) return null;
    const prior = [...this.posts].reverse().find((order) => order.intentId === state.intentId && order.brokerOrderId);
    if (state.brokerOrderId && prior?.brokerOrderId && prior.brokerOrderId !== state.brokerOrderId) return null;
    this.posts.push(clone(state));
    const status = projectedBrokerStatus(stored.intent.status, state);
    if (status !== stored.intent.status) {
      stored.intent = { ...stored.intent, status };
      stored.dispatchBlockReason = dispatchBlockReason;
    }
    return status;
  }
  async latestBrokerOrder(intentId: string): Promise<BrokerOrderState | null> {
    return clone([...this.posts].reverse().find((state) => state.intentId === intentId) ?? null);
  }
  async appendBrokerPosition(): Promise<void> {}
  async appendTradeUpdate(update: Record<string, unknown>, clientOrderId: string | null): Promise<void> { this.updates.push({ update: clone(update), clientOrderId }); }
  async readCheckpoint(workerKey: string): Promise<WorkerCheckpoint | null> { this.checkpointReads += 1; return this.checkpoints.has(workerKey) ? clone(this.checkpoints.get(workerKey)!) : null; }
  async writeCheckpoint(workerKey: string, checkpoint: WorkerCheckpoint): Promise<void> { this.checkpoints.set(workerKey, clone(checkpoint)); }
  async writeCheckpointOwned(lease: WorkerLease, checkpoint: WorkerCheckpoint): Promise<boolean> {
    if (!await this.renewOwnership(lease, 30)) return false;
    this.checkpoints.set(lease.workerKey, clone(checkpoint));
    return true;
  }
  decisionCount(): number { return this.decisions.size; }
  intentCount(): number { return this.intents.size; }
  decisionEvidence(): Evidence[] { return [...this.decisions.values()].map(clone); }
  marketObservations(): Array<MarketBarObservation & { verificationResult: MarketBarWriteResult }> { return this.observations.map(clone); }
  recoveryAttempt(id: string): GapRecoveryAttempt | null { return this.recoveryAttempts.has(id) ? clone(this.recoveryAttempts.get(id)!) : null; }
}
