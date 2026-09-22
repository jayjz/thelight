import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { BrokerAccountSnapshot, BrokerOrderState, BrokerPositionSnapshot, HistoricalStockBars, OpenBrokerOrder } from "./alpaca.server.ts";
import { ALPACA_PAPER_BASE_URL, AlpacaTransportError, type AlpacaConfig } from "./alpaca.server.ts";
import { ALPACA_WORKER_ASSET, AlpacaPaperWorker, MemoryAlpacaWorkerStore, alpacaPaperWorkerKey, deterministicClientOrderId, deterministicDecisionId, dispatchBlockReasonFor, isRegularUsEquitySession } from "./alpaca-worker.server.ts";
import { BOUNDED_US_EQUITY_ASSETS, SPY_SPEC } from "./assets.ts";
import { workerRuntimeIdentityFor } from "./runtime-identity.ts";
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
  positionSymbol = "SPY";
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
    return { symbol: this.positionSymbol, quantity: this.positionQuantity, reconciledAt: "2026-09-19T14:00:00.000Z", provenance: "ALPACA_RECONCILED" };
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

const fixtureNow = () => new Date(rawBars().at(-1)!.t + 60_000);

function worker(store: MemoryAlpacaWorkerStore, broker: FakeBroker, updates?: FakeTradeUpdates, inSession = true, historicalBars?: HistoricalStockBars, now?: () => Date) {
  return new AlpacaPaperWorker({ config, store, broker, tradeUpdates: updates, historicalBars, now: now ?? fixtureNow, isRegularSession: () => inSession });
}

class FakeHistoricalBars implements HistoricalStockBars {
  requests: Array<{ symbol: "SPY"; start: number; end: number }> = [];
  private readonly response: (start: number, end: number) => Array<{ t: number; open: number; high: number; low: number; close: number; volume: number }>;
  constructor(response: (start: number, end: number) => Array<{ t: number; open: number; high: number; low: number; close: number; volume: number }>) { this.response = response; }
  async bars(request: { symbol: "SPY"; start: number; end: number }) {
    this.requests.push(request);
    return this.response(request.start, request.end);
  }
}

class ConflictingHistoricalRecoveryStore extends MemoryAlpacaWorkerStore {
  override async recordMarketBar(observation: Parameters<MemoryAlpacaWorkerStore["recordMarketBar"]>[0]) {
    if (observation.origin === "REST_BACKFILL") return "CONFLICT" as const;
    return super.recordMarketBar(observation);
  }
}

async function persistDurableBars(store: MemoryAlpacaWorkerStore, bars: Array<{ t: number; open: number; high: number; low: number; close: number; volume: number }>): Promise<void> {
  for (const bar of bars) await store.insertClosedBar("SPY", bar);
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

async function processLiveBars(target: AlpacaPaperWorker, bars = rawBars()): Promise<void> {
  const fixture = target as unknown as { options: { now?: () => Date } };
  for (const bar of bars) {
    fixture.options.now = () => new Date(bar.t + 60_000);
    await target.processRawBar(bar);
  }
}

async function runToDispatch(target: AlpacaPaperWorker, broker: FakeBroker) {
  await target.start();
  await processLiveBars(target);
  assert.ok(broker.posts > 0, "fixture must produce at least one Arm C paper dispatch after warmup");
}

describe("Alpaca PAPER worker restart and authority invariants", () => {
  it("persists STARTING, RECONCILING, and READY in order only after startup gates pass", async () => {
    const store = new MemoryAlpacaWorkerStore();
    const broker = new FakeBroker();
    let releaseAccount!: () => void;
    let enteredAccount!: () => void;
    const accountEntered = new Promise<void>((resolve) => { enteredAccount = resolve; });
    const accountGate = new Promise<void>((resolve) => { releaseAccount = resolve; });
    const gatedBroker = Object.assign(Object.create(broker) as FakeBroker, {
      async account() {
        broker.accountCalls += 1;
        enteredAccount();
        await accountGate;
        return { equity: broker.equity, reconciledAt: "2026-09-19T14:00:00.000Z", provenance: "ALPACA_PAPER_ACCOUNT" as const };
      },
    });
    const target = worker(store, gatedBroker);
    const starting = target.start();
    await accountEntered;
    const inProgress = store.allRunEvidence()[0]!;
    assert.equal(inProgress.state, "RECONCILING");
    assert.deepEqual(store.runTransitions.map(({ state }) => state), ["STARTING", "RECONCILING"]);
    releaseAccount();
    await starting;
    const run = store.allRunEvidence()[0]!;
    assert.equal(run.state, "READY");
    assert.deepEqual(store.runTransitions.map(({ state }) => state), ["STARTING", "RECONCILING", "READY"]);
    assert.equal(broker.posts, 0, "persisting READY performs no broker order submission");
    await target.stop();
    assert.equal(store.runEvidence(run.runId)?.state, "STOPPED");
    assert.ok(store.runEvidence(run.runId)?.stoppedAt);
  });

  it("persists HALTED on reconciliation failure and STOPPED when shutdown interrupts reconciliation", async () => {
    const failedStore = new MemoryAlpacaWorkerStore();
    const failedBroker = new FakeBroker(); failedBroker.throwAccount = true;
    const failed = worker(failedStore, failedBroker);
    await failed.start();
    const haltedRun = failedStore.allRunEvidence()[0]!;
    assert.equal(haltedRun.state, "HALTED");
    assert.equal(haltedRun.haltReason, "ACCOUNT_UNAVAILABLE");
    assert.ok(haltedRun.stoppedAt);

    const store = new MemoryAlpacaWorkerStore();
    const broker = new FakeBroker();
    let releaseAccount!: () => void;
    let enteredAccount!: () => void;
    const accountEntered = new Promise<void>((resolve) => { enteredAccount = resolve; });
    const accountGate = new Promise<void>((resolve) => { releaseAccount = resolve; });
    const gatedBroker = Object.assign(Object.create(broker) as FakeBroker, {
      async account() {
        broker.accountCalls += 1;
        enteredAccount();
        await accountGate;
        return { equity: broker.equity, reconciledAt: "2026-09-19T14:00:00.000Z", provenance: "ALPACA_PAPER_ACCOUNT" as const };
      },
    });
    const target = worker(store, gatedBroker);
    const starting = target.start();
    await accountEntered;
    const runId = store.allRunEvidence()[0]!.runId;
    assert.equal(store.runEvidence(runId)?.state, "RECONCILING");
    await target.stop();
    releaseAccount();
    await starting;
    const stopped = store.runEvidence(runId)!;
    assert.equal(stopped.state, "STOPPED");
    assert.ok(stopped.stoppedAt);
    assert.equal(store.runTransitions.filter(({ state }) => state === "READY").length, 0);
  });

  it("fails closed when persisting a lifecycle transition fails", async () => {
    const store = new MemoryAlpacaWorkerStore();
    const persistRun = store.updateRun.bind(store);
    let failReconciliationTransition = true;
    store.updateRun = async (runId, state, haltReason) => {
      if (state === "RECONCILING" && failReconciliationTransition) {
        failReconciliationTransition = false;
        throw new Error("RUN_STATE_WRITE_FAILED");
      }
      await persistRun(runId, state, haltReason);
    };
    const broker = new FakeBroker();
    const updates = new FakeTradeUpdates();
    const target = worker(store, broker, updates);
    await target.start();
    assert.equal(target.snapshot().workerState, "HALTED");
    assert.equal(broker.accountCalls, 0, "failed RECONCILING persistence prevents broker reconciliation");
    assert.equal(updates.connects, 0, "failed lifecycle persistence never opens trade updates");
    assert.equal(broker.posts, 0);
    assert.equal(store.allRunEvidence()[0]?.state, "HALTED");
    assert.equal(store.allRunEvidence()[0]?.haltReason, "RUN_STATE_WRITE_FAILED");
    assert.ok(store.allRunEvidence()[0]?.stoppedAt);
  });

  it("creates distinct run evidence on restart and prevents a superseded predecessor from regressing", async () => {
    const store = new MemoryAlpacaWorkerStore();
    const broker = new FakeBroker();
    const first = worker(store, broker);
    await first.start();
    const firstRunId = store.allRunEvidence()[0]!.runId;
    await first.stop();
    const second = worker(store, broker);
    await second.start();
    const runs = store.allRunEvidence();
    assert.equal(runs.length, 2);
    assert.notEqual(runs[0]!.runId, runs[1]!.runId);
    assert.equal(store.runEvidence(firstRunId)?.state, "STOPPED", "restart preserves terminal predecessor evidence");
    await second.stop();

    const takeover = new MemoryAlpacaWorkerStore();
    const priorRun = "prior-run"; const successorRun = "successor-run"; const key = "test-worker";
    await takeover.createRun(priorRun, key, "READY");
    const priorLease = await takeover.acquireOwnership(key, priorRun, 30);
    assert.ok(priorLease);
    await takeover.releaseOwnership(priorLease);
    await takeover.createRun(successorRun, key, "STARTING");
    assert.ok(await takeover.acquireOwnership(key, successorRun, 30));
    const superseded = takeover.runEvidence(priorRun)!;
    assert.equal(superseded.state, "SUPERSEDED");
    assert.equal(superseded.supersededByRunId, successorRun);
    assert.ok(superseded.stoppedAt && superseded.supersededAt && superseded.supersedeReason);
    await assert.rejects(() => takeover.updateRun(priorRun, "READY", null), /WORKER_RUN_LIFECYCLE_UPDATE_REJECTED/);
    await assert.rejects(() => takeover.updateRun(priorRun, "RECONCILING", null), /WORKER_RUN_LIFECYCLE_UPDATE_REJECTED/);
    await assert.rejects(() => takeover.updateRun(priorRun, "STOPPED", null), /WORKER_RUN_LIFECYCLE_UPDATE_REJECTED/);
    assert.equal(takeover.runEvidence(priorRun)?.state, "SUPERSEDED");
    assert.equal(takeover.runTransitions.filter(({ runId, state }) => runId === priorRun && state === "SUPERSEDED").length, 1);
  });

  it("stops a predecessor whose lease is taken over during asynchronous startup", async () => {
    const store = new MemoryAlpacaWorkerStore();
    const broker = new FakeBroker();
    let releaseAccount!: () => void;
    let enteredAccount!: () => void;
    const accountEntered = new Promise<void>((resolve) => { enteredAccount = resolve; });
    const accountGate = new Promise<void>((resolve) => { releaseAccount = resolve; });
    const gatedBroker = Object.assign(Object.create(broker) as FakeBroker, {
      async account() {
        broker.accountCalls += 1;
        enteredAccount();
        await accountGate;
        return { equity: broker.equity, reconciledAt: "2026-09-19T14:00:00.000Z", provenance: "ALPACA_PAPER_ACCOUNT" as const };
      },
    });
    const updates = new FakeTradeUpdates();
    const predecessor = worker(store, gatedBroker, updates);
    const starting = predecessor.start();
    await accountEntered;
    const oldRun = store.allRunEvidence()[0]!;
    const oldLease = store.leaseEvidence(oldRun.workerKey)!;
    await store.releaseOwnership(oldLease);
    const successorRun = "successor-after-startup-race";
    await store.createRun(successorRun, oldRun.workerKey, "STARTING");
    assert.ok(await store.acquireOwnership(oldRun.workerKey, successorRun, 30));
    await predecessor.stop();
    releaseAccount();
    await starting;
    assert.equal(store.runEvidence(oldRun.runId)?.state, "SUPERSEDED");
    assert.equal(store.runEvidence(oldRun.runId)?.supersededByRunId, successorRun);
    assert.equal(predecessor.snapshot().workerState, "STOPPED");
    assert.equal(updates.connects, 0);
  });

  it("applies stale-bar, reconciliation, and ownership gates to both SPY dispatch arms", () => {
    const healthy = {
      dispatchCapable: true,
      inSession: true,
      warmupComplete: true,
      featureContinuity: "HEALTHY" as const,
      recoveryState: "HEALTHY" as const,
      latestLiveBarStale: false,
      reconciliationComplete: true,
      hasOwnership: true,
    };
    for (const arm of ["ema_trend_arm_c", "ema_rsi_v1"] as const) {
      const identity = workerRuntimeIdentityFor(SPY_SPEC, arm);
      assert.equal(identity.capability.kind, "DISPATCH_CAPABLE");
      assert.equal(dispatchBlockReasonFor({ ...healthy, latestLiveBarStale: true }), "LATEST_LIVE_BAR_STALE", `${arm} stale live bar`);
      assert.equal(dispatchBlockReasonFor({ ...healthy, reconciliationComplete: false }), "BROKER_RECONCILIATION_INCOMPLETE", `${arm} reconciliation`);
      assert.equal(dispatchBlockReasonFor({ ...healthy, hasOwnership: false }), "DISPATCH_OWNERSHIP_REQUIRED", `${arm} ownership`);
      assert.equal(dispatchBlockReasonFor(healthy), null, `${arm} healthy dispatch`);
    }
  });

  it("keeps read-only durable symbols evidence-only without broker reconciliation, trade updates, or POSTs", async () => {
    const readOnlyAssets = BOUNDED_US_EQUITY_ASSETS.filter((asset) => asset.symbol !== "SPY");
    for (const arm of ["ema_trend_arm_c", "ema_rsi_v1"] as const) {
      for (const asset of readOnlyAssets) {
        const store = new MemoryAlpacaWorkerStore();
        const broker = new FakeBroker();
        const updates = new FakeTradeUpdates();
        const target = new AlpacaPaperWorker({
          config: { ...config, symbol: asset.symbol }, asset, arm, store, broker, tradeUpdates: updates,
          isRegularSession: () => true,
          now: () => new Date(rawBars(45).at(-1)!.t + 60_000),
        });
        await target.start();
        for (const bar of rawBars(45)) await target.processRawBar(bar);
        assert.equal(target.snapshot().runtimeCapability, "READ_ONLY_DURABLE", `${asset.symbol} ${arm}`);
        assert.ok(store.decisionCount() > 0, `${asset.symbol} ${arm} produces research evidence`);
        assert.equal(broker.accountCalls, 0, `${asset.symbol} ${arm} never reconciles broker account`);
        assert.equal(broker.positionCalls, 0, `${asset.symbol} ${arm} never reconciles broker position`);
        assert.equal(updates.connects, 0, `${asset.symbol} ${arm} never connects trade_updates`);
        assert.equal(broker.posts, 0, `${asset.symbol} ${arm} cannot broker POST`);
        assert.ok((await store.listIntents(asset.symbol, target.snapshot().workerKey)).every((row) => row.dispatchBlockReason === "READ_ONLY_RUNTIME"));
        await target.stop();
      }
    }
  });

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
    broker.found.set(clientOrderId, { decisionId: submitted.decisionId, intentId: submitted.intentId, clientOrderId, brokerOrderId: "broker-1", status: "ACCEPTED", updatedAt: "2026-09-19T14:00:00.000Z", rawStatus: "accepted", lookup: "FOUND" });
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
    await processLiveBars(unavailable);
    assert.equal(unavailable.snapshot().workerState, "HALTED"); assert.equal(unavailableBroker.posts, 0);

    const wrongSymbolStore = new MemoryAlpacaWorkerStore(); const wrongSymbolBroker = new FakeBroker(); wrongSymbolBroker.positionSymbol = "QQQ";
    const wrongSymbol = worker(wrongSymbolStore, wrongSymbolBroker); await wrongSymbol.start();
    assert.equal(wrongSymbol.snapshot().workerState, "HALTED", "SPY worker rejects a non-SPY broker position");

    const conflictStore = new MemoryAlpacaWorkerStore(); const conflictBroker = new FakeBroker(); conflictBroker.openOnDispatch = true;
    const conflictWorker = worker(conflictStore, conflictBroker); await conflictWorker.start();
    await processLiveBars(conflictWorker);
    assert.equal(conflictBroker.posts, 0);
    assert.ok((await conflictStore.listIntents()).some((row) => row.dispatchBlockReason === "OPEN_ORDER_CONFLICT"));
  });

  it("persists trade updates, reconciles after stream loss, and never dispatches outside the exchange session", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const updates = new FakeTradeUpdates();
    const target = new AlpacaPaperWorker({ config, store, broker, tradeUpdates: updates, isRegularSession: () => true, now: fixtureNow, sleep: async () => undefined });
    await runToDispatch(target, broker);
    const accepted = (await store.listIntents()).find(({ intent }) => intent.status === "ACCEPTED")!.intent;
    await target.processTradeUpdate({ stream: "trade_updates", data: { event: "fill", order: { id: "broker-1", status: "filled", symbol: "SPY", client_order_id: accepted.clientOrderId } } });
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

  it("converges an ACCEPTED intent on fill and ignores duplicate, replayed, and late nonterminal updates", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const target = worker(store, broker);
    await runToDispatch(target, broker);
    const accepted = (await store.listIntents()).find(({ intent }) => intent.status === "ACCEPTED")!.intent;
    const update = { stream: "trade_updates", data: { event: "fill", order: { id: "broker-1", status: "filled", symbol: "SPY", client_order_id: accepted.clientOrderId } } };
    const posts = broker.posts;
    await target.processTradeUpdate(update);
    await target.processTradeUpdate(update);
    await target.processTradeUpdate({ ...update, data: { event: "new", order: { ...update.data.order, status: "new" } } });
    assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === accepted.intentId)?.intent.status, "FILLED");
    assert.equal(store.updates.length, 3, "all stream observations remain durable evidence");
    assert.equal(store.posts.filter((state) => state.intentId === accepted.intentId && state.status === "FILLED").length, 2);
    assert.equal(broker.posts, posts, "trade updates never authorize another POST");
    await target.stop();
    const recreated = worker(store, broker); await recreated.start();
    await recreated.processTradeUpdate(update);
    assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === accepted.intentId)?.intent.status, "FILLED");
    assert.equal(broker.posts, posts);
  });

  it("adopts broker-authoritative FILLED from SUBMISSION_ATTEMPTED without reposting", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const first = worker(store, broker);
    await runToDispatch(first, broker);
    const submitted = (await store.listIntents()).find(({ intent }) => intent.status === "ACCEPTED")!.intent;
    await store.putIntent({ ...submitted, status: "SUBMISSION_ATTEMPTED" });
    broker.found.set(submitted.clientOrderId!, { decisionId: submitted.decisionId, intentId: submitted.intentId, clientOrderId: submitted.clientOrderId!, brokerOrderId: "broker-1", status: "FILLED", updatedAt: "2026-09-22T14:00:00.000Z", rawStatus: "filled", lookup: "FOUND" });
    const posts = broker.posts;
    await first.stop(); const recreated = worker(store, broker); await recreated.start();
    assert.equal(recreated.snapshot().workerState, "READY");
    assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === submitted.intentId)?.intent.status, "FILLED");
    assert.equal(broker.posts, posts);
  });

  it("terminalizes a no-op position match after the fenced claim and stays restartable", async () => {
    class NoOpBroker extends FakeBroker {
      override async submit(intent: ExecutionIntent): Promise<BrokerOrderState> {
        this.posts += 1;
        return { decisionId: intent.decisionId, intentId: intent.intentId, clientOrderId: intent.clientOrderId!, brokerOrderId: null, status: "CANCELLED", updatedAt: null, rawStatus: null, lookup: "ABSENT" };
      }
    }
    const store = new MemoryAlpacaWorkerStore(); const broker = new NoOpBroker(); const first = worker(store, broker);
    await runToDispatch(first, broker);
    const noOp = (await store.listIntents()).find(({ intent }) => intent.status === "CANCELLED" && store.posts.some((state) => state.intentId === intent.intentId && state.lookup === "ABSENT" && state.status === "CANCELLED"));
    assert.ok(noOp, "position match should finish the claimed intent without an order");
    const submits = broker.posts;
    await first.stop(); const recreated = worker(store, broker); await recreated.start();
    assert.equal(recreated.snapshot().workerState, "READY");
    assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === noOp.intent.intentId)?.intent.status, "CANCELLED");
    assert.equal(broker.posts, submits);
  });

  it("keeps partial fills nonterminal and preserves canceled, rejected, expired, and done-for-day semantics", async () => {
    for (const [event, expected] of [["canceled", "CANCELLED"], ["rejected", "REJECTED"], ["expired", "CANCELLED"], ["done_for_day", "CANCELLED"]] as const) {
      const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const target = worker(store, broker);
      await runToDispatch(target, broker);
      const accepted = (await store.listIntents()).find(({ intent }) => intent.status === "ACCEPTED")!.intent;
      const order = { id: "broker-1", symbol: "SPY", client_order_id: accepted.clientOrderId };
      await target.processTradeUpdate({ stream: "trade_updates", data: { event: "partial_fill", order: { ...order, status: "partially_filled" } } });
      assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === accepted.intentId)?.intent.status, "PARTIALLY_FILLED");
      await target.processTradeUpdate({ stream: "trade_updates", data: { event, order: { ...order, status: event } } });
      assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === accepted.intentId)?.intent.status, expected);
      await target.processTradeUpdate({ stream: "trade_updates", data: { event: "partial_fill", order: { ...order, status: "partially_filled" } } });
      assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === accepted.intentId)?.intent.status, expected);
    }
  });

  it("persists but cannot apply unknown, malformed, wrong-symbol, or wrong-order updates", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const target = worker(store, broker);
    await runToDispatch(target, broker);
    const accepted = (await store.listIntents()).find(({ intent }) => intent.status === "ACCEPTED")!.intent;
    const order = { id: "broker-1", status: "filled", symbol: "SPY", client_order_id: accepted.clientOrderId };
    const posts = broker.posts;
    const invalid = [
      { stream: "trade_updates", data: { event: "fill", order: { ...order, client_order_id: "unknown-client-order" } } },
      { stream: "trade_updates", data: { event: "fill", order: { ...order, symbol: "QQQ" } } },
      { stream: "trade_updates", data: { event: "fill", order: { ...order, id: "" } } },
      { stream: "trade_updates", data: { event: "fill", order: null } },
      { stream: "trade_updates", data: { event: "partial_fill", order: { ...order, status: "partially_filled" } } },
    ];
    for (const update of invalid.slice(0, 4)) await target.processTradeUpdate(update);
    assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === accepted.intentId)?.intent.status, "ACCEPTED");
    await target.processTradeUpdate(invalid[4]!);
    assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === accepted.intentId)?.intent.status, "PARTIALLY_FILLED");
    await assert.rejects(() => target.processTradeUpdate({ stream: "trade_updates", data: { event: "fill", order: { ...order, id: "another-order" } } }), /CORRELATION_LOST/);
    assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === accepted.intentId)?.intent.status, "PARTIALLY_FILLED");
    assert.equal(store.updates.length, 6);
    assert.equal(broker.posts, posts);
  });

  it("repairs the September 22 FILLED broker and trade evidence with stale ACCEPTED projection on restart", async () => {
    const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/paper-fill-stale-accepted.json"), "utf8")) as {
      observedAt: string; intentStatus: "ACCEPTED"; brokerOrder: Pick<BrokerOrderState, "brokerOrderId" | "status" | "rawStatus" | "lookup">;
      tradeUpdate: { stream: string; data: { event: string; order: { id: string; client_order_id: string; symbol: string; status: string } } };
    };
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const first = worker(store, broker);
    await runToDispatch(first, broker);
    const accepted = (await store.listIntents()).find(({ intent }) => intent.status === fixture.intentStatus)!.intent;
    const filled = { ...fixture.brokerOrder, decisionId: accepted.decisionId, intentId: accepted.intentId, clientOrderId: accepted.clientOrderId!, updatedAt: fixture.observedAt };
    store.posts.push(filled);
    store.updates.push({ update: { ...fixture.tradeUpdate, data: { ...fixture.tradeUpdate.data, order: { ...fixture.tradeUpdate.data.order, client_order_id: accepted.clientOrderId! } } }, clientOrderId: accepted.clientOrderId! });
    broker.found.set(accepted.clientOrderId!, filled);
    const posts = broker.posts; const observations = [...store.posts]; const updates = store.updates.length;
    await first.stop(); const recreated = worker(store, broker); await recreated.start();
    assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === accepted.intentId)?.intent.status, "FILLED");
    assert.deepEqual(store.posts.slice(0, observations.length), observations, "reconciliation retains prior broker evidence");
    assert.ok(store.posts.length > observations.length, "reconciliation appends broker evidence");
    assert.equal(store.updates.length, updates, "persisted fill update stays intact");
    assert.equal(broker.posts, posts);
  });

  it("does not let a stale fence project a fill or claim POST authority", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const first = worker(store, broker);
    await runToDispatch(first, broker);
    const accepted = (await store.listIntents()).find(({ intent }) => intent.status === "ACCEPTED")!.intent;
    const postCount = broker.posts;
    await first.stop();
    const key = alpacaPaperWorkerKey();
    const scope = { workerKey: key, asset: { symbol: "SPY" } };
    const oldLease = await store.acquireOwnership(key, "old-run", 30);
    assert.ok(oldLease);
    await store.releaseOwnership(oldLease);
    const currentLease = await store.acquireOwnership(key, "current-run", 30);
    assert.ok(currentLease);
    const filled = { decisionId: accepted.decisionId, intentId: accepted.intentId, clientOrderId: accepted.clientOrderId!, brokerOrderId: "broker-1", status: "FILLED" as const, updatedAt: "2026-09-22T14:00:00.000Z", rawStatus: "filled", lookup: "FOUND" as const };
    const evidenceCount = store.posts.length;
    assert.equal(await store.recordBrokerOrder(oldLease, scope, filled), null);
    assert.equal(store.posts.length, evidenceCount);
    assert.equal((await store.listIntents()).find(({ intent }) => intent.intentId === accepted.intentId)?.intent.status, "ACCEPTED");
    await store.putIntent({ ...accepted, status: "PENDING" });
    assert.equal(await store.claimIntentForDispatch(oldLease, { ...accepted, status: "PENDING" }, scope), false);
    assert.equal(await store.claimIntentForDispatch(currentLease, { ...accepted, status: "PENDING" }, scope), true);
    assert.equal(broker.posts, postCount, "a claim alone does not POST an order");
  });

  it("bounds trade-stream recovery, reconciles before replacement, and preserves decision/submission idempotency", async () => {
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker(); const updates = new FakeTradeUpdates();
    const backoffs: Array<{ delay: number; resolve: () => void }> = [];
    const target = new AlpacaPaperWorker({
      config, store, broker, tradeUpdates: updates, isRegularSession: () => true,
      reconnectDelayMs: (attempt) => attempt * 10,
      now: fixtureNow, sleep: (delay) => new Promise<void>((resolve) => { backoffs.push({ delay, resolve }); }),
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
    assert.equal(alpacaPaperWorkerKey(), "alpaca-paper:SPY:15Min:alpaca-paper-worker-v1");
    assert.equal(alpacaPaperWorkerKey(ALPACA_WORKER_ASSET), alpacaPaperWorkerKey());
    const target = worker(new MemoryAlpacaWorkerStore(), new FakeBroker());
    assert.equal(target.snapshot().symbol, "SPY");
    assert.equal(target.snapshot().feed, "iex");
    assert.equal(target.snapshot().decisionTimeframe, "15Min");
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

  it("repairs an exact 1m gap with REST provenance without retroactive dispatch", async () => {
    const bars = rawBars(30); const missing = bars[24 * 15 + 4]!;
    const historical = new FakeHistoricalBars((start, end) => bars.filter((bar) => bar.t >= start && bar.t < end));
    const store = new MemoryAlpacaWorkerStore(); const broker = new FakeBroker();
    const target = worker(store, broker, undefined, true, historical, () => new Date(missing.t + 2 * 60_000));
    await target.start();
    for (const bar of bars.filter((bar) => bar.t < missing.t)) await target.processRawBar(bar);
    const postsBeforeRepair = broker.posts;
    for (const bar of bars.filter((bar) => bar.t > missing.t && bar.t <= missing.t + 60_000)) await target.processRawBar(bar);
    assert.deepEqual(historical.requests, [{ symbol: "SPY", start: missing.t, end: missing.t + 60_000 }]);
    assert.equal(target.snapshot().recoveryState, "HEALTHY");
    assert.equal(target.snapshot().featureContinuity, "HEALTHY");
    assert.equal(broker.posts, postsBeforeRepair, "the repaired historical bucket cannot dispatch");
    const observation = store.marketObservations().find((item) => item.origin === "REST_BACKFILL");
    assert.equal(observation?.verificationResult, "ACCEPTED");
    assert.equal(observation?.bar.t, missing.t);
    assert.equal(observation?.providerEventTimestampMs, missing.t);
    assert.equal(observation?.observedAt, new Date(missing.t + 2 * 60_000).toISOString());
    assert.ok(observation?.recoveryAttemptId);
    assert.equal(store.recoveryAttempt(observation!.recoveryAttemptId!)?.result, "VERIFIED");

    for (const bar of bars.filter((bar) => bar.t > missing.t + 60_000)) await target.processRawBar(bar);
    assert.ok(broker.posts > postsBeforeRepair, "a subsequent live bucket may use repaired history");
  });

  it("repairs one durable restart gap, restores continuity, and defers dispatch until a future live bucket", async () => {
    const bars = rawBars(24); const durableLatest = bars.at(-1)!; const missing = bars[10 * 15 + 4]!;
    const store = new MemoryAlpacaWorkerStore();
    await persistDurableBars(store, bars.filter((bar) => bar.t !== missing.t));
    const broker = new FakeBroker();
    const historical = new FakeHistoricalBars((start, end) => bars.filter((bar) => bar.t >= start && bar.t < end));
    const now = () => new Date(durableLatest.t + 2 * 60_000);
    const restarted = worker(store, broker, undefined, true, historical, now);

    await restarted.start();

    assert.deepEqual(historical.requests, [{ symbol: "SPY", start: missing.t, end: missing.t + 60_000 }]);
    assert.equal(restarted.snapshot().featureContinuity, "HEALTHY");
    assert.equal(restarted.snapshot().recoveryState, "HEALTHY");
    assert.equal(broker.posts, 0, "startup repair never creates a retroactive broker POST");
    assert.equal(store.decisionCount(), 0, "startup repair never creates retroactive decisions");
    const repaired = store.marketObservations().find((observation) => observation.origin === "REST_BACKFILL");
    assert.equal(repaired?.bar.t, missing.t);
    assert.equal(repaired?.verificationResult, "ACCEPTED");

    const nextDispatchBarrier = durableLatest.t + 15 * 60_000;
    for (const bar of rawBars(26).filter((bar) => bar.t > durableLatest.t && bar.t < durableLatest.t + 30 * 60_000)) await restarted.processRawBar(bar);
    assert.ok(broker.posts > 0, "a future live bucket may dispatch after verification completes");
    assert.ok(store.decisionEvidence().every((evidence) => evidence.timestamp >= nextDispatchBarrier), "only a future live bucket becomes dispatch-eligible");
  });

  it("repairs separated durable restart gaps oldest-first", async () => {
    const bars = rawBars(24); const first = bars[10 * 15 + 4]!; const second = bars[13 * 15 + 7]!;
    const firstEnd = first.t + 2 * 60_000; const secondEnd = second.t + 3 * 60_000;
    const store = new MemoryAlpacaWorkerStore();
    await persistDurableBars(store, bars.filter((bar) =>
      (bar.t < first.t || bar.t >= firstEnd) && (bar.t < second.t || bar.t >= secondEnd)));
    const historical = new FakeHistoricalBars((start, end) => bars.filter((bar) => bar.t >= start && bar.t < end));
    const target = worker(store, new FakeBroker(), undefined, true, historical, () => new Date(bars.at(-1)!.t + 2 * 60_000));

    await target.start();

    assert.deepEqual(historical.requests, [
      { symbol: "SPY", start: first.t, end: firstEnd },
      { symbol: "SPY", start: second.t, end: secondEnd },
    ]);
    assert.equal(target.snapshot().featureContinuity, "HEALTHY");
    assert.equal(target.snapshot().recoveryState, "HEALTHY");
  });

  it("keeps startup recovery fail-closed for partial, conflicting, and unavailable history", async () => {
    const bars = rawBars(24); const first = bars[22 * 15 + 4]!; const second = bars[22 * 15 + 5]!;
    const partialStore = new MemoryAlpacaWorkerStore();
    await persistDurableBars(partialStore, bars.filter((bar) => bar.t !== first.t && bar.t !== second.t));
    const partial = new FakeHistoricalBars((start) => [bars.find((bar) => bar.t === start)!]);
    const partialBroker = new FakeBroker();
    const partialWorker = worker(partialStore, partialBroker, undefined, true, partial, () => new Date(bars.at(-1)!.t + 2 * 60_000));
    await partialWorker.start();
    assert.equal(partialWorker.snapshot().recoveryState, "REBUILDING");
    assert.equal(partialWorker.snapshot().featureContinuity, "REBUILDING");
    assert.equal(partialBroker.posts, 0);

    const conflictStore = new ConflictingHistoricalRecoveryStore();
    await persistDurableBars(conflictStore, bars.filter((bar) => bar.t !== first.t));
    const conflictBroker = new FakeBroker();
    const conflict = new FakeHistoricalBars((start, end) => bars.filter((bar) => bar.t >= start && bar.t < end));
    const conflictWorker = worker(conflictStore, conflictBroker, undefined, true, conflict, () => new Date(bars.at(-1)!.t + 2 * 60_000));
    await conflictWorker.start();
    assert.equal(conflictWorker.snapshot().recoveryState, "REBUILDING");
    assert.equal(conflictWorker.snapshot().featureContinuity, "REBUILDING");
    assert.equal(conflictBroker.posts, 0);

    const unavailableStore = new MemoryAlpacaWorkerStore();
    await persistDurableBars(unavailableStore, bars.filter((bar) => bar.t !== first.t));
    const unavailable = new FakeHistoricalBars(() => { throw new AlpacaTransportError("PROTOCOL_FAILURE", "safe test failure"); });
    const unavailableWorker = worker(unavailableStore, new FakeBroker(), undefined, true, unavailable, () => new Date(bars.at(-1)!.t + 2 * 60_000));
    await unavailableWorker.start();
    assert.equal(unavailableWorker.snapshot().recoveryState, "REBUILDING");
    assert.equal(unavailableWorker.snapshot().featureContinuity, "REBUILDING");
    const failedAttempt = unavailableStore.recoveryAttempt(unavailableWorker.snapshot().recoveryAttemptId!);
    assert.equal(failedAttempt?.result, "BACKFILL_REQUEST_FAILED");
    assert.equal(failedAttempt?.reason, "PROTOCOL_FAILURE");
  });

  it("keeps dispatch blocked for partial multi-minute backfill and fails closed on conflicts", async () => {
    const bars = rawBars(30); const first = bars[24 * 15 + 4]!; const second = bars[24 * 15 + 5]!;
    const partial = new FakeHistoricalBars((start) => [bars.find((bar) => bar.t === start)!]);
    const partialStore = new MemoryAlpacaWorkerStore(); const partialBroker = new FakeBroker();
    const partialWorker = worker(partialStore, partialBroker, undefined, true, partial, () => new Date(first.t + 2 * 60_000));
    await partialWorker.start();
    for (const bar of bars.filter((bar) => bar.t < first.t)) await partialWorker.processRawBar(bar);
    const partialPostsBeforeGap = partialBroker.posts;
    for (const bar of bars.filter((bar) => bar.t > second.t && bar.t <= second.t + 60_000)) await partialWorker.processRawBar(bar);
    assert.equal(partialWorker.snapshot().recoveryState, "REBUILDING");
    assert.equal(partialBroker.posts, partialPostsBeforeGap, "partial backfill is never dispatch authority");
    assert.equal(partial.requests[0]!.end - partial.requests[0]!.start, 2 * 60_000);

    const conflictStore = new MemoryAlpacaWorkerStore();
    const conflictBroker = new FakeBroker();
    const conflict = new FakeHistoricalBars((start, end) => bars.filter((bar) => bar.t >= start && bar.t < end));
    const conflictWorker = worker(conflictStore, conflictBroker, undefined, true, conflict, () => new Date(first.t + 2 * 60_000));
    await conflictWorker.start();
    for (const bar of bars.filter((bar) => bar.t < first.t)) await conflictWorker.processRawBar(bar);
    await conflictStore.insertClosedBar("SPY", { ...first, close: first.close + 9 });
    const conflictPostsBeforeGap = conflictBroker.posts;
    for (const bar of bars.filter((bar) => bar.t > first.t && bar.t <= first.t + 60_000)) await conflictWorker.processRawBar(bar);
    assert.equal(conflictWorker.snapshot().recoveryState, "REBUILDING");
    const conflictObservation = conflictStore.marketObservations().find((item) => item.origin === "REST_BACKFILL");
    assert.equal(conflictObservation?.verificationResult, "CONFLICT");
    assert.equal(conflictBroker.posts, conflictPostsBeforeGap);
  });

  it("keeps identical LIVE_WS and REST_BACKFILL observations idempotent", async () => {
    const store = new MemoryAlpacaWorkerStore(); const bar = rawBars(1)[0]!;
    assert.equal(await store.recordMarketBar({ symbol: "SPY", bar, providerEventTimestampMs: bar.t, observedAt: "2026-09-21T13:31:00.000Z", origin: "LIVE_WS", recoveryAttemptId: null }), "ACCEPTED");
    assert.equal(await store.recordMarketBar({ symbol: "SPY", bar, providerEventTimestampMs: bar.t, observedAt: "2026-09-21T13:32:00.000Z", origin: "REST_BACKFILL", recoveryAttemptId: "attempt-1" }), "IDENTICAL");
    assert.equal((await store.listClosedBars("SPY")).length, 1);
    assert.equal(store.marketObservations().filter((item) => item.bar.t === bar.t).length, 2);
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
