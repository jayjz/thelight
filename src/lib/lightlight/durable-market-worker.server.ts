import { randomUUID } from "node:crypto";
import type { MarketSource } from "./market.ts";
import type { ClosedBar } from "./types.ts";
import type { AlpacaWorkerStore, WorkerCheckpoint, WorkerLease } from "./alpaca-worker-store.server.ts";
import { assertReadOnlyDurable, type ReadOnlyDurableCapability, type WorkerRuntimeIdentity } from "./runtime-identity.ts";

export const MARKET_WORKER_LEASE_SECONDS = 30;
export const MARKET_WORKER_RENEW_MS = 10_000;
export const MARKET_WORKER_STARTUP_TIMEOUT_MS = 60_000;
const RECOVERY_WINDOW_MS = 24 * 60 * 60_000;

export type DurableMarketStore = Pick<AlpacaWorkerStore,
  "durable" | "createRun" | "updateRun" | "acquireOwnership" | "renewOwnership" | "releaseOwnership" |
  "recordMarketBar" | "latestClosedBarTimestamp" | "listClosedBars" | "readCheckpoint" | "writeCheckpointOwned"
>;

export type MarketStreamEvidence = {
  state: string;
  subscriptionAcknowledged: boolean;
  generation: number;
  reconnectAttempt: number;
  lastError: string | null;
};
export type DurableMarketEvidence = {
  runId: string;
  stream: MarketStreamEvidence | null;
  recoveredClosedBarCount: number;
  recoveryWindowMs: number;
  continuity: "UNVERIFIED" | "GAP_DETECTED";
  lastBarPersistedAt: string | null;
};
type ObservableMarketSource = MarketSource & { close?(): void; snapshot?(): MarketStreamEvidence };
export type DurableMarketWorkerSnapshot = {
  workerKey: string;
  symbol: string;
  assetClass: string;
  decisionTimeframe: "15Min" | "1Min";
  runtimeCapability: ReadOnlyDurableCapability["kind"];
  brokerAuthority: "NONE";
  state: "STOPPED" | "STARTING" | "READY" | "HALTED";
  runId: string | null;
  lease: WorkerLease | null;
  latestRawBarTimestamp: number | null;
  latestClosedDecisionBarTimestamp: number | null;
  recoveredClosedBarCount: number;
  haltReason: string | null;
  persistenceError: boolean;
};
export type DurableMarketWorkerOptions = {
  identity: WorkerRuntimeIdentity & { capability: ReadOnlyDurableCapability };
  store: DurableMarketStore;
  source?: ObservableMarketSource;
  now?: () => number;
};
function emptyCheckpoint(): WorkerCheckpoint {
  return {
    latestRawBarTimestamp: null, latestClosedDecisionBarTimestamp: null,
    latestDecisionId: null, lastReconciliationTimestamp: null,
    streamState: "DISCONNECTED", marketStreamState: "DISCONNECTED", tradeUpdateStreamState: "DISCONNECTED",
    featureContinuity: "REBUILDING", recoveryState: "HEALTHY", recoveryAttemptId: null,
    recoveryMissingStartMs: null, recoveryMissingEndMs: null, recoveryCompletedAt: null,
    recoveryDispatchNotBeforeBucketMs: null, paperEquityHighWater: null,
    lastPaperEquity: null, priorRiskApprovedTarget: null, haltReason: null,
  };
}

/** Broker-free durable evidence worker. All mutations serialize with stop and renewal. */
export class DurableMarketWorker {
  private readonly options: DurableMarketWorkerOptions;
  private readonly now: () => number;
  private state: DurableMarketWorkerSnapshot["state"] = "STOPPED";
  private checkpoint = emptyCheckpoint();
  private lease: WorkerLease | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private runId: string | null = null;
  private stopped = false;
  private persistenceError = false;
  private operations: Promise<void> = Promise.resolve();
  private heartbeatPending = false;
  private startedAt = 0;
  private renewedAt = 0;
  private evidence: DurableMarketEvidence | null = null;

  constructor(options: DurableMarketWorkerOptions) {
    assertReadOnlyDurable(options.identity);
    this.options = options;
    this.now = options.now ?? Date.now;
  }
  snapshot(): DurableMarketWorkerSnapshot {
    return {
      workerKey: this.options.identity.workerKey, symbol: this.options.identity.asset.symbol,
      assetClass: this.options.identity.asset.assetClass, decisionTimeframe: this.options.identity.decisionTimeframe,
      runtimeCapability: this.options.identity.capability.kind, brokerAuthority: "NONE", state: this.state,
      runId: this.runId, lease: this.lease ? { ...this.lease } : null,
      latestRawBarTimestamp: this.checkpoint.latestRawBarTimestamp,
      latestClosedDecisionBarTimestamp: this.checkpoint.latestClosedDecisionBarTimestamp,
      recoveredClosedBarCount: this.evidence?.recoveredClosedBarCount ?? 0,
      haltReason: this.checkpoint.haltReason, persistenceError: this.persistenceError,
    };
  }
  async start(): Promise<void> {
    if (this.runId || this.stopped) throw new Error("MARKET_WORKER_INSTANCE_ALREADY_USED");
    await this.enqueue(async () => {
      this.state = "STARTING";
      this.startedAt = this.now();
      if (!this.options.store.durable) return this.halt("DURABLE_STORAGE_REQUIRED");
      this.runId = randomUUID();
      await this.options.store.createRun(this.runId, this.options.identity.workerKey, "STARTING");
      this.lease = await this.options.store.acquireOwnership(this.options.identity.workerKey, this.runId, MARKET_WORKER_LEASE_SECONDS);
      if (!this.lease) return this.halt("DURABLE_RUNTIME_OWNERSHIP_UNAVAILABLE");
      this.renewedAt = this.now();
      const prior = await this.options.store.readCheckpoint(this.options.identity.workerKey);
      this.checkpoint = { ...emptyCheckpoint(), ...prior, haltReason: null };
      const latest = await this.options.store.latestClosedBarTimestamp(this.options.identity.asset.symbol);
      const bars = latest === null ? [] : await this.options.store.listClosedBars(this.options.identity.asset.symbol, latest - RECOVERY_WINDOW_MS + 60_000, latest);
      // Repair a crash between immutable bar insertion and checkpoint advancement.
      if (latest !== null) this.checkpoint.latestRawBarTimestamp = Math.max(latest, this.checkpoint.latestRawBarTimestamp ?? 0);
      this.evidence = {
        runId: this.runId, stream: null, recoveredClosedBarCount: bars.length,
        recoveryWindowMs: RECOVERY_WINDOW_MS, continuity: prior?.marketEvidence?.continuity ?? "UNVERIFIED",
        lastBarPersistedAt: prior?.marketEvidence?.lastBarPersistedAt ?? null,
      };
      // Recovery must inspect gaps too, including a bar committed before its
      // checkpoint write. Merely taking max(timestamp) would erase that warning.
      for (let index = 1; index < bars.length; index += 1) {
        const previous = bars[index - 1]!.t;
        const current = bars[index]!.t;
        if (current > previous + 60_000) this.markGap(previous, current);
      }
      await this.syncStream();
      await this.persistCheckpoint();
      if (!this.active()) return;
      // Referenced timer is intentional: READY remains a continuously running service.
      this.timer = setInterval(() => {
        if (this.heartbeatPending) return;
        this.heartbeatPending = true;
        void this.enqueue(() => this.heartbeat()).finally(() => { this.heartbeatPending = false; });
      }, 1_000);
      if (this.options.source) void this.consume(this.options.source);
    });
    while (this.state === "STARTING" && !this.stopped) await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    this.options.source?.close?.();
    await this.enqueue(async () => {
      if (this.state === "STOPPED") return;
      // HALTED is terminal durable evidence; cleanup must not rewrite it as STOPPED.
      if (this.state !== "HALTED") {
        this.state = "STOPPED";
        this.captureStream();
        await this.persistCheckpoint();
        if (this.snapshot().state !== "HALTED" && this.runId) await this.options.store.updateRun(this.runId, "STOPPED", null);
      }
      await this.release();
    });
  }
  async processClosedBar(bar: ClosedBar): Promise<void> {
    await this.enqueue(async () => {
      if (!this.active()) return;
      await this.syncStream();
      if (this.state !== "READY" || this.stopped) return;
      if (!Number.isFinite(bar.t) || bar.t % 60_000 !== 0 || bar.t + 60_000 > this.now() ||
        [bar.open, bar.high, bar.low, bar.close, bar.volume].some((v) => !Number.isFinite(v)) ||
        Math.min(bar.open, bar.high, bar.low, bar.close) <= 0 || bar.volume < 0 ||
        bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close)) {
        return this.halt("INVALID_COMPLETED_MARKET_BAR");
      }
      const previous = this.checkpoint.latestRawBarTimestamp;
      const result = await this.options.store.recordMarketBar({ symbol: this.options.identity.asset.symbol, bar,
        providerEventTimestampMs: bar.t, observedAt: new Date(this.now()).toISOString(), origin: "LIVE_WS", recoveryAttemptId: null });
      if (result === "CONFLICT") return this.halt("MARKET_BAR_CONFLICT");
      if (previous !== null && bar.t > previous + 60_000 && this.evidence) {
        this.markGap(previous, bar.t);
      }
      this.checkpoint.latestRawBarTimestamp = Math.max(previous ?? 0, bar.t);
      if (this.evidence && (previous === null || bar.t > previous)) this.evidence.lastBarPersistedAt = new Date(this.now()).toISOString();
      await this.persistCheckpoint();
    });
  }
  private markGap(previous: number, current: number): void {
    if (this.evidence) this.evidence.continuity = "GAP_DETECTED";
    this.checkpoint.recoveryState = "GAP_DETECTED";
    this.checkpoint.recoveryMissingStartMs ??= previous + 60_000;
    this.checkpoint.recoveryMissingEndMs = Math.max(this.checkpoint.recoveryMissingEndMs ?? 0, current - 60_000);
  }
  private active(): boolean { return !this.stopped && (this.state === "READY" || this.state === "STARTING"); }
  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.operations.then(action).catch(async () => {
      this.persistenceError = true;
      await this.halt("MARKET_EVIDENCE_STORAGE_FAILED");
    });
    this.operations = next;
    return next;
  }
  private async consume(source: ObservableMarketSource): Promise<void> {
    try {
      for await (const bar of source.bars()) {
        if (!this.active()) break;
        await this.processClosedBar(bar);
      }
      if (this.active()) await this.enqueue(() => this.halt("MARKET_EVIDENCE_STREAM_ENDED"));
    } catch {
      if (this.active()) await this.enqueue(() => this.halt("MARKET_EVIDENCE_STREAM_FAILED"));
    }
  }
  private captureStream(): void {
    const stream = this.options.source?.snapshot?.() ?? null;
    if (this.evidence) this.evidence.stream = stream;
    this.checkpoint.marketStreamState = stream?.subscriptionAcknowledged ? "CONNECTED" : stream?.state === "RECONNECTING" ? "DEGRADED" : "DISCONNECTED";
    this.checkpoint.streamState = this.checkpoint.marketStreamState;
    this.checkpoint.marketEvidence = this.evidence ?? undefined;
  }
  private async syncStream(): Promise<void> {
    this.captureStream();
    const stream = this.evidence?.stream;
    if (stream?.state === "FAILED") return this.halt("MARKET_EVIDENCE_STREAM_FAILED");
    if (this.state === "STARTING" && (!this.options.source?.snapshot || stream?.subscriptionAcknowledged)) {
      if (this.runId) await this.options.store.updateRun(this.runId, "READY", null);
      this.state = "READY";
    }
  }
  private async heartbeat(): Promise<void> {
    if (!this.active()) return;
    const before = JSON.stringify(this.evidence?.stream);
    const renewalDue = this.now() - this.renewedAt >= MARKET_WORKER_RENEW_MS;
    if (renewalDue && this.lease) {
      const renewed = await this.options.store.renewOwnership(this.lease, MARKET_WORKER_LEASE_SECONDS);
      if (!renewed) return this.halt("DURABLE_RUNTIME_OWNERSHIP_LOST");
      this.lease = renewed;
      this.renewedAt = this.now();
    }
    await this.syncStream();
    if (!this.active()) return;
    if (this.state === "STARTING" && this.now() - this.startedAt >= MARKET_WORKER_STARTUP_TIMEOUT_MS) return this.halt("MARKET_SUBSCRIPTION_STARTUP_TIMEOUT");
    if (renewalDue || before !== JSON.stringify(this.evidence?.stream)) await this.persistCheckpoint();
  }
  private async persistCheckpoint(): Promise<void> {
    if (this.lease && !await this.options.store.writeCheckpointOwned(this.lease, this.checkpoint)) await this.halt("DURABLE_RUNTIME_OWNERSHIP_LOST");
  }
  private clearTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private async release(): Promise<void> {
    const lease = this.lease;
    this.lease = null;
    if (lease) await this.options.store.releaseOwnership(lease);
  }
  private async halt(reason: string): Promise<void> {
    this.clearTimer();
    this.state = "HALTED";
    this.checkpoint.haltReason = reason;
    this.options.source?.close?.();
    this.captureStream();
    // Attempt every cleanup independently; database failure remains visible in exit status/logs.
    const results = await Promise.allSettled([
      this.runId ? this.options.store.updateRun(this.runId, "HALTED", reason) : Promise.resolve(),
      this.lease ? this.options.store.writeCheckpointOwned(this.lease, this.checkpoint) : Promise.resolve(),
    ]);
    if (results.some((result) => result.status === "rejected")) this.persistenceError = true;
    try { await this.release(); } catch { this.persistenceError = true; }
  }
}
