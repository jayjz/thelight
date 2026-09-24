import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DurableMarketWorker } from "./durable-market-worker.server.ts";
import { MemoryAlpacaWorkerStore, type WorkerCheckpoint } from "./alpaca-worker-store.server.ts";
import { BTC_USD_RUNTIME_IDENTITY, assertReadOnlyDurable } from "./runtime-identity.ts";
import { CryptoHistoricalError, type HistoricalInterval } from "./alpaca-crypto-historical.server.ts";
import { loadBtcObserverSnapshot } from "./btc-observe.ts";

const identity = BTC_USD_RUNTIME_IDENTITY; assertReadOnlyDurable(identity);
const t = Date.parse("2026-01-04T12:00:00Z");
const bar = (time = t) => ({ t: time, open: 100, high: 102, low: 99, close: 101, volume: 0 });
const sequence = (r: HistoricalInterval) => Array.from({ length: (r.endMs - r.startMs) / 60_000 + 1 }, (_, i) => bar(r.startMs + i * 60_000));
globalThis.fetch = async () => { throw new Error("REAL_NETWORK_FORBIDDEN"); };
globalThis.WebSocket = class { constructor() { throw new Error("REAL_WEBSOCKET_FORBIDDEN"); } } as unknown as typeof WebSocket;
function setup(store = new MemoryAlpacaWorkerStore(), initialNow = t + 60_000) {
  assertReadOnlyDurable(identity);
  let now = initialNow;
  const requests: HistoricalInterval[] = [];
  store.appendBrokerPosition = async () => { throw new Error("BROKER_POSITION_FORBIDDEN"); };
  store.appendTradeUpdate = async () => { throw new Error("TRADE_UPDATE_FORBIDDEN"); };
  const historical = { fetchCompletedBars: async (r: HistoricalInterval) => { requests.push({ ...r }); return sequence(r); } };
  const worker = new DurableMarketWorker({ identity, store, historical, now: () => now });
  return { store, worker, requests, historical, clock: (value: number) => { now = value; }, checkpoint: () => store.readCheckpoint(identity.workerKey) };
}
async function observer(checkpoint: WorkerCheckpoint, runId: string) {
  return loadBtcObserverSnapshot({ query: async <T extends Record<string, unknown>>() => ({ rows: [{
    now_ms: String(t + 60_000), owner_run_id: runId, fencing_token: "1", lease_live: true,
    lease_expires_at: new Date(t + 120_000), run_id: runId, state: "READY", halt_reason: null,
    checkpoint_json: JSON.stringify(checkpoint), updated_at: new Date(t + 60_000), latest_bar: String(checkpoint.latestRawBarTimestamp),
  } as unknown as T] }) });
}

describe("verified BTC recovery", () => {
  for (const missing of [1, 3]) it(`repairs exactly ${missing} missing minute(s) before accepting the next live bar`, async () => {
    const s = setup(); await s.store.insertClosedBar("BTC/USD", bar());
    try {
      await s.worker.start(); s.requests.length = 0;
      const next = t + (missing + 1) * 60_000; s.clock(next + 60_000);
      s.historical.fetchCompletedBars = async r => {
        s.requests.push({ ...r });
        assert.equal((await s.checkpoint())?.marketEvidence?.continuity, "GAP_DETECTED");
        assert.equal(await s.store.latestClosedBarTimestamp("BTC/USD"), t);
        return sequence(r);
      };
      await s.worker.processClosedBar(bar(next));
      assert.deepEqual(s.requests, [{ symbol: "BTC/USD", startMs: t + 60_000, endMs: next - 60_000 }]);
      const cp = (await s.checkpoint())!;
      assert.equal(cp.marketEvidence?.continuity, "VERIFIED"); assert.equal(cp.marketEvidence?.verifiedThroughMs, next);
      assert.equal(cp.latestRawBarTimestamp, next); assert.equal(cp.recoveryState, "HEALTHY");
      assert.equal(cp.marketEvidence?.recovery?.acceptedBarCount, missing);
      assert.equal(cp.marketEvidence?.recovery?.result, "VERIFIED");
      const observations = s.store.marketObservations();
      assert.equal(observations.find(o => o.bar.t === t + 60_000)?.origin, "REST_BACKFILL");
      assert.equal(observations.find(o => o.bar.t === next)?.origin, "LIVE_WS");
      assert.equal(s.store.posts.length, 0); assert.equal(s.store.updates.length, 0); assert.deepEqual(await s.store.listIntents(), []);
    } finally { await s.worker.stop(); }
  });
  it("incomplete provider response stays GAP_DETECTED and failure is observer-visible", async () => {
    const s = setup(); await s.store.insertClosedBar("BTC/USD", bar());
    try {
      await s.worker.start(); s.clock(t + 240_000);
      s.historical.fetchCompletedBars = async () => [bar(t + 60_000)];
      await s.worker.processClosedBar(bar(t + 180_000));
      const cp = (await s.checkpoint())!;
      assert.equal(cp.marketEvidence?.continuity, "GAP_DETECTED"); assert.equal(s.worker.snapshot().state, "HALTED");
      assert.equal(cp.marketEvidence?.recovery?.reason, "INCOMPLETE_RECOVERY");
      assert.equal(await s.store.latestClosedBarTimestamp("BTC/USD"), t);
      const seen = await observer(cp, s.worker.snapshot().runId!);
      assert.equal(seen.historicalContinuityVerified, false); assert.equal(seen.recovery?.reason, "INCOMPLETE_RECOVERY");
      assert.ok(seen.healthReasons.includes("CONTINUITY_GAP_DETECTED"));
    } finally { await s.worker.stop(); }
  });
  it("historical/durable conflict halts without overwriting immutable evidence", async () => {
    const s = setup(); await s.store.insertClosedBar("BTC/USD", { ...bar(), close: 100 });
    try {
      await s.worker.start(); const cp = (await s.checkpoint())!;
      assert.equal(s.worker.snapshot().haltReason, "HISTORICAL_RECOVERY_CONFLICT");
      assert.equal(cp.marketEvidence?.continuity, "GAP_DETECTED");
      assert.equal(cp.marketEvidence?.recovery?.conflictingBarCount, 1);
      assert.equal((await s.store.listClosedBars("BTC/USD"))[0]?.close, 100);
    } finally { await s.worker.stop(); }
  });
  it("restart uses durable bars past a stale checkpoint and fetches exactly the unverified suffix", async () => {
    const a = setup(); await a.store.insertClosedBar("BTC/USD", bar()); await a.worker.start(); await a.worker.stop();
    await a.store.insertClosedBar("BTC/USD", bar(t + 60_000)); // crash after insertion
    const b = setup(a.store, t + 240_000);
    try {
      await b.worker.start();
      assert.deepEqual(b.requests, [{ symbol: "BTC/USD", startMs: t + 60_000, endMs: t + 180_000 }]);
      const attempt = (await b.checkpoint())?.marketEvidence?.recovery;
      assert.equal(attempt?.identicalBarCount, 1); assert.equal(attempt?.acceptedBarCount, 2);
      assert.equal(b.worker.snapshot().latestRawBarTimestamp, t + 180_000);
    } finally { await b.worker.stop(); }
    const c = setup(a.store, t + 240_000);
    try { await c.worker.start(); assert.deepEqual(c.requests, []); assert.equal((await c.checkpoint())?.marketEvidence?.continuity, "VERIFIED"); }
    finally { await c.worker.stop(); }
  });
  it("detects a durable hole even inside previously verified checkpoint bounds", async () => {
    const s = setup(new MemoryAlpacaWorkerStore(), t + 240_000);
    await s.store.insertClosedBar("BTC/USD", bar()); await s.store.insertClosedBar("BTC/USD", bar(t + 180_000));
    await s.store.writeCheckpoint(identity.workerKey, { marketEvidence: { continuity: "VERIFIED", verifiedStartMs: t, verifiedThroughMs: t + 180_000 } } as WorkerCheckpoint);
    try { await s.worker.start(); assert.deepEqual(s.requests, [{ symbol: "BTC/USD", startMs: t + 60_000, endMs: t + 120_000 }]); }
    finally { await s.worker.stop(); }
  });
  it("cold start bounds history to 1440 closed minutes and never requests the incomplete minute", async () => {
    const s = setup();
    try {
      await s.worker.start();
      assert.deepEqual(s.requests, [{ symbol: "BTC/USD", startMs: t - 1439 * 60_000, endMs: t }]);
      assert.equal((await s.store.listClosedBars("BTC/USD")).length, 1440);
    } finally { await s.worker.stop(); }
  });
  it("stale token cannot write observations, complete an attempt, or advance checkpoint after GET", async () => {
    const s = setup(); await s.store.insertClosedBar("BTC/USD", bar());
    let replacementLease: Awaited<ReturnType<MemoryAlpacaWorkerStore["acquireOwnership"]>> = null;
    s.historical.fetchCompletedBars = async r => {
      const lease = s.worker.snapshot().lease!;
      await s.store.releaseOwnership(lease); await s.store.createRun("replacement", identity.workerKey, "STARTING");
      replacementLease = await s.store.acquireOwnership(identity.workerKey, "replacement", 30);
      return sequence(r);
    };
    await s.worker.start();
    assert.equal(s.worker.snapshot().haltReason, "DURABLE_RUNTIME_OWNERSHIP_LOST");
    const cp = (await s.checkpoint())!; assert.equal(cp.marketEvidence?.recovery?.state, "BACKFILLING");
    assert.equal(cp.marketEvidence?.continuity, "GAP_DETECTED");
    assert.equal(s.store.marketObservations().filter(o => o.origin === "REST_BACKFILL").length, 0);
    await s.worker.stop(); if (replacementLease) await s.store.releaseOwnership(replacementLease);
  });
  it("takeover after recovered insertion prevents healthy finalization; restart safely re-verifies identical bars", async () => {
    const s = setup(new MemoryAlpacaWorkerStore(), t + 120_000); await s.store.insertClosedBar("BTC/USD", bar());
    const original = s.store.writeMarketEvidenceOwned.bind(s.store);
    let stole = false;
    s.store.writeMarketEvidenceOwned = async (lease, write) => {
      const result = await original(lease, write);
      if (!stole && write.observations?.some(o => o.origin === "REST_BACKFILL")) {
        stole = true; await s.store.releaseOwnership(lease);
        await s.store.createRun("replacement", identity.workerKey, "STARTING");
        await s.store.acquireOwnership(identity.workerKey, "replacement", 30);
      }
      return result;
    };
    await s.worker.start(); assert.equal(s.worker.snapshot().state, "HALTED");
    assert.equal((await s.checkpoint())?.marketEvidence?.continuity, "GAP_DETECTED");
    await s.worker.stop(); await s.store.releaseOwnership(s.store.leaseEvidence(identity.workerKey)!);
    s.store.writeMarketEvidenceOwned = original;
    const b = setup(s.store);
    try { await b.worker.start(); assert.equal((await b.checkpoint())?.marketEvidence?.recovery?.identicalBarCount, 1); assert.equal((await b.checkpoint())?.marketEvidence?.backfilledBarCount, 1); assert.equal((await b.checkpoint())?.marketEvidence?.continuity, "VERIFIED"); }
    finally { await b.worker.stop(); }
  });
  it("restart re-verifies the trusted prefix after a conflicting live observation", async () => {
    const a = setup(); await a.store.insertClosedBar("BTC/USD", bar());
    await a.worker.start(); await a.worker.processClosedBar({ ...bar(), close: 100 }); await a.worker.stop();
    const b = setup(a.store);
    try { await b.worker.start(); assert.deepEqual(b.requests, [{ symbol: "BTC/USD", startMs: t, endMs: t }]); assert.equal((await b.checkpoint())?.marketEvidence?.continuity, "VERIFIED"); }
    finally { await b.worker.stop(); }
  });
  it("conflict and lost ownership atomically invalidate trust before the halt checkpoint", async () => {
    const a = setup(); await a.store.insertClosedBar("BTC/USD", bar()); await a.worker.start();
    const write = a.store.writeMarketEvidenceOwned.bind(a.store);
    a.store.writeMarketEvidenceOwned = async (lease, value) => {
      const result = await write(lease, value);
      if (result?.includes("CONFLICT")) {
        await a.store.releaseOwnership(lease); await a.store.createRun("replacement", identity.workerKey, "STARTING");
        await a.store.acquireOwnership(identity.workerKey, "replacement", 30);
      }
      return result;
    };
    await a.worker.processClosedBar({ ...bar(), close: 100 }); await a.worker.stop();
    assert.equal((await a.checkpoint())?.marketEvidence?.continuity, "GAP_DETECTED");
    await a.store.releaseOwnership(a.store.leaseEvidence(identity.workerKey)!); a.store.writeMarketEvidenceOwned = write;
    const b = setup(a.store);
    try { await b.worker.start(); assert.equal(b.requests.length, 1); assert.equal((await b.checkpoint())?.marketEvidence?.continuity, "VERIFIED"); }
    finally { await b.worker.stop(); }
  });
  it("cold recovery writes bounded batches and renews ownership between them", async () => {
    const s = setup(); const sizes: number[] = [];
    const write = s.store.writeMarketEvidenceOwned.bind(s.store);
    s.store.writeMarketEvidenceOwned = async (lease, value) => { if (value.observations) sizes.push(value.observations.length); return write(lease, value); };
    try { await s.worker.start(); assert.equal(sizes.reduce((sum, n) => sum + n, 0), 1440); assert.ok(sizes.every(n => n <= 32)); }
    finally { await s.worker.stop(); }
  });
  it("historical error remains terminal without a second worker retry loop", async () => {
    const s = setup(); let calls = 0;
    s.historical.fetchCompletedBars = async () => { calls++; throw new CryptoHistoricalError("AUTHENTICATION_FAILURE"); };
    await s.worker.start(); assert.equal(calls, 1); assert.equal((await s.checkpoint())?.marketEvidence?.recovery?.reason, "AUTHENTICATION_FAILURE"); await s.worker.stop();
  });
});
