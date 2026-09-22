#!/usr/bin/env node
import pg from "pg";
import { pathToFileURL } from "node:url";
import type { Sql } from "../src/lib/db.ts";
import { env } from "../src/lib/env.server.ts";
import { AlpacaCryptoMarketSource, loadAlpacaCryptoCredentials } from "../src/lib/lightlight/alpaca-crypto.server.ts";
import { SqlAlpacaWorkerStore } from "../src/lib/lightlight/alpaca-worker-store.server.ts";
import { DurableMarketWorker, type DurableMarketStore } from "../src/lib/lightlight/durable-market-worker.server.ts";
import { BTC_USD_RUNTIME_IDENTITY, assertReadOnlyDurable } from "../src/lib/lightlight/runtime-identity.ts";

/** Actual object capability: the worker never receives broker/intent store methods. */
export function marketStoreOnly(store: SqlAlpacaWorkerStore): DurableMarketStore {
  return {
    durable: store.durable,
    createRun: store.createRun.bind(store), updateRun: store.updateRun.bind(store),
    acquireOwnership: store.acquireOwnership.bind(store), renewOwnership: store.renewOwnership.bind(store),
    releaseOwnership: store.releaseOwnership.bind(store), recordMarketBar: store.recordMarketBar.bind(store),
    latestClosedBarTimestamp: store.latestClosedBarTimestamp.bind(store), listClosedBars: store.listClosedBars.bind(store),
    readCheckpoint: store.readCheckpoint.bind(store), writeCheckpointOwned: store.writeCheckpointOwned.bind(store),
  };
}

export function createBtcMarketWorker(store: DurableMarketStore, source: AlpacaCryptoMarketSource): DurableMarketWorker {
  assertReadOnlyDurable(BTC_USD_RUNTIME_IDENTITY);
  return new DurableMarketWorker({ identity: BTC_USD_RUNTIME_IDENTITY, store, source });
}

type Worker = Pick<DurableMarketWorker, "start" | "stop" | "snapshot">;
type Signals = Pick<NodeJS.Process, "on" | "removeListener">;
export async function runBtcWorker(worker: Worker, signals: Signals = process, log: (value: unknown) => void = (value) => console.log(JSON.stringify(value))): Promise<number> {
  let stopping: Promise<void> | null = null;
  let release!: () => void;
  const finished = new Promise<void>((resolve) => { release = resolve; });
  let failure = false;
  const stop = () => {
    stopping ??= worker.stop().catch(() => { failure = true; }).finally(release);
  };
  // Install before startup: termination during authentication/recovery is graceful too.
  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);
  const monitor = setInterval(() => { if (worker.snapshot().state === "HALTED") { failure = true; stop(); } }, 250);
  try {
    await worker.start();
    if (stopping) await stopping;
    log(worker.snapshot());
    if (worker.snapshot().state !== "READY") {
      failure = worker.snapshot().state !== "STOPPED";
      stop();
    }
    await finished;
    log(worker.snapshot());
    return failure || worker.snapshot().state === "HALTED" || worker.snapshot().persistenceError ? 1 : 0;
  } catch {
    stop();
    await finished;
    log({ error: "BTC_WORKER_FAILED", ...worker.snapshot() });
    return 1;
  } finally {
    clearInterval(monitor);
    signals.removeListener("SIGINT", stop);
    signals.removeListener("SIGTERM", stop);
  }
}

export async function main(): Promise<number> {
  if (process.argv[2] !== "start" || process.argv.length !== 3) {
    console.error("usage: npm run btc:worker -- start");
    return 2;
  }
  // Native --env-file-if-exists loads .env without overriding host environment.
  // No embedded database, equity config, broker endpoint, or web-host worker.
  const databaseUrl = env("DATABASE_URL");
  if (!databaseUrl) { console.error("DATABASE_URL_REQUIRED"); return 1; }
  if (env("VERCEL")) { console.error("BTC_WORKER_REQUIRES_ALWAYS_ON_HOST"); return 1; }
  let client: InstanceType<typeof pg.Client> | null = null;
  try {
    const credentials = loadAlpacaCryptoCredentials();
    client = new pg.Client({ connectionString: databaseUrl, application_name: "lightlight-btc-worker", connectionTimeoutMillis: 10_000, query_timeout: 10_000, statement_timeout: 10_000 });
    client.on("error", () => { console.error("BTC_DATABASE_CONNECTION_FAILED"); });
    await client.connect();
    const connected = client;
    const sql = (async () => { throw new Error("TAGGED_SQL_NOT_USED_BY_MARKET_STORE"); }) as unknown as Sql;
    sql.query = async <T>(text: string, params: unknown[] = []) => (await connected.query(text, params)).rows as T[];
    sql.transaction = async <T>(callback: (tx: Sql) => Promise<T>): Promise<T> => {
      await connected.query("BEGIN");
      try { const result = await callback(sql); await connected.query("COMMIT"); return result; }
      catch (error) { await connected.query("ROLLBACK").catch(() => undefined); throw error; }
    };
    const store = marketStoreOnly(new SqlAlpacaWorkerStore(async () => sql));
    return await runBtcWorker(createBtcMarketWorker(store, new AlpacaCryptoMarketSource(credentials)));
  } catch {
    console.error("BTC_STARTUP_FAILED: check database availability/migrations and Alpaca market-data credentials.");
    return 1;
  } finally { await client?.end().catch(() => undefined); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
