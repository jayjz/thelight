import { randomUUID } from "node:crypto";
import type { MarketSource } from "./market.ts";
import type { ClosedBar } from "./types.ts";
import type { AlpacaWorkerStore, WorkerCheckpoint, WorkerLease, GapRecoveryAttempt, OwnedMarketWrite } from "./alpaca-worker-store.server.ts";
import { assertReadOnlyDurable, type ReadOnlyDurableCapability, type WorkerRuntimeIdentity } from "./runtime-identity.ts";

import { BTC_RECOVERY_WINDOW_MS, CryptoHistoricalError, sameClosedBar, verifyExactBars, type CryptoHistoricalBars, type HistoricalInterval } from "./alpaca-crypto-historical.server.ts";

export const MARKET_WORKER_LEASE_SECONDS = 30;
export const MARKET_WORKER_RENEW_MS = 10_000;
export const MARKET_WORKER_STARTUP_TIMEOUT_MS = 60_000;
const RECOVERY_WINDOW_MS = BTC_RECOVERY_WINDOW_MS;

export type DurableMarketStore = Pick<AlpacaWorkerStore,
  "durable" | "createRun" | "updateRun" | "acquireOwnership" | "renewOwnership" | "releaseOwnership" |
  "writeMarketEvidenceOwned" | "latestClosedBarTimestamp" | "listClosedBars" | "readCheckpoint"
>;

export type MarketStreamEvidence = {
  state: string;
  subscriptionAcknowledged: boolean;
  generation: number;
  reconnectAttempt: number;
  lastError: string | null;
};
export type BtcRecoveryEvidence = GapRecoveryAttempt & {
  /** Provider request bounds are inclusive; the shared attempt ledger uses an exclusive end. */
  requestedStartMs: number;
  requestedEndMs: number;
  requestedBarCount: number;
  acceptedBarCount: number;
  identicalBarCount: number;
  conflictingBarCount: number;
};
export type DurableMarketEvidence = {
  runId: string;
  stream: MarketStreamEvidence | null;
  recoveredClosedBarCount: number;
  recoveryWindowMs: number;
  continuity: "UNVERIFIED" | "GAP_DETECTED" | "VERIFIED";
  verifiedStartMs?: number | null;
  verifiedThroughMs?: number | null;
  recovery?: BtcRecoveryEvidence | null;
  backfilledBarCount?: number;
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
  historical?: CryptoHistoricalBars;
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
        verifiedStartMs: prior?.marketEvidence?.verifiedStartMs ?? null,
        verifiedThroughMs: prior?.marketEvidence?.verifiedThroughMs ?? null,
        recovery: prior?.marketEvidence?.recovery ?? null,
        backfilledBarCount: prior?.marketEvidence?.backfilledBarCount ?? 0,
      };
      // A prior conflict invalidates the trusted prefix until REST has checked it again.
      if (prior?.haltReason === "MARKET_BAR_CONFLICT" || prior?.marketEvidence?.recovery?.reason === "CONFLICT") {
        this.evidence.verifiedStartMs = null;
        this.evidence.verifiedThroughMs = null;
        this.evidence.continuity = "GAP_DETECTED";
      }
      // Recovery must inspect gaps too, including a bar committed before its
      // checkpoint write. Merely taking max(timestamp) would erase that warning.
      for (let index = 1; index < bars.length; index += 1) {
        const previous = bars[index - 1]!.t;
        const current = bars[index]!.t;
        if (current > previous + 60_000) this.markGap(previous, current);
      }
      if (this.options.historical) {
        const end = Math.floor(this.now() / 60_000) * 60_000 - 60_000;
        const floor = end - RECOVERY_WINDOW_MS + 60_000;
        const start = Math.max(floor, this.evidence.verifiedStartMs ?? bars[0]?.t ?? floor);
        // Durable bars, not a possibly stale checkpoint, define chronology.
        this.checkpoint.latestRawBarTimestamp = latest;
        if (!await this.recoverContinuity(start, end)) return;
      }
      this.startedAt = this.now(); // Subscription timeout starts after bounded historical recovery.
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
      if (previous !== null && bar.t > previous + 60_000 && this.evidence) {
        this.markGap(previous, bar.t);
        await this.persistCheckpoint();
        if (!this.active()) return;
        if (this.options.historical && !await this.recoverContinuity(previous + 60_000, bar.t - 60_000)) return;
      }
      // A crash/takeover after a conflicting insert must not leave a trusted prefix.
      // Commit this degraded checkpoint in the same fenced transaction as the result.
      this.captureStream();
      const checkpointOnConflict = structuredClone(this.checkpoint);
      checkpointOnConflict.haltReason = "MARKET_BAR_CONFLICT";
      checkpointOnConflict.recoveryState = "GAP_DETECTED";
      if (checkpointOnConflict.marketEvidence) {
        checkpointOnConflict.marketEvidence.continuity = "GAP_DETECTED";
        checkpointOnConflict.marketEvidence.verifiedStartMs = null;
        checkpointOnConflict.marketEvidence.verifiedThroughMs = null;
      }
      const results = await this.ownedWrite({ checkpointOnConflict, observations: [{ symbol: this.options.identity.asset.symbol, bar,
        providerEventTimestampMs: bar.t, observedAt: new Date(this.now()).toISOString(), origin: "LIVE_WS", recoveryAttemptId: null }] });
      if (!results) return;
      if (results[0] === "CONFLICT") {
        this.checkpoint = checkpointOnConflict;
        this.evidence = checkpointOnConflict.marketEvidence ?? this.evidence;
        return this.halt("MARKET_BAR_CONFLICT");
      }
      if (this.evidence?.continuity === "VERIFIED" && bar.t === (this.evidence.verifiedThroughMs ?? 0) + 60_000) this.evidence.verifiedThroughMs = bar.t;
      this.checkpoint.latestRawBarTimestamp = Math.max(previous ?? 0, bar.t);
      if (this.evidence && (previous === null || bar.t > previous)) this.evidence.lastBarPersistedAt = new Date(this.now()).toISOString();
      await this.persistCheckpoint();
    });
  }
  /** Verifies only this bounded scope; older history is never implicitly certified. */
  private async recoverContinuity(startMs: number, endMs: number): Promise<boolean> {
    const evidence = this.evidence!;
    const historical = this.options.historical!;
    const symbol = this.options.identity.asset.symbol;
    if (symbol !== "BTC/USD" || startMs > endMs || endMs - startMs + 60_000 > RECOVERY_WINDOW_MS) {
      evidence.continuity = "GAP_DETECTED";
      await this.halt("HISTORICAL_RECOVERY_HORIZON_EXCEEDED");
      return false;
    }
    const interval: HistoricalInterval = { symbol, startMs, endMs };
    const durable = await this.options.store.listClosedBars(symbol, startMs, endMs);
    const present = new Set(durable.map(b => b.t));
    const ranges: HistoricalInterval[] = [];
    for (let t = startMs; t <= endMs; t += 60_000) {
      if (present.has(t) && evidence.verifiedStartMs != null && evidence.verifiedThroughMs != null && t >= evidence.verifiedStartMs && t <= evidence.verifiedThroughMs) continue;
      const last = ranges.at(-1);
      if (last && last.endMs + 60_000 === t) last.endMs = t;
      else ranges.push({ symbol, startMs: t, endMs: t });
    }
    evidence.continuity = "GAP_DETECTED";
    for (const range of ranges) {
      if (!await this.renewForRecovery()) return false;
      const attempt: BtcRecoveryEvidence = {
        recoveryAttemptId: randomUUID(), workerKey: this.options.identity.workerKey, symbol,
        missingStartMs: range.startMs, missingEndMs: range.endMs + 60_000, requestedStartMs: range.startMs, requestedEndMs: range.endMs, state: "BACKFILLING",
        detectedAt: new Date(this.now()).toISOString(), requestedAt: new Date(this.now()).toISOString(),
        requestedBarCount: (range.endMs - range.startMs) / 60_000 + 1,
        returnedBarCount: 0, verifiedBarCount: 0, acceptedBarCount: 0, identicalBarCount: 0, conflictingBarCount: 0,
      };
      evidence.recovery = attempt;
      this.checkpoint.recoveryState = "BACKFILLING";
      this.checkpoint.recoveryAttemptId = attempt.recoveryAttemptId;
      this.checkpoint.recoveryMissingStartMs = range.startMs;
      this.checkpoint.recoveryMissingEndMs = range.endMs + 60_000;
      this.checkpoint.recoveryCompletedAt = null;
      this.captureStream();
      if (!await this.ownedWrite({ attempt: { value: attempt, create: true }, checkpoint: this.checkpoint })) return false;
      try {
        const bars = await historical.fetchCompletedBars(range);
        attempt.returnedBarCount = bars.length;
        verifyExactBars(bars, range);
        // GET completion confers no write authority. Revalidate after all network waits.
        if (!await this.renewForRecovery()) return false;
        attempt.state = "VERIFYING";
        this.checkpoint.recoveryState = "VERIFYING";
        // Keep transactions below the lease horizon even on a remote database.
        // A crash between chunks leaves explicit uncertainty; restart re-verifies.
        for (let offset = 0; offset < bars.length; offset += 32) {
          if (!await this.renewForRecovery()) return false;
          const results = await this.ownedWrite({
            observations: bars.slice(offset, offset + 32).map(bar => ({ symbol, bar, providerEventTimestampMs: bar.t, observedAt: new Date(this.now()).toISOString(), origin: "REST_BACKFILL", recoveryAttemptId: attempt.recoveryAttemptId })),
            attempt: { value: attempt, create: false }, checkpoint: this.checkpoint,
          });
          if (!results) return false;
          const accepted = results.filter(r => r === "ACCEPTED").length;
          attempt.acceptedBarCount += accepted;
          attempt.identicalBarCount += results.filter(r => r === "IDENTICAL").length;
          attempt.conflictingBarCount += results.filter(r => r === "CONFLICT").length;
          evidence.backfilledBarCount = (evidence.backfilledBarCount ?? 0) + accepted;
          if (attempt.conflictingBarCount) throw new CryptoHistoricalError("CONFLICT");
        }
        const stored = await this.options.store.listClosedBars(symbol, range.startMs, range.endMs);
        verifyExactBars(stored, range);
        if (stored.some((bar, index) => !sameClosedBar(bar, bars[index]!))) throw new CryptoHistoricalError("CONFLICT");
        attempt.verifiedBarCount = stored.length;
        attempt.verifiedAt = new Date(this.now()).toISOString();
        attempt.completedAt = attempt.verifiedAt;
        attempt.state = "HEALTHY"; attempt.result = "VERIFIED"; attempt.reason = null;
        if (!await this.ownedWrite({ attempt: { value: attempt, create: false }, checkpoint: this.checkpoint })) return false;
      } catch (error) {
        // Storage errors propagate to the worker's storage-failure path.
        if (!(error instanceof CryptoHistoricalError)) throw error;
        attempt.returnedBarCount = Math.max(attempt.returnedBarCount ?? 0, error.fetchedBarCount);
        attempt.state = "GAP_DETECTED"; attempt.result = "FAILED"; attempt.reason = error.code;
        attempt.completedAt = new Date(this.now()).toISOString();
        this.checkpoint.recoveryState = "GAP_DETECTED";
        if (!await this.ownedWrite({ attempt: { value: attempt, create: false }, checkpoint: this.checkpoint })) return false;
        await this.halt(`HISTORICAL_RECOVERY_${error.code}`);
        return false;
      }
    }
    try { verifyExactBars(await this.options.store.listClosedBars(symbol, startMs, endMs), interval); }
    catch {
      await this.halt("HISTORICAL_DURABLE_CONTINUITY_FAILED");
      return false;
    }
    if (!await this.renewForRecovery()) return false;
    evidence.continuity = "VERIFIED";
    // Keep a contiguous prior prefix on live repair; startup clips to the horizon.
    evidence.verifiedStartMs = this.state === "STARTING" ? startMs : Math.min(evidence.verifiedStartMs ?? startMs, startMs);
    evidence.verifiedThroughMs = endMs;
    this.checkpoint.latestRawBarTimestamp = Math.max(this.checkpoint.latestRawBarTimestamp ?? 0, endMs);
    this.checkpoint.recoveryState = "HEALTHY";
    this.checkpoint.recoveryCompletedAt = new Date(this.now()).toISOString();
    this.captureStream();
    if (!await this.ownedWrite({ checkpoint: this.checkpoint })) { evidence.continuity = "GAP_DETECTED"; return false; }
    return true;
  }
  private async renewForRecovery(): Promise<boolean> {
    if (!this.active() || !this.lease) return false;
    const renewed = await this.options.store.renewOwnership(this.lease, MARKET_WORKER_LEASE_SECONDS);
    if (!renewed) { await this.halt("DURABLE_RUNTIME_OWNERSHIP_LOST"); return false; }
    this.lease = renewed; this.renewedAt = this.now();
    return true;
  }
  private async ownedWrite(write: OwnedMarketWrite) {
    if (!this.lease) return null;
    const result = await this.options.store.writeMarketEvidenceOwned(this.lease, write);
    if (!result) await this.halt("DURABLE_RUNTIME_OWNERSHIP_LOST");
    return result;
  }
  private markGap(previous: number, current: number): void {
    if (this.evidence?.continuity !== "GAP_DETECTED") {
      this.checkpoint.recoveryMissingStartMs = null;
      this.checkpoint.recoveryMissingEndMs = null;
    }
    if (this.evidence) this.evidence.continuity = "GAP_DETECTED";
    this.checkpoint.recoveryState = "GAP_DETECTED";
    this.checkpoint.recoveryMissingStartMs ??= previous + 60_000;
    this.checkpoint.recoveryMissingEndMs = Math.max(this.checkpoint.recoveryMissingEndMs ?? 0, current);
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
    if (this.lease && !await this.options.store.writeMarketEvidenceOwned(this.lease, { checkpoint: this.checkpoint })) await this.halt("DURABLE_RUNTIME_OWNERSHIP_LOST");
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
      this.lease ? this.options.store.writeMarketEvidenceOwned(this.lease, { checkpoint: this.checkpoint }) : Promise.resolve(),
    ]);
    if (results.some((result) => result.status === "rejected")) this.persistenceError = true;
    try { await this.release(); } catch { this.persistenceError = true; }
  }
}
