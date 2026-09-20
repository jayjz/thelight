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

export interface AlpacaWorkerStore {
  /** True only when state survives a process recreation. */
  readonly durable: boolean;
  createRun(runId: string, state: string): Promise<void>;
  updateRun(runId: string, state: string, haltReason: string | null): Promise<void>;
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

  async createRun(runId: string, state: string): Promise<void> {
    const sql = await getWorkerSql();
    await sql.query(
      "insert into worker_runs (run_id, started_at, state) values ($1, $2, $3) on conflict (run_id) do nothing",
      [runId, nowIso(), state],
    );
  }

  async updateRun(runId: string, state: string, haltReason: string | null): Promise<void> {
    const sql = await getWorkerSql();
    await sql.query("update worker_runs set state = $2, halt_reason = $3, stopped_at = case when $2 in ('STOPPED', 'HALTED') then $4 else null end where run_id = $1", [runId, state, haltReason, nowIso()]);
  }

  async insertClosedBar(symbol: string, bar: ClosedBar): Promise<boolean> {
    const sql = await getWorkerSql();
    const rows = await sql.query<{ timestamp_ms: number }>(
      "insert into closed_bars (symbol, timestamp_ms, bar_json, received_at) values ($1, $2, $3, $4) on conflict do nothing returning timestamp_ms",
      [symbol, bar.t, JSON.stringify(bar), nowIso()],
    );
    return rows.length === 1;
  }

  async listClosedBars(symbol: string): Promise<ClosedBar[]> {
    const sql = await getWorkerSql();
    const rows = await sql.query<{ bar_json: string }>("select bar_json from closed_bars where symbol = $1 order by timestamp_ms asc", [symbol]);
    return rows.map((row) => JSON.parse(row.bar_json) as ClosedBar);
  }

  async persistDecisionAndIntent(evidence: Evidence, intent: ExecutionIntent, dispatchBlockReason: string | null = null): Promise<{ inserted: boolean }> {
    const sql = await getWorkerSql();
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
    const sql = await getWorkerSql();
    const clientOrderId = intent.clientOrderId ?? intent.intentId;
    await sql.query(
      "insert into execution_intents (intent_id, decision_id, client_order_id, status, intent_json, dispatch_block_reason, updated_at) values ($1, $2, $3, $4, $5, $6, $7) on conflict (intent_id) do update set status = excluded.status, intent_json = excluded.intent_json, dispatch_block_reason = excluded.dispatch_block_reason, updated_at = excluded.updated_at",
      [intent.intentId, intent.decisionId, clientOrderId, intent.status, JSON.stringify(intent), dispatchBlockReason, nowIso()],
    );
  }

  async listIntents(): Promise<StoredIntent[]> {
    const sql = await getWorkerSql();
    const rows = await sql.query<{ intent_json: string; dispatch_block_reason: string | null }>("select intent_json, dispatch_block_reason from execution_intents order by updated_at asc");
    return rows.map((row) => ({ intent: JSON.parse(row.intent_json) as ExecutionIntent, dispatchBlockReason: row.dispatch_block_reason }));
  }

  async appendBrokerOrder(state: BrokerOrderState): Promise<void> {
    const sql = await getWorkerSql();
    await sql.query(
      "insert into broker_orders (event_id, intent_id, client_order_id, broker_order_id, status, lookup_state, raw_status, observed_at, state_json) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [randomUUID(), state.intentId, state.clientOrderId, state.brokerOrderId, state.status, state.lookup, state.rawStatus, state.updatedAt ?? nowIso(), JSON.stringify(state)],
    );
  }

  async latestBrokerOrder(intentId: string): Promise<BrokerOrderState | null> {
    const sql = await getWorkerSql();
    const rows = await sql.query<{ state_json: string }>("select state_json from broker_orders where intent_id = $1 order by observed_at desc, event_id desc limit 1", [intentId]);
    return rows[0] ? JSON.parse(rows[0].state_json) as BrokerOrderState : null;
  }

  async appendBrokerPosition(position: BrokerPositionSnapshot): Promise<void> {
    const sql = await getWorkerSql();
    await sql.query(
      "insert into broker_positions (position_id, symbol, quantity, reconciled_at, position_json) values ($1, $2, $3, $4, $5)",
      [randomUUID(), position.symbol, position.quantity, position.reconciledAt, JSON.stringify(position)],
    );
  }

  async appendTradeUpdate(update: Record<string, unknown>, clientOrderId: string | null): Promise<void> {
    const sql = await getWorkerSql();
    await sql.query("insert into trade_updates (update_id, client_order_id, received_at, update_json) values ($1, $2, $3, $4)", [randomUUID(), clientOrderId, nowIso(), JSON.stringify(update)]);
  }

  async readCheckpoint(workerKey: string): Promise<WorkerCheckpoint | null> {
    const sql = await getWorkerSql();
    const rows = await sql.query<{ checkpoint_json: string }>("select checkpoint_json from runtime_checkpoint where worker_key = $1", [workerKey]);
    return rows[0] ? JSON.parse(rows[0].checkpoint_json) as WorkerCheckpoint : null;
  }

  async writeCheckpoint(workerKey: string, checkpoint: WorkerCheckpoint): Promise<void> {
    const sql = await getWorkerSql();
    await sql.query(
      "insert into runtime_checkpoint (worker_key, checkpoint_json, updated_at) values ($1, $2, $3) on conflict (worker_key) do update set checkpoint_json = excluded.checkpoint_json, updated_at = excluded.updated_at",
      [workerKey, JSON.stringify(checkpoint), nowIso()],
    );
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

  constructor(durable = true) { this.durable = durable; }
  async createRun(): Promise<void> {}
  async updateRun(): Promise<void> {}
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
  decisionCount(): number { return this.decisions.size; }
  intentCount(): number { return this.intents.size; }
  decisionEvidence(): Evidence[] { return [...this.decisions.values()].map(clone); }
}
