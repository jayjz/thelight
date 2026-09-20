import { randomUUID } from "node:crypto";
import type { Sql } from "../db.ts";
import type { BrokerOrderState, BrokerPositionSnapshot } from "./alpaca.server.ts";
import type { ClosedBar, Evidence, ExecutionIntent } from "./types.ts";

export type WorkerCheckpoint = {
  latestRawBarTimestamp: number | null;
  latestClosedDecisionBarTimestamp: number | null;
  latestDecisionId: string | null;
  lastReconciliationTimestamp: string | null;
  /** Legacy summary retained for existing status readers. */
  streamState: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "RECONCILING";
  marketStreamState: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "RECONCILING";
  tradeUpdateStreamState: "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "RECONCILING";
  featureContinuity: "HEALTHY" | "REBUILDING";
  paperEquityHighWater: number | null;
  lastPaperEquity: number | null;
  haltReason: string | null;
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
  claimIntentForDispatch(lease: WorkerLease, intent: ExecutionIntent): Promise<boolean>;
  /**
   * Revalidates and renews the fenced lease under a row lock immediately before
   * the external POST. The lock serializes lease takeover with the bounded POST.
   */
  withDispatchAuthority<T>(lease: WorkerLease, intentId: string, submit: () => Promise<T>): Promise<T | null>;
  insertClosedBar(symbol: string, bar: ClosedBar): Promise<boolean>;
  listClosedBars(symbol: string): Promise<ClosedBar[]>;
  /** Atomically creates immutable evidence and its initial durable intent. */
  persistDecisionAndIntent(evidence: Evidence, intent: ExecutionIntent, dispatchBlockReason?: string | null): Promise<{ inserted: boolean }>;
  putIntent(intent: ExecutionIntent, dispatchBlockReason?: string | null): Promise<void>;
  listIntents(): Promise<StoredIntent[]>;
  appendBrokerOrder(state: BrokerOrderState): Promise<void>;
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
    await sql.query(
      "update worker_runs set state = $2, halt_reason = $3, stopped_at = case when $2 in ('STOPPED', 'HALTED', 'SUPERSEDED') then now() else null end where run_id = $1 and state <> 'SUPERSEDED'",
      [runId, state, haltReason],
    );
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

  async claimIntentForDispatch(lease: WorkerLease, intent: ExecutionIntent): Promise<boolean> {
    const sql = await this.sqlProvider();
    const claimed = { ...intent, status: "SUBMISSION_ATTEMPTED" as const };
    const rows = await sql.query<{ intent_id: string }>(
      "update execution_intents set status = 'SUBMISSION_ATTEMPTED', intent_json = $5, dispatch_block_reason = null, updated_at = now() where intent_id = $1 and status = 'PENDING' and exists (select 1 from worker_leases where worker_key = $2 and owner_run_id = $3 and fencing_token = $4 and lease_expires_at > clock_timestamp()) returning intent_id",
      [intent.intentId, lease.workerKey, lease.runId, lease.fencingToken, JSON.stringify(claimed)],
    );
    return rows.length === 1;
  }

  async withDispatchAuthority<T>(lease: WorkerLease, intentId: string, submit: () => Promise<T>): Promise<T | null> {
    const sql = await this.sqlProvider();
    return sql.transaction(async (tx) => {
      const held = await tx.query<{ worker_key: string }>(
        "select worker_key from worker_leases where worker_key = $1 and owner_run_id = $2 and fencing_token = $3 and lease_expires_at > clock_timestamp() for update",
        [lease.workerKey, lease.runId, lease.fencingToken],
      );
      if (!held[0]) return null;
      const claimed = await tx.query<{ intent_id: string }>(
        "select intent_id from execution_intents where intent_id = $1 and status = 'SUBMISSION_ATTEMPTED' for update",
        [intentId],
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
    const sql = await this.sqlProvider();
    const rows = await sql.query<{ timestamp_ms: number }>(
      "insert into closed_bars (symbol, timestamp_ms, bar_json, received_at) values ($1, $2, $3, $4) on conflict do nothing returning timestamp_ms",
      [symbol, bar.t, JSON.stringify(bar), nowIso()],
    );
    return rows.length === 1;
  }

  async listClosedBars(symbol: string): Promise<ClosedBar[]> {
    const sql = await this.sqlProvider();
    const rows = await sql.query<{ bar_json: string }>("select bar_json from closed_bars where symbol = $1 order by timestamp_ms asc", [symbol]);
    return rows.map((row) => JSON.parse(row.bar_json) as ClosedBar);
  }

  async persistDecisionAndIntent(evidence: Evidence, intent: ExecutionIntent, dispatchBlockReason: string | null = null): Promise<{ inserted: boolean }> {
    const sql = await this.sqlProvider();
    return sql.transaction(async (tx) => {
      const inserted = await tx.query<{ decision_id: string }>(
        "insert into decisions (decision_id, symbol, decision_timestamp_ms, evidence_json, created_at) values ($1, $2, $3, $4, $5) on conflict do nothing returning decision_id",
        [evidence.id, evidence.symbol, evidence.timestamp, JSON.stringify(evidence), nowIso()],
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

  async listIntents(): Promise<StoredIntent[]> {
    const sql = await this.sqlProvider();
    const rows = await sql.query<{ intent_json: string; dispatch_block_reason: string | null }>("select intent_json, dispatch_block_reason from execution_intents order by updated_at asc");
    return rows.map((row) => ({ intent: JSON.parse(row.intent_json) as ExecutionIntent, dispatchBlockReason: row.dispatch_block_reason }));
  }

  async appendBrokerOrder(state: BrokerOrderState): Promise<void> {
    const sql = await this.sqlProvider();
    await sql.query(
      "insert into broker_orders (event_id, intent_id, client_order_id, broker_order_id, status, lookup_state, raw_status, observed_at, state_json) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [randomUUID(), state.intentId, state.clientOrderId, state.brokerOrderId, state.status, state.lookup, state.rawStatus, state.updatedAt ?? nowIso(), JSON.stringify(state)],
    );
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
  private readonly decisions = new Map<string, Evidence>();
  private readonly intents = new Map<string, StoredIntent>();
  private readonly checkpoints = new Map<string, WorkerCheckpoint>();
  private readonly leases = new Map<string, WorkerLease>();
  private readonly runs = new Map<string, { workerKey: string; state: string }>();

  constructor(durable = true) { this.durable = durable; }
  async createRun(runId: string, workerKey: string, state: string): Promise<void> { this.runs.set(runId, { workerKey, state }); }
  async updateRun(runId: string, state: string): Promise<void> { const run = this.runs.get(runId); if (run && run.state !== "SUPERSEDED") run.state = state; }
  async acquireOwnership(workerKey: string, runId: string, leaseSeconds: number): Promise<WorkerLease | null> {
    const prior = this.leases.get(workerKey);
    if (prior && Date.parse(prior.leaseExpiresAt) > Date.now()) return null;
    const lease: WorkerLease = { workerKey, runId, fencingToken: (prior?.fencingToken ?? 0) + 1, leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString() };
    this.leases.set(workerKey, lease);
    for (const [id, run] of this.runs) if (id !== runId && run.workerKey === workerKey && !["STOPPED", "HALTED", "SUPERSEDED"].includes(run.state)) run.state = "SUPERSEDED";
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
  async claimIntentForDispatch(lease: WorkerLease, intent: ExecutionIntent): Promise<boolean> {
    const current = await this.renewOwnership(lease, 30);
    const stored = this.intents.get(intent.intentId);
    if (!current || !stored || stored.intent.status !== "PENDING") return false;
    stored.intent = { ...clone(intent), status: "SUBMISSION_ATTEMPTED" };
    stored.dispatchBlockReason = null;
    return true;
  }
  async withDispatchAuthority<T>(lease: WorkerLease, intentId: string, submit: () => Promise<T>): Promise<T | null> {
    const current = await this.renewOwnership(lease, 30);
    if (!current || this.intents.get(intentId)?.intent.status !== "SUBMISSION_ATTEMPTED") return null;
    return submit();
  }
  async insertClosedBar(symbol: string, bar: ClosedBar): Promise<boolean> {
    const key = `${symbol}:${bar.t}`;
    if (this.bars.has(key)) return false;
    this.bars.set(key, clone(bar));
    return true;
  }
  async listClosedBars(symbol: string): Promise<ClosedBar[]> {
    return [...this.bars.entries()].filter(([key]) => key.startsWith(`${symbol}:`)).map(([, bar]) => clone(bar)).sort((a, b) => a.t - b.t);
  }
  failNextIntentPersistence = false;
  async persistDecisionAndIntent(evidence: Evidence, intent: ExecutionIntent, dispatchBlockReason: string | null = null): Promise<{ inserted: boolean }> {
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
    this.intents.set(intent.intentId, { intent: clone(intent), dispatchBlockReason });
    return { inserted: true };
  }
  async putIntent(intent: ExecutionIntent, dispatchBlockReason: string | null = null): Promise<void> { this.intents.set(intent.intentId, { intent: clone(intent), dispatchBlockReason }); }
  async listIntents(): Promise<StoredIntent[]> { return [...this.intents.values()].map(clone); }
  async appendBrokerOrder(state: BrokerOrderState): Promise<void> { this.posts.push(clone(state)); }
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
}
