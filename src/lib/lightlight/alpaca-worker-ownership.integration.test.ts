import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import type { Sql } from "../db.ts";
import { SqlAlpacaWorkerStore } from "./alpaca-worker-store.server.ts";
import type { ExecutionIntent } from "./types.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_REQUIRED_FOR_ALPACA_WORKER_OWNERSHIP_INTEGRATION_TEST");

type Client = InstanceType<typeof pg.Client>;

function sqlFor(client: Client): Sql {
  const sql = (async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? "";
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1] ?? ""}`;
    return (await client.query(text, values)).rows as T[];
  }) as Sql;
  sql.query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await client.query(text, params)).rows as T[];
  sql.transaction = async <T>(callback: (tx: Sql) => Promise<T>) => {
    await client.query("BEGIN");
    try {
      const result = await callback(sqlForTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  };
  return sql;
}

function sqlForTransaction(client: Client): Sql {
  const sql = sqlFor(client);
  sql.transaction = async <T>(callback: (tx: Sql) => Promise<T>) => callback(sql);
  return sql;
}

function intent(scope: string): ExecutionIntent {
  return {
    intentId: `${scope}:intent`, decisionId: `${scope}:decision`, createdAtBar: 0, createdAtTimestamp: Date.now(),
    desiredAction: "LONG", desiredPosition: 1, status: "PENDING", executionModel: "ALPACA_PAPER", clientOrderId: `${scope}:client`,
  };
}

async function seedIntent(client: Client, value: ExecutionIntent): Promise<void> {
  await client.query(
    "insert into decisions (decision_id, symbol, decision_timestamp_ms, evidence_json, created_at) values ($1, 'SPY', $2, '{}', now())",
    [value.decisionId, value.createdAtTimestamp],
  );
  await client.query(
    "insert into execution_intents (intent_id, decision_id, client_order_id, status, intent_json, dispatch_block_reason, updated_at) values ($1, $2, $3, 'PENDING', $4, null, now())",
    [value.intentId, value.decisionId, value.clientOrderId, JSON.stringify(value)],
  );
}

describe("Alpaca PAPER durable ownership (real Postgres, independent connections)", () => {
  const scope = `__test_alpaca_ownership_${randomUUID()}`;
  const clientA = new pg.Client({ connectionString: databaseUrl });
  const clientB = new pg.Client({ connectionString: databaseUrl });
  const cleanup = new pg.Client({ connectionString: databaseUrl });
  const storeA = new SqlAlpacaWorkerStore(async () => sqlFor(clientA));
  const storeB = new SqlAlpacaWorkerStore(async () => sqlFor(clientB));

  before(async () => {
    await Promise.all([clientA.connect(), clientB.connect(), cleanup.connect()]);
  });

  after(async () => {
    // Every identifier is under this test-only random prefix. Never truncate or
    // delete general worker evidence from the shared Neon database.
    await cleanup.query("delete from worker_leases where worker_key like $1", [`${scope}%`]);
    await cleanup.query("delete from execution_intents where intent_id like $1", [`${scope}%`]);
    await cleanup.query("delete from decisions where decision_id like $1", [`${scope}%`]);
    await cleanup.query("delete from worker_runs where run_id like $1", [`${scope}%`]);
    await Promise.all([clientA.end(), clientB.end(), cleanup.end()]);
  });

  it("has the migrated lease primary key and fencing/run evidence columns", async () => {
    const primaryKey = await cleanup.query<{ count: string }>(
      "select count(*) from information_schema.table_constraints where table_schema = current_schema() and table_name = 'worker_leases' and constraint_type = 'PRIMARY KEY'",
    );
    const columns = await cleanup.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = current_schema() and table_name = 'worker_runs' and column_name in ('worker_key', 'fencing_token', 'superseded_by_run_id', 'superseded_at', 'supersede_reason')",
    );
    assert.equal(Number(primaryKey.rows[0]?.count), 1);
    assert.equal(columns.rows.length, 5);
  });

  it("allows exactly one concurrent contender to acquire one worker key", async () => {
    const key = `${scope}:race`;
    const runA = `${scope}:race:a`; const runB = `${scope}:race:b`;
    await Promise.all([storeA.createRun(runA, key, "STARTING"), storeB.createRun(runB, key, "STARTING")]);
    const [leaseA, leaseB] = await Promise.all([storeA.acquireOwnership(key, runA, 30), storeB.acquireOwnership(key, runB, 30)]);
    assert.equal([leaseA, leaseB].filter(Boolean).length, 1);
    assert.equal((leaseA ?? leaseB)?.fencingToken, 1);
  });

  it("fences a stale owner and permits only the new owner to claim one intent", async () => {
    const key = `${scope}:fence`; const runA = `${scope}:fence:a`; const runB = `${scope}:fence:b`;
    const value = intent(`${scope}:fence`);
    await Promise.all([storeA.createRun(runA, key, "READY"), storeB.createRun(runB, key, "STARTING"), seedIntent(cleanup, value)]);
    const leaseA = await storeA.acquireOwnership(key, runA, 30);
    assert.ok(leaseA);
    await cleanup.query("update worker_leases set lease_expires_at = now() - interval '1 second' where worker_key = $1", [key]);
    const leaseB = await storeB.acquireOwnership(key, runB, 30);
    assert.ok(leaseB); assert.equal(leaseB.fencingToken, leaseA.fencingToken + 1);

    const [staleClaim, currentClaim] = await Promise.all([
      storeA.claimIntentForDispatch(leaseA, value),
      storeB.claimIntentForDispatch(leaseB, value),
    ]);
    assert.equal(staleClaim, false);
    assert.equal(currentClaim, true);
    const rows = await cleanup.query<{ status: string }>("select status from execution_intents where intent_id = $1", [value.intentId]);
    assert.deepEqual(rows.rows.map((row) => row.status), ["SUBMISSION_ATTEMPTED"]);
  });

  it("supersedes a genuinely abandoned run without altering decision evidence", async () => {
    const key = `${scope}:crash`; const runA = `${scope}:crash:a`; const runB = `${scope}:crash:b`;
    const value = intent(`${scope}:crash`);
    await Promise.all([storeA.createRun(runA, key, "READY"), storeB.createRun(runB, key, "STARTING"), seedIntent(cleanup, value)]);
    assert.ok(await storeA.acquireOwnership(key, runA, 30));
    await cleanup.query("update worker_leases set lease_expires_at = now() - interval '1 second' where worker_key = $1", [key]);
    const leaseB = await storeB.acquireOwnership(key, runB, 30);
    assert.ok(leaseB);
    const prior = await cleanup.query<{ state: string; superseded_by_run_id: string; stopped_at: string | null }>("select state, superseded_by_run_id, stopped_at from worker_runs where run_id = $1", [runA]);
    assert.deepEqual(prior.rows[0] && { state: prior.rows[0].state, supersededBy: prior.rows[0].superseded_by_run_id, stopped: Boolean(prior.rows[0].stopped_at) }, { state: "SUPERSEDED", supersededBy: runB, stopped: true });
    const evidence = await cleanup.query("select decision_id from decisions where decision_id = $1", [value.decisionId]);
    assert.equal(evidence.rowCount, 1);
  });

  it("fails closed on an unavailable ownership validation and releases gracefully", async () => {
    const key = `${scope}:release`; const runA = `${scope}:release:a`; const runB = `${scope}:release:b`;
    const value = intent(`${scope}:release`);
    await Promise.all([storeA.createRun(runA, key, "READY"), storeB.createRun(runB, key, "STARTING"), seedIntent(cleanup, value)]);
    const leaseA = await storeA.acquireOwnership(key, runA, 30);
    assert.ok(leaseA);
    const unavailable = new SqlAlpacaWorkerStore(async () => { throw new Error("TEST_DB_UNAVAILABLE"); });
    await assert.rejects(() => unavailable.claimIntentForDispatch(leaseA, value), /TEST_DB_UNAVAILABLE/);
    const pending = await cleanup.query<{ status: string }>("select status from execution_intents where intent_id = $1", [value.intentId]);
    assert.equal(pending.rows[0]?.status, "PENDING");

    await storeA.updateRun(runA, "STOPPED", null);
    await storeA.releaseOwnership(leaseA);
    const leaseB = await storeB.acquireOwnership(key, runB, 30);
    assert.ok(leaseB); assert.equal(leaseB.fencingToken, leaseA.fencingToken + 1);
  });

  it("does not accept a stale fencing token at the locked pre-POST boundary", async () => {
    const key = `${scope}:guard`; const runA = `${scope}:guard:a`; const runB = `${scope}:guard:b`;
    const value = intent(`${scope}:guard`);
    await Promise.all([storeA.createRun(runA, key, "READY"), storeB.createRun(runB, key, "STARTING"), seedIntent(cleanup, value)]);
    const leaseA = await storeA.acquireOwnership(key, runA, 30);
    assert.ok(leaseA);
    await cleanup.query("update worker_leases set lease_expires_at = now() - interval '1 second' where worker_key = $1", [key]);
    const leaseB = await storeB.acquireOwnership(key, runB, 30);
    assert.ok(leaseB);
    // The marker is legitimately owned by B; A's once-valid token cannot
    // enter the final guarded callback after takeover.
    assert.equal(await storeB.claimIntentForDispatch(leaseB, value), true);
    let posted = false;
    const result = await storeA.withDispatchAuthority(leaseA, value.intentId, async () => { posted = true; return "posted"; });
    assert.equal(result, null); assert.equal(posted, false);
    assert.equal(await storeA.writeCheckpointOwned(leaseA, {} as never), false, "a stale callback cannot overwrite the current owner's checkpoint");
  });
});
