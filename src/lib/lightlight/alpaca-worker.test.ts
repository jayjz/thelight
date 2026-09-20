import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { BrokerAccountSnapshot, BrokerOrderState, BrokerPositionSnapshot, OpenBrokerOrder } from "./alpaca.server.ts";
import { ALPACA_PAPER_BASE_URL, type AlpacaConfig } from "./alpaca.server.ts";
import { AlpacaPaperWorker, MemoryAlpacaWorkerStore, deterministicClientOrderId, deterministicDecisionId, isRegularUsEquitySession } from "./alpaca-worker.server.ts";
import type { MarketSource } from "./market.ts";
import type { ExecutionIntent } from "./types.ts";

const config: AlpacaConfig = {
  apiKeyId: "key", apiSecretKey: "secret", paperBaseUrl: ALPACA_PAPER_BASE_URL,
  dataBaseUrl: "https://data.alpaca.markets", dataFeed: "iex", symbol: "SPY",
};

class FakeBroker {
  accountCalls = 0;
  positionCalls = 0;
  openOrderCalls = 0;
  posts = 0;
  positionQuantity = 0;
  equity = 100_000;
  throwAccount = false;
  throwPosition = false;
  unknownOnSubmit = false;
  openOnDispatch = false;
  found = new Map<string, BrokerOrderState>();
  lastSubmittedPosition: BrokerPositionSnapshot | null = null;

  async account(): Promise<BrokerAccountSnapshot> {
    this.accountCalls += 1;
    if (this.throwAccount) throw new Error("ACCOUNT_UNAVAILABLE");
    return { equity: this.equity, reconciledAt: "2026-09-19T14:00:00.000Z", provenance: "ALPACA_PAPER_ACCOUNT" };
  }
  async position(): Promise<BrokerPositionSnapshot> {
    this.positionCalls += 1;
    if (this.throwPosition) throw new Error("POSITION_UNAVAILABLE");
    return { symbol: "SPY", quantity: this.positionQuantity, reconciledAt: "2026-09-19T14:00:00.000Z", provenance: "ALPACA_RECONCILED" };
  }
  async openOrders(): Promise<OpenBrokerOrder[]> {
    this.openOrderCalls += 1;
    return this.openOnDispatch && this.openOrderCalls > 1
      ? [{ clientOrderId: "other-open-order", brokerOrderId: "other", status: "ACCEPTED" }]
      : [];
  }
  async reconcile(intent: ExecutionIntent): Promise<BrokerOrderState> {
    const clientOrderId = intent.clientOrderId ?? intent.intentId;
    return this.found.get(clientOrderId) ?? {
      decisionId: intent.decisionId, intentId: intent.intentId, clientOrderId,
      brokerOrderId: null, status: intent.status === "UNKNOWN" ? "UNKNOWN" : "PENDING",
      updatedAt: null, rawStatus: null, lookup: "ABSENT",
    };
  }
  async submit(intent: ExecutionIntent, position: BrokerPositionSnapshot): Promise<BrokerOrderState> {
    this.posts += 1;
    this.lastSubmittedPosition = position;
    const clientOrderId = intent.clientOrderId ?? intent.intentId;
    if (this.unknownOnSubmit) {
      return { decisionId: intent.decisionId, intentId: intent.intentId, clientOrderId, brokerOrderId: null, status: "UNKNOWN", updatedAt: null, rawStatus: null, lookup: "UNRESOLVED" };
    }
    const state = { decisionId: intent.decisionId, intentId: intent.intentId, clientOrderId, brokerOrderId: "broker-1", status: "ACCEPTED" as const, updatedAt: "2026-09-19T14:00:00.000Z", rawStatus: "accepted", lookup: "FOUND" as const };
    this.found.set(clientOrderId, state);
    return state;
  }
}

class FakeTradeUpdates {
  onUpdate: ((update: Record<string, unknown>) => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onReady: (() => void) | null = null;
  connects = 0;
  readyOnConnect = true;
  failSynchronously = false;
  readonly connections: Array<{
    onUpdate: (update: Record<string, unknown>) => void;
    onError: (error: Error) => void;
    onReady: () => void;
    active: boolean;
  }> = [];

  connect(
    onUpdate: (update: Record<string, unknown>) => void,
    onError: (error: Error) => void,
    onReady: () => void,
  ): () => void {
    this.connects += 1;
    const connection = { onUpdate, onError, onReady, active: true };
    this.connections.push(connection);
    this.onUpdate = onUpdate; this.onError = onError; this.onReady = onReady;
    if (this.readyOnConnect) onReady();
    if (this.failSynchronously) onError(new Error("TRADE_SOCKET_SYNCHRONOUS_FAILURE"));
    return () => {
      connection.active = false;
      if (this.onUpdate === onUpdate) {
        this.onUpdate = null;
        this.onError = null;
        this.onReady = null;
      }
    };
  }

  failLatest(): void { this.connections.at(-1)?.onError(new Error("TRADE_SOCKET_FAILURE")); }
}

function rawBars(decisionBuckets = 28): Array<{ t: number; open: number; high: number; low: number; close: number; volume: number }> {
  const start = Date.parse("2026-09-21T13:30:00.000Z"); // Monday 09:30 New York
  const bars = [];
  for (let minute = 0; minute <= decisionBuckets * 15; minute += 1) {
    const bucket = Math.floor(minute / 15);
    // Alternating positive returns retain non-zero realized volatility while
    // preserving a strong deterministic up-trend after warmup.
    const close = 100 + bucket * 1.5 + (bucket % 2) * 0.2;
    bars.push({ t: start + minute * 60_000, open: close - 0.05, high: close + 0.1, low: close - 0.1, close, volume: 100 });
  }
  return bars;
}

function worker(store: MemoryAlpacaWorkerStore, broker: FakeBroker, updates?: FakeTradeUpdates, inSession = true) {
  return new AlpacaPaperWorker({ config, store, broker, tradeUpdates: updates, isRegularSession: () => inSession });
}

class ManualMarketSource implements MarketSource {
  readonly id = "manual-market-source";
  calls = 0;
  private rejectActive: ((error: Error) => void) | null = null;
  async *bars(): AsyncIterable<{ t: number; open: number; high: number; low: number; close: number; volume: number }> {
    this.calls += 1;
    await new Promise<void>((_resolve, reject) => { this.rejectActive = reject; });
    // The promise above is rejected by the test. Keep this a valid producer if
    // a future fixture resolves it instead.
    yield { t: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 };
  }
  disconnect(): void { this.rejectActive?.(new Error("socket closed")); }
}

const flush = async () => new Promise<void>((resolve) => setImmediate(resolve));

async function runToDispatch(target: AlpacaPaperWorker, broker: FakeBroker) {
  await target.start();
  for (const bar of rawBars()) await target.processRawBar(bar);
  assert.ok(broker.posts > 0, "fixture must produce at least one Arm C paper dispatch after warmup");
}

describe("Alpaca PAPER worker restart and authority invariants", () => {
  it("deduplicates raw bars and completed decision bars", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const target = worker(store, broker);
    await target.start();
    const bars = rawBars();
    for (const bar of bars) await target.processRawBar(bar);
    const decisions = store.decisionCount();
    for (const bar of bars) await target.processRawBar(bar);
    assert.equal(store.decisionCount(), decisions);
  });

  it("does not reproduce a persisted decision or accepted order after restart", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const first = worker(store, broker);
    await runToDispatch(first, broker);
    const decisions = store.decisionCount(); const posts = broker.posts;
    await first.stop();
    const recreated = worker(store, broker);
    await recreated.start();
    for (const bar of rawBars()) await recreated.processRawBar(bar);
    assert.equal(store.decisionCount(), decisions);
    assert.equal(broker.posts, posts);
    assert.ok(store.checkpointReads >= 2, "each process must reload checkpoint before authority");
  });

  it("persists UNKNOWN, retains it after absent lookup, and never posts it twice after restart", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); broker.unknownOnSubmit = true;
    const first = worker(store, broker); await runToDispatch(first, broker);
    const posts = broker.posts;
    const unknown = (await store.listIntents()).find(({ intent }) => intent.status === "UNKNOWN");
    assert.ok(unknown);
    await first.stop();
    const recreated = worker(store, broker); await recreated.start();
    const persisted = (await store.listIntents()).find(({ intent }) => intent.intentId === unknown!.intent.intentId);
    assert.equal(persisted?.intent.status, "UNKNOWN");
    assert.equal(broker.posts, posts, "absent lookup is not permission for a second POST");
  });

  it("adopts a broker order found after restart instead of posting", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); broker.unknownOnSubmit = true;
    const first = worker(store, broker); await runToDispatch(first, broker);
    const unknown = (await store.listIntents()).find(({ intent }) => intent.status === "UNKNOWN")!.intent;
    const clientOrderId = unknown.clientOrderId!;
    broker.found.set(clientOrderId, { decisionId: unknown.decisionId, intentId: unknown.intentId, clientOrderId, brokerOrderId: "adopted", status: "ACCEPTED", updatedAt: "2026-09-19T14:00:00.000Z", rawStatus: "accepted", lookup: "FOUND" });
    const posts = broker.posts;
    await first.stop(); const recreated = worker(store, broker); await recreated.start();
    assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === unknown.intentId)?.intent.status, "ACCEPTED");
    assert.equal(broker.posts, posts);
  });

  it("halts SUBMISSION_ATTEMPTED plus absent lookup without any automatic repost", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const first = worker(store, broker);
    await runToDispatch(first, broker);
    const submitted = (await store.listIntents()).find(({ intent }) => intent.status === "ACCEPTED")!.intent;
    await store.putIntent({ ...submitted, status: "SUBMISSION_ATTEMPTED" });
    broker.found.delete(submitted.clientOrderId!);
    const posts = broker.posts; const decisions = store.decisionCount();
    await first.stop();

    const recreated = worker(store, broker); await recreated.start();
    assert.equal(recreated.snapshot().workerState, "HALTED");
    assert.match(recreated.snapshot().haltReason ?? "", /SUBMISSION_ATTEMPTED_RECOVERY_REQUIRED/);
    assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === submitted.intentId)?.intent.status, "SUBMISSION_ATTEMPTED");
    assert.equal(broker.posts, posts, "absent lookup cannot authorize a second POST");
    for (const bar of rawBars()) await recreated.processRawBar(bar);
    assert.equal(broker.posts, posts, "HALTED blocks later dispatch");
    assert.equal(store.decisionCount(), decisions, "HALTED blocks later decisions");
  });

  it("adopts a found SUBMISSION_ATTEMPTED broker order without reposting", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const first = worker(store, broker);
    await runToDispatch(first, broker);
    const submitted = (await store.listIntents()).find(({ intent }) => intent.status === "ACCEPTED")!.intent;
    await store.putIntent({ ...submitted, status: "SUBMISSION_ATTEMPTED" });
    const clientOrderId = submitted.clientOrderId!;
    broker.found.set(clientOrderId, { decisionId: submitted.decisionId, intentId: submitted.intentId, clientOrderId, brokerOrderId: "adopted-attempt", status: "ACCEPTED", updatedAt: "2026-09-19T14:00:00.000Z", rawStatus: "accepted", lookup: "FOUND" });
    const posts = broker.posts;
    await first.stop(); const recreated = worker(store, broker); await recreated.start();
    assert.equal(recreated.snapshot().workerState, "READY");
    assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === submitted.intentId)?.intent.status, "ACCEPTED");
    assert.equal(broker.posts, posts);
  });

  it("uses broker position, blocks failed position reconciliation, and conservatively blocks open-order conflicts", async () => {
    const positionStore = new MemoryAlpacaWorkerStore(); const positionedBroker = new FakeBroker(); positionedBroker.positionQuantity = -1;
    await runToDispatch(worker(positionStore, positionedBroker), positionedBroker);
    assert.equal(positionedBroker.lastSubmittedPosition?.quantity, -1);

    const unavailableStore = new MemoryAlpacaWorkerStore(); const unavailableBroker = new FakeBroker();
    const unavailable = worker(unavailableStore, unavailableBroker); await unavailable.start(); unavailableBroker.throwPosition = true;
    for (const bar of rawBars()) await unavailable.processRawBar(bar);
    assert.equal(unavailable.snapshot().workerState, "HALTED"); assert.equal(unavailableBroker.posts, 0);

    const conflictStore = new MemoryAlpacaWorkerStore(); const conflictBroker = new FakeBroker(); conflictBroker.openOnDispatch = true;
    const conflictWorker = worker(conflictStore, conflictBroker); await conflictWorker.start();
    for (const bar of rawBars()) await conflictWorker.processRawBar(bar);
    assert.equal(conflictBroker.posts, 0);
    assert.ok((await conflictStore.listIntents()).some((row) => row.dispatchBlockReason === "OPEN_ORDER_CONFLICT"));
  });

  it("persists trade updates, reconciles after stream loss, and never dispatches outside the exchange session", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const updates = new FakeTradeUpdates();
    const target = new AlpacaPaperWorker({ config, store, broker, tradeUpdates: updates, isRegularSession: () => true, sleep: async () => undefined });
    await runToDispatch(target, broker);
    const accepted = (await store.listIntents()).find(({ intent }) => intent.status === "ACCEPTED")!.intent;
    await target.processTradeUpdate({ stream: "trade_updates", data: { event: "fill", order: { id: "broker-1", status: "filled", client_order_id: accepted.clientOrderId } } });
    assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === accepted.intentId)?.intent.status, "FILLED");
    const accountCalls = broker.accountCalls;
    await target.handleTradeStreamError(new Error("socket lost"));
    await flush();
    assert.ok(broker.accountCalls > accountCalls); assert.ok(updates.connects >= 2);

    const outStore = new MemoryAlpacaWorkerStore(); const outBroker = new FakeBroker(); const outside = worker(outStore, outBroker, undefined, false);
    await outside.start(); for (const bar of rawBars()) await outside.processRawBar(bar);
    assert.equal(outBroker.posts, 0);
    assert.ok((await outStore.listIntents()).some((row) => row.dispatchBlockReason === "OUTSIDE_REGULAR_SESSION"));
  });

  it("bounds trade-stream recovery, reconciles before replacement, and preserves decision/submission idempotency", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const updates = new FakeTradeUpdates();
    const backoffs: Array<{ delay: number; resolve: () => void }> = [];
    const target = new AlpacaPaperWorker({
      config, store, broker, tradeUpdates: updates, isRegularSession: () => true,
      reconnectDelayMs: (attempt) => attempt * 10,
      sleep: (delay) => new Promise<void>((resolve) => { backoffs.push({ delay, resolve }); }),
    });
    await runToDispatch(target, broker);
    const decisions = store.decisionCount(); const posts = broker.posts;
    const reconciliations = broker.accountCalls;

    updates.failLatest();
    updates.failLatest();
    await flush(); await flush();
    assert.ok(broker.accountCalls > reconciliations, "trade loss reconciles before scheduling replacement");
    assert.equal(updates.connects, 1, "no replacement is created before backoff completes");
    assert.deepEqual(backoffs.map(({ delay }) => delay), [10], "only one reconnect is pending");

    backoffs[0]!.resolve();
    await flush(); await flush();
    assert.equal(updates.connects, 2);
    updates.failLatest();
    await flush(); await flush();
    assert.deepEqual(backoffs.map(({ delay }) => delay), [10, 20], "trade backoff is bounded and increments per attempt");
    backoffs[1]!.resolve();
    await flush(); await flush();
    assert.equal(updates.connects, 3);
    for (const bar of rawBars()) await target.processRawBar(bar);
    assert.equal(store.decisionCount(), decisions, "reconnects cannot duplicate deterministic decisions");
    assert.equal(broker.posts, posts, "reconnects cannot duplicate broker submissions");
    await target.stop();
  });

  it("breaks repeated synchronous trade failures across backoff turns instead of recursing", async () => {
    const updates = new FakeTradeUpdates(); updates.failSynchronously = true;
    const backoffs: Array<() => void> = [];
    const target = new AlpacaPaperWorker({
      config, store: new MemoryAlpacaWorkerStore(), broker: new FakeBroker(), tradeUpdates: updates,
      sleep: () => new Promise<void>((resolve) => { backoffs.push(resolve); }),
    });
    await target.start();
    await flush(); await flush();
    assert.equal(updates.connects, 1);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal(backoffs.length, attempt + 1, "each failure yields exactly one scheduled delay");
      backoffs[attempt]!();
      await flush(); await flush();
      assert.equal(updates.connects, attempt + 2, "each delay, rather than the call stack, creates one replacement");
    }
    await target.stop();
  });

  it("invalidates pending trade reconnects on stop or halt and never reconnects after failed reconciliation", async () => {
    const stoppedUpdates = new FakeTradeUpdates(); const stoppedBackoffs: Array<() => void> = [];
    const stopped = new AlpacaPaperWorker({
      config, store: new MemoryAlpacaWorkerStore(), broker: new FakeBroker(), tradeUpdates: stoppedUpdates,
      sleep: () => new Promise<void>((resolve) => { stoppedBackoffs.push(resolve); }),
    });
    await stopped.start(); stoppedUpdates.failLatest(); await flush(); await flush();
    await stopped.stop(); stoppedBackoffs[0]!(); await flush(); await flush();
    assert.equal(stoppedUpdates.connects, 1, "stop during trade backoff cannot create a replacement socket");

    const haltedBroker = new FakeBroker(); const haltedUpdates = new FakeTradeUpdates(); const haltedBackoffs: Array<() => void> = [];
    const halted = new AlpacaPaperWorker({
      config, store: new MemoryAlpacaWorkerStore(), broker: haltedBroker, tradeUpdates: haltedUpdates,
      sleep: () => new Promise<void>((resolve) => { haltedBackoffs.push(resolve); }),
    });
    await halted.start(); haltedUpdates.failLatest(); await flush(); await flush();
    haltedBroker.throwAccount = true; await halted.reconcile();
    assert.equal(halted.snapshot().workerState, "HALTED");
    haltedBackoffs[0]!(); await flush(); await flush();
    assert.equal(haltedUpdates.connects, 1, "halt during trade backoff cannot create a replacement socket");

    const failingBroker = new FakeBroker(); const failingUpdates = new FakeTradeUpdates(); const failedBackoffs: Array<() => void> = [];
    const failing = new AlpacaPaperWorker({
      config, store: new MemoryAlpacaWorkerStore(), broker: failingBroker, tradeUpdates: failingUpdates,
      sleep: () => new Promise<void>((resolve) => { failedBackoffs.push(resolve); }),
    });
    await failing.start(); failingBroker.throwAccount = true; failingUpdates.failLatest(); await flush(); await flush();
    assert.equal(failing.snapshot().workerState, "HALTED");
    assert.equal(failingUpdates.connects, 1, "reconciliation failure must not reconnect blindly");
    assert.deepEqual(failedBackoffs, []);
  });

  it("keeps decision and client-order identities stable", () => {
    const timestamp = Date.parse("2026-09-21T13:30:00.000Z"); const id = deterministicDecisionId(timestamp);
    assert.equal(id, deterministicDecisionId(timestamp));
    assert.equal(deterministicClientOrderId(id), deterministicClientOrderId(id));
  });

  it("uses the exact New York completed-bucket boundary", () => {
    const at = (value: string) => Date.parse(value);
    assert.equal(isRegularUsEquitySession(at("2026-09-21T13:29:00.000Z")), false, "09:29 ET");
    assert.equal(isRegularUsEquitySession(at("2026-09-21T13:30:00.000Z")), true, "09:30 ET");
    assert.equal(isRegularUsEquitySession(at("2026-09-21T19:45:00.000Z")), true, "15:45 ET");
    assert.equal(isRegularUsEquitySession(at("2026-09-21T20:00:00.000Z")), false, "16:00 ET");
    assert.equal(isRegularUsEquitySession(at("2026-09-21T20:15:00.000Z")), false, "16:15 ET");
    assert.equal(isRegularUsEquitySession(at("2026-09-20T13:30:00.000Z")), false, "weekend");
  });

  it("atomically persists decision plus intent, retries safely, and remains idempotent", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const target = worker(store, broker);
    await target.start();
    store.failNextIntentPersistence = true;
    for (const bar of rawBars(25)) await target.processRawBar(bar);
    assert.equal(store.decisionCount(), 0, "failed initial intent write leaves no decision-only state");
    assert.equal(store.intentCount(), 0);

    const retry = worker(store, broker); await retry.start();
    for (const bar of rawBars(25)) await retry.processRawBar(bar);
    assert.ok(store.decisionCount() > 0); assert.equal(store.decisionCount(), store.intentCount());
    const committed = store.decisionCount(); const intents = store.intentCount();
    for (const bar of rawBars(25)) await retry.processRawBar(bar);
    assert.equal(store.decisionCount(), committed); assert.equal(store.intentCount(), intents);
  });

  it("persists PAPER equity high-water across restart, applies drawdown risk, and halts on unavailable equity", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const first = worker(store, broker);
    await first.start();
    assert.equal(first.snapshot().paperEquityHighWater, 100_000);
    broker.equity = 80_000;
    for (const bar of rawBars()) await first.processRawBar(bar);
    assert.equal(first.snapshot().paperEquityDrawdown, 0.2);
    assert.ok(store.decisionEvidence().some((evidence) => evidence.risk.equityDrawdown === 0.2 && evidence.risk.reasons.some((reason) => reason.includes("paper equity drawdown"))));
    await first.stop();
    const restarted = worker(store, broker); await restarted.start();
    assert.equal(restarted.snapshot().paperEquityHighWater, 100_000, "restart may not reset the durable peak");
    assert.equal(restarted.snapshot().paperEquityDrawdown, 0.2);

    const unavailable = worker(new MemoryAlpacaWorkerStore(), Object.assign(new FakeBroker(), { throwAccount: true }));
    await unavailable.start();
    assert.equal(unavailable.snapshot().workerState, "HALTED");

    const legacyStore = new MemoryAlpacaWorkerStore();
    await legacyStore.writeCheckpoint("alpaca-paper:SPY:15Min:alpaca-paper-worker-v1", {
      latestRawBarTimestamp: null, latestClosedDecisionBarTimestamp: null, latestDecisionId: null,
      lastReconciliationTimestamp: "2026-09-19T14:00:00.000Z", streamState: "DISCONNECTED", haltReason: null,
    } as never);
    const legacy = worker(legacyStore, new FakeBroker()); await legacy.start();
    assert.equal(legacy.snapshot().workerState, "HALTED", "legacy checkpoint cannot silently reset paper-equity high-water");
  });

  it("invalidates feature continuity after a missing bucket and resumes only after fresh warmup", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const target = worker(store, broker);
    await target.start();
    const bars = rawBars(60);
    const start = bars[0]!.t;
    const missingBucketStart = start + 2 * 15 * 60_000;
    for (const bar of bars.filter((bar) => bar.t < missingBucketStart || bar.t >= missingBucketStart + 15 * 60_000)) await target.processRawBar(bar);
    assert.ok(target.snapshot().missingDecisionBuckets > 0);
    assert.equal(target.snapshot().featureContinuity, "HEALTHY", "enough post-gap continuous bars rebuild warmup");
    const firstAfterGap = store.decisionEvidence().find((evidence) => evidence.timestamp === missingBucketStart + 15 * 60_000);
    assert.equal(firstAfterGap?.features.logReturn, 0, "the first post-gap return never bridges to pre-gap close");
    assert.equal(firstAfterGap?.barIndex, 0, "post-gap feature indexing restarts rather than inheriting pre-gap history");

    const rebuildingStore = new MemoryAlpacaWorkerStore(); const rebuildingBroker = new FakeBroker(); const rebuilding = worker(rebuildingStore, rebuildingBroker);
    await rebuilding.start();
    const shortBars = rawBars(20).filter((bar) => bar.t < missingBucketStart || bar.t >= missingBucketStart + 15 * 60_000);
    for (const bar of shortBars) await rebuilding.processRawBar(bar);
    assert.equal(rebuilding.snapshot().featureContinuity, "REBUILDING"); assert.equal(rebuildingBroker.posts, 0, "dispatch remains blocked while warmup rebuilds");
    await rebuilding.stop();
    const resumed = worker(rebuildingStore, rebuildingBroker); await resumed.start();
    for (const bar of bars.filter((bar) => bar.t > shortBars.at(-1)!.t && (bar.t < missingBucketStart || bar.t >= missingBucketStart + 15 * 60_000))) await resumed.processRawBar(bar);
    assert.equal(resumed.snapshot().featureContinuity, "HEALTHY"); assert.ok(rebuildingBroker.posts > 0, "only post-gap warmup can restore dispatch");
  });

  it("reconciles then reconnects one market consumer, cancels backoff on stop, and halts on reconciliation failure", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const source = new ManualMarketSource();
    const backoffs: Array<() => void> = [];
    const target = new AlpacaPaperWorker({ config, store, broker, source, reconnectDelayMs: () => 1, sleep: () => new Promise<void>((resolve) => { backoffs.push(resolve); }) });
    await target.start(); await flush(); assert.equal(source.calls, 1);
    const beforeReconcile = broker.accountCalls; source.disconnect(); await flush(); await flush();
    assert.ok(broker.accountCalls > beforeReconcile); assert.equal(target.snapshot().marketStreamState, "RECONCILING");
    backoffs[0]!(); await flush(); await flush();
    assert.equal(source.calls, 2, "one completed reconnect creates exactly one replacement consumer");
    assert.equal(target.snapshot().marketStreamState, "CONNECTED");
    for (const bar of rawBars()) await target.processRawBar(bar);
    const postReconnectDecisions = store.decisionCount();
    for (const bar of rawBars()) await target.processRawBar(bar);
    assert.equal(store.decisionCount(), postReconnectDecisions, "replayed bars after reconnect cannot duplicate decisions");
    await target.stop();

    const stoppedSource = new ManualMarketSource(); const stoppedBackoffs: Array<() => void> = [];
    const stopped = new AlpacaPaperWorker({ config, store: new MemoryAlpacaWorkerStore(), broker: new FakeBroker(), source: stoppedSource, sleep: () => new Promise<void>((resolve) => { stoppedBackoffs.push(resolve); }) });
    await stopped.start(); await flush(); stoppedSource.disconnect(); await flush(); await flush(); await stopped.stop(); stoppedBackoffs[0]!(); await flush();
    assert.equal(stoppedSource.calls, 1, "stop during backoff cannot create another consumer");

    const failingSource = new ManualMarketSource(); const failingBroker = new FakeBroker();
    const failing = new AlpacaPaperWorker({ config, store: new MemoryAlpacaWorkerStore(), broker: failingBroker, source: failingSource, sleep: async () => undefined });
    await failing.start(); await flush(); failingBroker.throwAccount = true; failingSource.disconnect(); await flush(); await flush();
    assert.equal(failing.snapshot().workerState, "HALTED"); assert.equal(failingSource.calls, 1, "failed reconciliation never reconnects blindly");
  });

  it("keeps browser runtime code observation-only", () => {
    const libDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const runtimeClient = readFileSync(join(libDir, "lightlight/runtime.ts"), "utf8");
    const terminal = readFileSync(join(libDir, "../components/terminal/Terminal.tsx"), "utf8");
    assert.doesNotMatch(runtimeClient, /\.submit\(/);
    assert.doesNotMatch(terminal, /alpaca\.server/);
  });
});
