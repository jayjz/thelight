import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import ts from "typescript";
import { createBtcMarketWorker, runBtcWorker } from "../../../scripts/btc-market-worker.ts";
import { AlpacaCryptoMarketSource, loadAlpacaCryptoCredentials } from "./alpaca-crypto.server.ts";
import { DurableMarketWorker } from "./durable-market-worker.server.ts";
import { MemoryAlpacaWorkerStore, type WorkerCheckpoint } from "./alpaca-worker-store.server.ts";
import { BTC_USD_RUNTIME_IDENTITY, assertReadOnlyDurable } from "./runtime-identity.ts";
import { BTC_MAX_COMPLETED_BAR_AGE_MS, loadBtcObserverSnapshot, renderBtcObserver } from "./btc-observe.ts";
import type { ObserverQuery } from "./alpaca-observe.ts";

const identity = BTC_USD_RUNTIME_IDENTITY;
assertReadOnlyDurable(identity);
const t = Date.parse("2026-01-04T00:00:00Z"); // Sunday: always open.
const bar = (timestamp = t) => ({ t: timestamp, open: 100, high: 102, low: 99, close: 101, volume: 2 });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "condition timed out"); await pause(10); }
}
const worker = (store: MemoryAlpacaWorkerStore, now?: () => number) => new DurableMarketWorker({ identity, store, now });

// Any accidental default network connection fails locally; no credentials are loaded.
globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN_IN_BTC_UNIT_TEST"); };
globalThis.WebSocket = class { constructor() { throw new Error("REAL_WEBSOCKET_FORBIDDEN_IN_BTC_UNIT_TEST"); } } as unknown as typeof WebSocket;

describe("durable BTC runtime", () => {
  it("requires durable storage and the unchanged read-only capability", async () => {
    const w = worker(new MemoryAlpacaWorkerStore(false));
    await w.start();
    assert.equal(w.snapshot().state, "HALTED");
    assert.equal(w.snapshot().haltReason, "DURABLE_STORAGE_REQUIRED");
    assert.deepEqual(identity.capability, { kind: "READ_ONLY_DURABLE", reason: "MARKET_EVIDENCE_ONLY" });
  });
  it("persists STARTING/READY, BTC lease, graceful STOPPED and release", async () => {
    const store = new MemoryAlpacaWorkerStore(); const w = worker(store);
    await w.start(); const id = w.snapshot().runId!;
    assert.equal(store.leaseEvidence(identity.workerKey)?.runId, id);
    assert.equal(store.runEvidence(id)?.state, "READY");
    await w.stop();
    assert.equal(store.runEvidence(id)?.state, "STOPPED");
    assert.ok(Date.parse(store.leaseEvidence(identity.workerKey)!.leaseExpiresAt) <= Date.now());
    assert.deepEqual(store.runTransitions.map((r) => r.state), ["STARTING", "READY", "STOPPED"]);
  });
  it("rejects a second BTC owner without changing the incumbent checkpoint", async () => {
    const store = new MemoryAlpacaWorkerStore(); const a = worker(store); const b = worker(store);
    await a.start(); const cp = await store.readCheckpoint(identity.workerKey);
    await b.start();
    assert.equal(b.snapshot().haltReason, "DURABLE_RUNTIME_OWNERSHIP_UNAVAILABLE");
    assert.deepEqual(await store.readCheckpoint(identity.workerKey), cp);
    await b.stop(); assert.equal(store.runEvidence(b.snapshot().runId!)?.state, "HALTED");
    await a.stop();
  });
  it("renews ownership and checkpoint heartbeat without new bars", async () => {
    const store = new MemoryAlpacaWorkerStore(); let now = Date.now(); const w = worker(store, () => now);
    await w.start(); const initial = store.leaseEvidence(identity.workerKey)!;
    now += 11_000;
    await until(() => store.leaseEvidence(identity.workerKey)!.leaseExpiresAt !== initial.leaseExpiresAt);
    assert.equal(store.leaseEvidence(identity.workerKey)!.fencingToken, initial.fencingToken);
    await w.stop();
  });
  it("restart has a new run, recovers inserted bars past a stale checkpoint, and keeps duplicates idempotent", async () => {
    const store = new MemoryAlpacaWorkerStore(); const a = worker(store);
    await a.start(); await a.processClosedBar(bar()); await a.stop();
    const priorRun = store.runEvidence(a.snapshot().runId!);
    await store.insertClosedBar("BTC/USD", bar(t + 60_000)); // crash before checkpoint
    const b = worker(store); await b.start();
    assert.notEqual(a.snapshot().runId, b.snapshot().runId);
    assert.equal(b.snapshot().recoveredClosedBarCount, 2);
    assert.equal(b.snapshot().latestRawBarTimestamp, t + 60_000);
    await b.processClosedBar(bar(t + 60_000));
    assert.equal((await store.listClosedBars("BTC/USD")).length, 2);
    assert.deepEqual(store.runEvidence(a.snapshot().runId!), priorRun);
    await b.stop();
  });
  it("restart detects gaps in bars committed before checkpoint advancement", async () => {
    const store = new MemoryAlpacaWorkerStore(); const a = worker(store);
    await a.start(); await a.processClosedBar(bar()); await a.stop();
    await store.insertClosedBar("BTC/USD", bar(t + 180_000));
    const b = worker(store); await b.start();
    assert.equal((await store.readCheckpoint(identity.workerKey))?.marketEvidence?.continuity, "GAP_DETECTED");
    await b.stop();
  });
  it("fenced takeover supersedes an abandoned run and rejects its checkpoint", async () => {
    const store = new MemoryAlpacaWorkerStore(); const a = worker(store); await a.start();
    const lease = store.leaseEvidence(identity.workerKey)!;
    await store.releaseOwnership(lease); // deterministic expiration seam; production uses database time
    const b = worker(store); await b.start();
    const cp = await store.readCheckpoint(identity.workerKey);
    assert.equal(store.runEvidence(a.snapshot().runId!)?.state, "SUPERSEDED");
    assert.equal(store.leaseEvidence(identity.workerKey)!.fencingToken, lease.fencingToken + 1);
    assert.equal(await store.writeCheckpointOwned(lease, { latestRawBarTimestamp: 123 } as WorkerCheckpoint), false);
    await a.stop();
    assert.deepEqual(await store.readCheckpoint(identity.workerKey), cp);
    assert.equal(store.runEvidence(a.snapshot().runId!)?.state, "SUPERSEDED");
    await b.stop();
  });
  it("conflicting completed bars halt durably and cannot overwrite original evidence", async () => {
    const store = new MemoryAlpacaWorkerStore(); const w = worker(store); await w.start();
    await w.processClosedBar(bar()); await w.processClosedBar({ ...bar(), close: 100 });
    assert.equal(w.snapshot().haltReason, "MARKET_BAR_CONFLICT");
    assert.equal(store.runEvidence(w.snapshot().runId!)?.state, "HALTED");
    assert.deepEqual(await store.listClosedBars("BTC/USD"), [bar()]);
    await w.stop();
  });
  it("gaps remain durable uncertainty while later evidence continues without invented bars", async () => {
    const store = new MemoryAlpacaWorkerStore(); const w = worker(store); await w.start();
    await w.processClosedBar(bar()); await w.processClosedBar(bar(t + 180_000));
    assert.equal(w.snapshot().state, "READY");
    assert.equal((await store.readCheckpoint(identity.workerKey))?.marketEvidence?.continuity, "GAP_DETECTED");
    assert.equal((await store.listClosedBars("BTC/USD")).length, 2);
    await w.stop();
  });
  it("storage failure halts visibly even when durable failure persistence is unavailable", async () => {
    const store = new MemoryAlpacaWorkerStore(); const w = worker(store); await w.start();
    store.recordMarketBar = async () => { throw new Error("database down"); };
    store.updateRun = async () => { throw new Error("database down"); };
    await w.processClosedBar(bar());
    assert.equal(w.snapshot().state, "HALTED"); assert.equal(w.snapshot().persistenceError, true);
    await w.stop();
  });
});

describe("BTC operator lifecycle", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) it(`${signal} stops once after READY and releases listeners`, async () => {
    const store = new MemoryAlpacaWorkerStore(); const w = worker(store); const signals = new EventEmitter();
    let resolved = false;
    const result = runBtcWorker(w, signals as NodeJS.Process, () => undefined).then((code) => { resolved = true; return code; });
    await until(() => w.snapshot().state === "READY"); await pause(30);
    assert.equal(resolved, false, "READY must not finish the operator");
    signals.emit(signal); signals.emit(signal);
    assert.equal(await result, 0); assert.equal(w.snapshot().state, "STOPPED");
    assert.equal(signals.listenerCount(signal), 0);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) it(`real child remains alive after READY and handles ${signal}`, async () => {
    const code = `
      import { DurableMarketWorker } from './src/lib/lightlight/durable-market-worker.server.ts';
      import { MemoryAlpacaWorkerStore } from './src/lib/lightlight/alpaca-worker-store.server.ts';
      import { BTC_USD_RUNTIME_IDENTITY } from './src/lib/lightlight/runtime-identity.ts';
      import { runBtcWorker } from './scripts/btc-market-worker.ts';
      const store = new MemoryAlpacaWorkerStore();
      const w = new DurableMarketWorker({ identity: BTC_USD_RUNTIME_IDENTITY, store });
      process.exitCode = await runBtcWorker(w);
      console.log(JSON.stringify(store.allRunEvidence()));
    `;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code]);
    let output = ""; child.stdout.on("data", (data) => { output += data; });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    try {
      await until(() => output.includes('"state":"READY"'));
      await pause(50); assert.equal(child.exitCode, null);
      child.kill(signal);
      assert.equal(await exited, 0); assert.match(output, /"state":"STOPPED"/);
    } finally { if (child.exitCode === null) child.kill("SIGKILL"); }
  });
  it("startup HALTED exits nonzero", async () => {
    assert.equal(await runBtcWorker(worker(new MemoryAlpacaWorkerStore(false)), new EventEmitter() as NodeJS.Process, () => undefined), 1);
  });
  it("runtime HALTED exits nonzero and preserves HALTED", async () => {
    const store = new MemoryAlpacaWorkerStore(); const w = worker(store);
    const result = runBtcWorker(w, new EventEmitter() as NodeJS.Process, () => undefined);
    await until(() => w.snapshot().state === "READY");
    await w.processClosedBar({ ...bar(), high: 1 });
    assert.equal(await result, 1); assert.equal(store.runEvidence(w.snapshot().runId!)?.state, "HALTED");
  });
  it("dedicated factory waits for BTC subscription acknowledgement and closes its source", async () => {
    let message: ((event: { data?: unknown }) => void) | undefined; let closed = false;
    const source = new AlpacaCryptoMarketSource({ apiKeyId: "unit", apiSecretKey: "unit" }, () => ({
      send: (payload) => {
        const action = JSON.parse(payload).action;
        queueMicrotask(() => message?.({ data: JSON.stringify(action === "auth" ? [{ T: "success", msg: "authenticated" }] : [{ T: "subscription", bars: ["BTC/USD"] }]) }));
      }, close: () => { closed = true; },
      addEventListener: (type, handler) => { if (type === "message") message = handler; },
    }));
    const store = new MemoryAlpacaWorkerStore(); const w = createBtcMarketWorker(store, source);
    const starting = w.start(); await until(() => Boolean(message));
    assert.equal(w.snapshot().state, "STARTING");
    message?.({ data: JSON.stringify([{ T: "success", msg: "connected" }]) });
    await starting;
    assert.equal(w.snapshot().runtimeCapability, "READ_ONLY_DURABLE");
    assert.equal(w.snapshot().brokerAuthority, "NONE");
    assert.equal((await store.readCheckpoint(identity.workerKey))?.marketEvidence?.stream?.subscriptionAcknowledged, true);
    await w.stop(); assert.equal(closed, true);
    assert.equal(store.posts.length, 0); assert.equal((await store.listIntents()).length, 0);
  });
  it("SIGTERM during subscription startup closes the socket and persists STOPPED", async () => {
    let closed = false;
    const source = new AlpacaCryptoMarketSource({ apiKeyId: "unit", apiSecretKey: "unit" }, () => ({
      send: () => undefined, close: () => { closed = true; }, addEventListener: () => undefined,
    }));
    const store = new MemoryAlpacaWorkerStore(); const w = createBtcMarketWorker(store, source);
    const signals = new EventEmitter();
    const result = runBtcWorker(w, signals as NodeJS.Process, () => undefined);
    await until(() => source.snapshot().state === "CONNECTING");
    signals.emit("SIGTERM"); assert.equal(await result, 0); assert.equal(closed, true);
    assert.equal(store.runEvidence(w.snapshot().runId!)?.state, "STOPPED");
  });
  it("missing DATABASE_URL fails before connecting and credentials are independently required", async () => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/btc-market-worker.ts", "start"], { env: { ...process.env, DATABASE_URL: "", ALPACA_API_KEY_ID: "", ALPACA_API_SECRET_KEY: "" } });
    let output = ""; child.stderr.on("data", (data) => { output += data; });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(code, 1); assert.match(output, /DATABASE_URL_REQUIRED/);
    assert.throws(() => loadAlpacaCryptoCredentials({}), /CREDENTIALS_REQUIRED/);
  });
});

function observerRow(age = 120_000) {
  return { now_ms: String(t + age), owner_run_id: "owner", fencing_token: "9", lease_expires_at: new Date(t + age + 30_000), lease_live: true,
    run_id: "owner", state: "READY", halt_reason: null, updated_at: new Date(t + age), latest_bar: String(t),
    checkpoint_json: JSON.stringify({ latestRawBarTimestamp: t, marketEvidence: { runId: "owner", continuity: "UNVERIFIED", recoveredClosedBarCount: 2, stream: { state: "SUBSCRIBED", subscriptionAcknowledged: true, generation: 2, reconnectAttempt: 0 } } }) };
}
async function observe(row = observerRow()) {
  const query: ObserverQuery = { query: async <T extends Record<string, unknown>>(sql: string, values?: unknown[]) => {
    assert.match(sql.trim(), /^select/i); assert.doesNotMatch(sql, /\b(insert|update|delete|pg_advisory|for update)\b/i);
    assert.deepEqual(values, [identity.workerKey, "BTC/USD"]);
    assert.match(sql, /run_id = l.owner_run_id/);
    return { rows: [row as unknown as T] };
  } };
  return loadBtcObserverSnapshot(query);
}
describe("durable BTC observer", () => {
  it("read-only output exposes authority, lease, timestamps and always-open freshness", async () => {
    const s = await observe();
    assert.equal(s.health, "READY"); assert.equal(s.lastBarAgeMs, 120_000);
    assert.equal(s.leaseLive, true); assert.equal(s.fencingToken, "9");
    assert.match(renderBtcObserver(s), /READ_ONLY_DURABLE/); assert.match(renderBtcObserver(s), /BROKER AUTHORITY: NONE/);
  });
  it("operational threshold is explicit and inclusive; a late minute only degrades", async () => {
    assert.equal(BTC_MAX_COMPLETED_BAR_AGE_MS, 180_000);
    assert.equal((await observe(observerRow(180_000))).health, "READY");
    assert.equal((await observe(observerRow(180_001))).health, "DEGRADED");
  });
  it("expired lease, stale checkpoint and reconnect differ from terminal states", async () => {
    assert.ok((await observe({ ...observerRow(), lease_live: false })).healthReasons.includes("LEASE_NOT_LIVE"));
    assert.ok((await observe({ ...observerRow(), updated_at: new Date(t - 60_000) })).healthReasons.includes("CHECKPOINT_STALE_OR_WRONG_RUN"));
    const row = observerRow(); const cp = JSON.parse(row.checkpoint_json); cp.marketEvidence.stream.state = "RECONNECTING"; cp.marketEvidence.stream.subscriptionAcknowledged = false;
    const reconnecting = await observe({ ...row, checkpoint_json: JSON.stringify(cp) });
    assert.equal(reconnecting.health, "DEGRADED"); assert.equal(reconnecting.cryptoWebSocketState, "RECONNECTING");
    for (const state of ["HALTED", "STOPPED"]) assert.equal((await observe({ ...row, state })).health, state);
  });
  it("stale evidence from another run cannot claim subscribed health", async () => {
    const s = await observe({ ...observerRow(), run_id: "new-owner" });
    assert.equal(s.subscriptionAcknowledged, false); assert.equal(s.health, "DEGRADED");
  });
  it("BTC operator import graph contains no broker implementation or trading endpoint", async () => {
    const seen = new Set<string>();
    async function inspect(url: URL) {
      if (seen.has(url.href)) return; seen.add(url.href);
      assert.doesNotMatch(url.pathname, /\/(alpaca\.server|alpaca-worker\.server|execution\.server)\.ts$/);
      const raw = await readFile(url, "utf8");
      const code = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
      assert.doesNotMatch(code, /paper-api\.alpaca|api\.alpaca\.markets|fetch\(/);
      for (const match of code.matchAll(/(?:from\s*|import\s*\()?["'](\.[^"']+\.(?:ts|mjs))["']/g)) await inspect(new URL(match[1]!, url));
    }
    await inspect(new URL("../../../scripts/btc-market-worker.ts", import.meta.url));
    await inspect(new URL("../../../scripts/btc-market-observe.ts", import.meta.url));
    const observer = await readFile(new URL("../../../scripts/btc-market-observe.ts", import.meta.url), "utf8");
    assert.match(observer, /BEGIN READ ONLY/); assert.match(observer, /default_transaction_read_only=on/);
    assert.doesNotMatch(observer, /ALPACA_API|WebSocket|acquireOwnership|renewOwnership/);
    assert.ok(seen.has(new URL("./alpaca-crypto.server.ts", import.meta.url).href));
  });
});
