import { randomUUID } from "node:crypto";
import type { MarketSource } from "./market.ts";
import type { ClosedBar } from "./types.ts";
import type { AlpacaWorkerStore, WorkerCheckpoint, WorkerLease } from "./alpaca-worker-store.server.ts";
import type { ReadOnlyDurableCapability, WorkerRuntimeIdentity } from "./runtime-identity.ts";

const LEASE_SECONDS = 30;
const LEASE_RENEW_INTERVAL_MS = 10_000;

type DurableMarketStore = Pick<
  AlpacaWorkerStore,
  "durable" | "createRun" | "updateRun" | "acquireOwnership" | "renewOwnership" | "releaseOwnership" |
  "insertClosedBar" | "listClosedBars" | "readCheckpoint" | "writeCheckpointOwned"
>;

export type DurableMarketWorkerSnapshot = {
  workerKey: string;
  symbol: string;
  assetClass: string;
  decisionTimeframe: "15Min" | "1Min";
  runtimeCapability: ReadOnlyDurableCapability["kind"];
  state: "STOPPED" | "STARTING" | "READY" | "HALTED";
  latestRawBarTimestamp: number | null;
  latestClosedDecisionBarTimestamp: number | null;
  recoveredClosedBarCount: number;
  haltReason: string | null;
};

export type DurableMarketWorkerOptions = {
  identity: WorkerRuntimeIdentity & { capability: ReadOnlyDurableCapability };
  store: DurableMarketStore;
  source?: MarketSource;
};

function emptyCheckpoint(): WorkerCheckpoint {
  return {
    latestRawBarTimestamp: null,
    latestClosedDecisionBarTimestamp: null,
    latestDecisionId: null,
    lastReconciliationTimestamp: null,
    streamState: "DISCONNECTED",
    marketStreamState: "DISCONNECTED",
    tradeUpdateStreamState: "DISCONNECTED",
    featureContinuity: "REBUILDING",
    recoveryState: "HEALTHY",
    recoveryAttemptId: null,
    recoveryMissingStartMs: null,
    recoveryMissingEndMs: null,
    recoveryCompletedAt: null,
    recoveryDispatchNotBeforeBucketMs: null,
    paperEquityHighWater: null,
    lastPaperEquity: null,
    priorRiskApprovedTarget: null,
    haltReason: null,
  };
}

/**
 * Broker-free durable runtime for assets that may own market/evidence state but
 * have not received execution or broker-reconciliation authority. Its narrow
 * store type deliberately omits every dispatch and broker-observation method.
 */
export class DurableMarketWorker {
  private readonly options: DurableMarketWorkerOptions;
  private state: DurableMarketWorkerSnapshot["state"] = "STOPPED";
  private checkpoint = emptyCheckpoint();
  private lease: WorkerLease | null = null;
  private ownershipTimer: ReturnType<typeof setInterval> | null = null;
  private runId: string | null = null;
  private recoveredClosedBarCount = 0;
  private stopped = false;

  constructor(options: DurableMarketWorkerOptions) {
    this.options = options;
  }

  snapshot(): DurableMarketWorkerSnapshot {
    return {
      workerKey: this.options.identity.workerKey,
      symbol: this.options.identity.asset.symbol,
      assetClass: this.options.identity.asset.assetClass,
      decisionTimeframe: this.options.identity.decisionTimeframe,
      runtimeCapability: this.options.identity.capability.kind,
      state: this.state,
      latestRawBarTimestamp: this.checkpoint.latestRawBarTimestamp,
      latestClosedDecisionBarTimestamp: this.checkpoint.latestClosedDecisionBarTimestamp,
      recoveredClosedBarCount: this.recoveredClosedBarCount,
      haltReason: this.checkpoint.haltReason,
    };
  }

  async start(): Promise<void> {
    if (this.state === "READY" || this.state === "STARTING") return;
    this.state = "STARTING";
    this.stopped = false;
    if (!this.options.store.durable) return this.halt("DURABLE_STORAGE_REQUIRED");
    this.runId = randomUUID();
    await this.options.store.createRun(this.runId, this.options.identity.workerKey, this.state);
    const lease = await this.options.store.acquireOwnership(this.options.identity.workerKey, this.runId, LEASE_SECONDS);
    if (!lease) return this.halt("DURABLE_RUNTIME_OWNERSHIP_UNAVAILABLE");
    this.lease = lease;
    this.startOwnershipRenewal();
    const checkpoint = await this.options.store.readCheckpoint(this.options.identity.workerKey);
    this.checkpoint = { ...emptyCheckpoint(), ...checkpoint, haltReason: null };
    this.recoveredClosedBarCount = (await this.options.store.listClosedBars(this.options.identity.asset.symbol)).length;
    this.state = "READY";
    await this.persistCheckpoint();
    if (this.options.source) void this.consume(this.options.source);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopOwnershipRenewal();
    this.state = "STOPPED";
    if (this.lease) await this.persistCheckpoint();
    if (this.runId) await this.options.store.updateRun(this.runId, "STOPPED", null);
    if (this.lease) await this.options.store.releaseOwnership(this.lease);
    this.lease = null;
  }

  async processClosedBar(bar: ClosedBar): Promise<void> {
    if (this.state !== "READY" || !Number.isFinite(bar.t) || bar.t % 60_000 !== 0) return;
    if (!await this.options.store.insertClosedBar(this.options.identity.asset.symbol, bar)) return;
    this.checkpoint.latestRawBarTimestamp = Math.max(this.checkpoint.latestRawBarTimestamp ?? 0, bar.t);
    await this.persistCheckpoint();
  }

  private async consume(source: MarketSource): Promise<void> {
    try {
      for await (const bar of source.bars()) {
        if (this.stopped || this.state !== "READY") return;
        await this.processClosedBar(bar);
      }
    } catch {
      await this.halt("MARKET_EVIDENCE_STREAM_FAILED");
    }
  }

  private async persistCheckpoint(): Promise<void> {
    const lease = this.lease;
    if (!lease) return;
    const written = await this.options.store.writeCheckpointOwned(lease, this.checkpoint);
    if (!written) await this.halt("DURABLE_RUNTIME_OWNERSHIP_LOST");
  }

  private startOwnershipRenewal(): void {
    this.stopOwnershipRenewal();
    this.ownershipTimer = setInterval(() => { void this.renewOwnership(); }, LEASE_RENEW_INTERVAL_MS);
    this.ownershipTimer.unref?.();
  }

  private stopOwnershipRenewal(): void {
    if (this.ownershipTimer) clearInterval(this.ownershipTimer);
    this.ownershipTimer = null;
  }

  private async renewOwnership(): Promise<void> {
    if (this.stopped || this.state !== "READY" || !this.lease) return;
    try {
      const renewed = await this.options.store.renewOwnership(this.lease, LEASE_SECONDS);
      if (!renewed) await this.halt("DURABLE_RUNTIME_OWNERSHIP_LOST");
      else this.lease = renewed;
    } catch {
      await this.halt("DURABLE_RUNTIME_OWNERSHIP_RENEWAL_FAILED");
    }
  }

  private async halt(reason: string): Promise<void> {
    this.stopOwnershipRenewal();
    this.state = "HALTED";
    this.checkpoint.haltReason = reason;
    if (this.runId) await this.options.store.updateRun(this.runId, "HALTED", reason);
  }
}
