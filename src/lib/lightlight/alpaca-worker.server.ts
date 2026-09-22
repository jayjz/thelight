import { createHash, randomUUID } from "node:crypto";
import {
  AlpacaMarketSource,
  AlpacaHistoricalStockBars,
  AlpacaPaperBroker,
  AlpacaPaperTradeUpdates,
  AlpacaTransportError,
  brokerStateFromTradeUpdate,
  loadAlpacaConfig,
  loadLocalMarketDataUrl,
  type AlpacaConfig,
  type HistoricalStockBars,
  type BrokerAccountSnapshot,
  type BrokerOrderState,
  type BrokerPositionSnapshot,
  type OpenBrokerOrder,
  type SubmissionRecovery,
} from "./alpaca.server.ts";
import { MemoryAlpacaWorkerStore, SqlAlpacaWorkerStore, type AlpacaWorkerStore, type GapRecoveryAttempt, type WorkerCheckpoint, type WorkerLease } from "./alpaca-worker-store.server.ts";
import { computeFeatures } from "./features.ts";
import { EMA_RSI_V1_ID, emaRsiV1Strategy, type TargetPosition, type TradingStrategy } from "./ema-rsi-v1.ts";
import { buildJevRequest, createMockJevAdapter } from "./jev.ts";
import type { MarketSource } from "./market.ts";
import { SPY_SPEC, boundedEquityAsset, isMarketSessionOpen, type AssetSpec } from "./assets.ts";
import {
  ALPACA_PAPER_DECISION_TIMEFRAME,
  ALPACA_PAPER_WORKER_VERSION,
  SPY_RUNTIME_IDENTITY,
  assertDispatchCapable,
  workerRuntimeIdentityFor,
  type PaperWorkerArm,
  type DispatchCapableCapability,
  type WorkerRuntimeIdentity,
} from "./runtime-identity.ts";
import { actionToPosition, classifyDeterministicRegime, evaluateAssetAwarePolicy, evaluateRisk, evaluateSignal } from "./policy.ts";
import { STRATEGY_VERSION } from "./thresholds.ts";
import type { ClosedBar, Evidence, ExecutionIntent, ExecutionStatus } from "./types.ts";

export const ALPACA_WORKER_ASSET = SPY_SPEC;
/** @deprecated Use ALPACA_WORKER_ASSET.symbol for new callers. */
export const ALPACA_WORKER_SYMBOL = ALPACA_WORKER_ASSET.symbol;
export const ALPACA_WORKER_TIMEFRAME = ALPACA_PAPER_DECISION_TIMEFRAME;
export const ALPACA_WORKER_CONFIG_VERSION = ALPACA_PAPER_WORKER_VERSION;
const OWNERSHIP_LEASE_SECONDS = 30;
const OWNERSHIP_RENEW_INTERVAL_MS = 10_000;
const DECISION_WIDTH_MS = 15 * 60_000;
// computeFeatures currently gates readiness at index 20, so retain 21 complete
// decision observations instead of changing the existing feature contract.
const FEATURE_DECISION_OBSERVATIONS = 21;
const EMA_RSI_V1_MAX_LIVE_BAR_AGE_MS = 2 * 60_000;

export type WorkerState = "STOPPED" | "STARTING" | "RECONCILING" | "READY" | "HALTED";
export type WorkerStreamState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "RECONCILING";
export type FeatureContinuity = "HEALTHY" | "REBUILDING";
export type RecoveryState = "HEALTHY" | "GAP_DETECTED" | "BACKFILLING" | "VERIFYING" | "REBUILDING";

export type DispatchSafetyInput = {
  dispatchCapable: boolean;
  inSession: boolean;
  warmupComplete: boolean;
  featureContinuity: FeatureContinuity;
  recoveryState: RecoveryState;
  latestLiveBarStale: boolean;
  reconciliationComplete: boolean;
  hasOwnership: boolean;
};

/**
 * Broker-dispatch safety is a runtime-capability invariant, not a strategy
 * variant. Read-only durable runtimes intentionally stop at their capability
 * reason so they can continue to persist research evidence without broker
 * reconciliation or ownership.
 */
export function dispatchBlockReasonFor(input: DispatchSafetyInput): string | null {
  if (!input.dispatchCapable) return "READ_ONLY_RUNTIME";
  if (!input.inSession) return "OUTSIDE_REGULAR_SESSION";
  if (input.recoveryState !== "HEALTHY") return `MARKET_RECOVERY_${input.recoveryState}`;
  if (!input.warmupComplete || input.featureContinuity !== "HEALTHY") return "FEATURE_CONTINUITY_REBUILDING";
  if (input.latestLiveBarStale) return "LATEST_LIVE_BAR_STALE";
  if (!input.reconciliationComplete) return "BROKER_RECONCILIATION_INCOMPLETE";
  if (!input.hasOwnership) return "DISPATCH_OWNERSHIP_REQUIRED";
  return null;
}

export type AlpacaWorkerSnapshot = {
  mode: "ALPACA_PAPER";
  workerState: WorkerState;
  symbol: string;
  workerKey: string;
  runtimeCapability: "DISPATCH_CAPABLE" | "READ_ONLY_DURABLE";
  feed: string;
  decisionTimeframe: "15Min" | "1Min";
  latestRawBarTimestamp: number | null;
  latestClosedDecisionBarTimestamp: number | null;
  latestDecisionId: string | null;
  strategy: "ema_trend" | typeof EMA_RSI_V1_ID;
  experimentArm: "C" | "ema_rsi_v1";
  riskState: string | null;
  brokerPosition: number | null;
  openOrderSummary: { count: number; clientOrderIds: string[] };
  latestBrokerOrderState: ExecutionStatus | null;
  lastTradeUpdateTimestamp: string | null;
  lastReconciliationTimestamp: string | null;
  /** Legacy market-stream summary retained for read-only runtime consumers. */
  streamState: WorkerStreamState;
  marketStreamState: WorkerStreamState;
  tradeUpdateStreamState: WorkerStreamState;
  featureContinuity: FeatureContinuity;
  recoveryState: RecoveryState;
  recoveryAttemptId: string | null;
  recoveryMissingStartMs: number | null;
  recoveryMissingEndMs: number | null;
  paperEquity: number | null;
  paperEquityHighWater: number | null;
  paperEquityDrawdown: number | null;
  haltReason: string | null;
  missingDecisionBuckets: number;
};

export interface WorkerBroker {
  account(): Promise<BrokerAccountSnapshot>;
  position(): Promise<BrokerPositionSnapshot>;
  openOrders(): Promise<OpenBrokerOrder[]>;
  reconcile(intent: ExecutionIntent): Promise<BrokerOrderState>;
  submit(intent: ExecutionIntent, position: BrokerPositionSnapshot, recovery?: SubmissionRecovery): Promise<BrokerOrderState>;
}

export interface WorkerTradeUpdates {
  /** Called only after Alpaca has acknowledged the trade_updates subscription. */
  connect(
    onUpdate: (update: Record<string, unknown>) => void,
    onError: (error: Error) => void,
    onReady: () => void,
  ): () => void;
}

export type AlpacaPaperWorkerOptions = {
  config: AlpacaConfig;
  store: AlpacaWorkerStore;
  broker?: WorkerBroker;
  source?: MarketSource;
  tradeUpdates?: WorkerTradeUpdates;
  historicalBars?: HistoricalStockBars;
  /** Makes exchange-session semantics injectable and deterministic in tests. */
  isRegularSession?: (timestamp: number) => boolean;
  now?: () => Date;
  /** Injectable bounded backoff for deterministic reconnect tests. */
  reconnectDelayMs?: (attempt: number) => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Defaults to the unchanged 15-minute Arm C worker. */
  arm?: PaperWorkerArm;
  asset?: AssetSpec;
};

const emptyCheckpoint = (): WorkerCheckpoint => ({
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
});

/** @deprecated Use isMarketSessionOpen(SPY_SPEC, timestamp) for new callers. */
export function isRegularUsEquitySession(timestamp: number): boolean {
  return isMarketSessionOpen(ALPACA_WORKER_ASSET, timestamp);
}

export function alpacaPaperWorkerKey(asset: AssetSpec = ALPACA_WORKER_ASSET): string {
  return workerRuntimeIdentityFor(asset).workerKey;
}

export function deterministicDecisionId(timestamp: number, runtime: WorkerRuntimeIdentity = SPY_RUNTIME_IDENTITY): string {
  const strategy = runtime.decisionTimeframe === "1Min" ? EMA_RSI_V1_ID : "ema_trend";
  const arm = runtime.decisionTimeframe === "1Min" ? EMA_RSI_V1_ID : "C";
  const identity = [runtime.asset.symbol, runtime.decisionTimeframe, timestamp, strategy, arm, runtime.workerVersion].join("|");
  return `LLP-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

export function deterministicClientOrderId(decisionId: string): string {
  return `llp-${createHash("sha256").update(`${decisionId}|intent|v1`).digest("hex").slice(0, 32)}`;
}

function terminal(status: ExecutionStatus): boolean {
  return status === "FILLED" || status === "REJECTED" || status === "CANCELLED";
}

function newYorkDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}

/**
 * Single process owner for the durable Alpaca PAPER pipeline. No browser code
 * is imported here; calling start twice is idempotent and never creates a
 * second market consumer or submission authority.
 */
export class AlpacaPaperWorker {
  private readonly options: AlpacaPaperWorkerOptions;
  private readonly arm: PaperWorkerArm;
  private readonly targetStrategy: TradingStrategy | null;
  private readonly runtimeIdentity: WorkerRuntimeIdentity;
  private readonly asset: AssetSpec;
  private state: WorkerState = "STOPPED";
  private readonly key: string;
  private checkpoint = emptyCheckpoint();
  private marketStreamState: WorkerStreamState = "DISCONNECTED";
  private tradeUpdateStreamState: WorkerStreamState = "DISCONNECTED";
  private brokerPosition: BrokerPositionSnapshot | null = null;
  private openOrders: OpenBrokerOrder[] = [];
  private latestBrokerOrderState: ExecutionStatus | null = null;
  private lastTradeUpdateTimestamp: string | null = null;
  private riskState: string | null = null;
  private missingDecisionBuckets = 0;
  private runId: string | null = null;
  private ownership: WorkerLease | null = null;
  private ownershipTimer: ReturnType<typeof setInterval> | null = null;
  private ownershipGeneration = 0;
  private disconnectTradeUpdates: (() => void) | null = null;
  private consuming = false;
  private marketReconnectScheduled = false;
  private marketReconnectAttempt = 0;
  private tradeReconnectScheduled = false;
  private tradeReconnectAttempt = 0;
  private tradeRecoveryInFlight = false;
  private reconnectGeneration = 0;
  private requiresPaperEquityHighWaterRecovery = false;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: AlpacaPaperWorkerOptions) {
    this.options = options;
    this.arm = options.arm ?? "ema_trend_arm_c";
    this.targetStrategy = this.arm === "ema_rsi_v1" ? emaRsiV1Strategy : null;
    if (options.config.paperBaseUrl !== "https://paper-api.alpaca.markets") throw new Error("LIVE_TRADING_FORBIDDEN");
    this.asset = options.asset ?? boundedEquityAsset(options.config.symbol);
    if (options.config.symbol !== this.asset.symbol) throw new Error("ALPACA_WORKER_ASSET_CONFIG_MISMATCH");
    const runtimeIdentity = workerRuntimeIdentityFor(this.asset, this.arm);
    if (runtimeIdentity.capability.kind === "DISPATCH_CAPABLE" && !options.broker) throw new Error("DISPATCH_RUNTIME_BROKER_REQUIRED");
    this.runtimeIdentity = runtimeIdentity;
    this.key = this.runtimeIdentity.workerKey;
  }

  private get decisionWidthMs(): number {
    return this.targetStrategy?.timeframe === "1Min" ? 60_000 : DECISION_WIDTH_MS;
  }

  private get featureDecisionObservations(): number {
    return this.targetStrategy?.warmupBars ?? FEATURE_DECISION_OBSERVATIONS;
  }

  private get isEmaRsiV1(): boolean {
    return this.arm === "ema_rsi_v1";
  }
  private get dispatchCapable(): boolean { return this.runtimeIdentity.capability.kind === "DISPATCH_CAPABLE"; }
  private broker(): WorkerBroker {
    if (!this.dispatchCapable || !this.options.broker) throw new Error("RUNTIME_DISPATCH_CAPABILITY_REQUIRED");
    return this.options.broker;
  }

  snapshot(): AlpacaWorkerSnapshot {
    return {
      mode: "ALPACA_PAPER", workerState: this.state, symbol: this.options.config.symbol, workerKey: this.key, runtimeCapability: this.runtimeIdentity.capability.kind, feed: this.options.config.dataFeed,
      decisionTimeframe: this.runtimeIdentity.decisionTimeframe, latestRawBarTimestamp: this.checkpoint.latestRawBarTimestamp,
      latestClosedDecisionBarTimestamp: this.checkpoint.latestClosedDecisionBarTimestamp, latestDecisionId: this.checkpoint.latestDecisionId,
      strategy: this.isEmaRsiV1 ? EMA_RSI_V1_ID : "ema_trend", experimentArm: this.isEmaRsiV1 ? "ema_rsi_v1" : "C", riskState: this.riskState,
      brokerPosition: this.brokerPosition?.quantity ?? null,
      openOrderSummary: { count: this.openOrders.length, clientOrderIds: this.openOrders.map((order) => order.clientOrderId) },
      latestBrokerOrderState: this.latestBrokerOrderState, lastTradeUpdateTimestamp: this.lastTradeUpdateTimestamp,
      lastReconciliationTimestamp: this.checkpoint.lastReconciliationTimestamp, streamState: this.marketStreamState,
      marketStreamState: this.marketStreamState, tradeUpdateStreamState: this.tradeUpdateStreamState,
      featureContinuity: this.checkpoint.featureContinuity,
      recoveryState: this.checkpoint.recoveryState,
      recoveryAttemptId: this.checkpoint.recoveryAttemptId,
      recoveryMissingStartMs: this.checkpoint.recoveryMissingStartMs,
      recoveryMissingEndMs: this.checkpoint.recoveryMissingEndMs,
      paperEquity: this.checkpoint.lastPaperEquity, paperEquityHighWater: this.checkpoint.paperEquityHighWater,
      paperEquityDrawdown: this.paperEquityDrawdown(),
      haltReason: this.checkpoint.haltReason, missingDecisionBuckets: this.missingDecisionBuckets,
    };
  }

  async start(): Promise<void> {
    if (this.state === "READY" || this.state === "RECONCILING" || this.state === "STARTING") return;
    this.stopped = false;
    this.state = "STARTING";
    this.runId = randomUUID();
    // Never even initialize the preview PGlite fallback: it is in-memory and
    // cannot make a restarted submission safe.
    if (!this.options.store.durable) {
      this.state = "HALTED";
      this.marketStreamState = "DEGRADED";
      this.tradeUpdateStreamState = "DEGRADED";
      this.checkpoint.haltReason = "DURABLE_STORAGE_REQUIRED";
      return;
    }
    await this.options.store.createRun(this.runId, this.key, this.state);
    if (this.stopped) return;
    const ownership = await this.options.store.acquireOwnership(this.key, this.runId, OWNERSHIP_LEASE_SECONDS);
    if (!ownership) {
      // A live process already owns the durable lease. Do not write the shared
      // checkpoint or initialize streams from this losing process.
      this.state = "HALTED";
      this.marketStreamState = "DEGRADED";
      this.tradeUpdateStreamState = "DEGRADED";
      this.checkpoint.haltReason = "DISPATCH_OWNERSHIP_UNAVAILABLE";
      await this.options.store.updateRun(this.runId, this.state, this.checkpoint.haltReason);
      return;
    }
    this.ownership = ownership;
    if (this.stopped) {
      await this.releaseOwnership();
      return;
    }
    this.ownershipGeneration += 1;
    this.startOwnershipRenewal();
    const storedCheckpoint = await this.options.store.readCheckpoint(this.key);
    this.requiresPaperEquityHighWaterRecovery = storedCheckpoint !== null &&
      (typeof storedCheckpoint.paperEquityHighWater !== "number" || !Number.isFinite(storedCheckpoint.paperEquityHighWater));
    this.checkpoint = this.normalizeCheckpoint(storedCheckpoint ?? emptyCheckpoint());
      this.marketStreamState = this.checkpoint.marketStreamState;
      this.tradeUpdateStreamState = this.checkpoint.tradeUpdateStreamState;
    if (this.stopped) {
      await this.releaseOwnership();
      return;
    }
    try {
      if (this.dispatchCapable) await this.reconcileInternal();
      if (this.stopped) return;
      // A process may inherit durable raw bars that were recorded before it
      // started. Repair only the bounded feature horizon before this run can
      // create any new dispatch-eligible work.
      await this.recoverStartupFeatureGaps();
      if (this.stopped) return;
      if (!await this.confirmCurrentOwnership()) return;
      this.state = "READY";
      await this.persistCheckpoint();
      await this.options.store.updateRun(this.runId, this.state, null);
      if (!await this.confirmCurrentOwnership()) return;
      if (this.dispatchCapable) this.connectTradeUpdates();
      this.startMarketConsumer();
    } catch (error) {
      if (this.stopped) return;
      await this.halt(error instanceof Error ? error.message : "STARTUP_RECONCILIATION_FAILED");
    }
  }

  async stop(): Promise<void> {
    const owned = this.ownership !== null;
    const wasHalted = this.state === "HALTED";
    this.stopped = true;
    this.stopOwnershipRenewal();
    this.reconnectGeneration += 1;
    this.marketReconnectScheduled = false;
    this.tradeReconnectScheduled = false;
    this.disconnectTradeUpdates?.();
    this.disconnectTradeUpdates = null;
    this.marketStreamState = "DISCONNECTED";
    this.tradeUpdateStreamState = "DISCONNECTED";
    if (!wasHalted) this.state = "STOPPED";
    try {
      let mayPersistCheckpoint = true;
      if (this.runId && !wasHalted) {
        try {
          await this.options.store.updateRun(this.runId, this.state, null);
        } catch (error) {
          if (!this.isLifecycleUpdateRejected(error)) throw error;
          mayPersistCheckpoint = false;
        }
      }
      if (owned && mayPersistCheckpoint) await this.persistCheckpoint();
    } finally {
      await this.releaseOwnership();
    }
  }

  /** Server/CLI operator control. It never authorizes unknown resubmission. */
  async reconcile(): Promise<void> {
    if (this.state === "HALTED" || this.stopped) return;
    try {
      if (!this.dispatchCapable) return;
      await this.reconcileInternal();
      if (this.stopped) return;
      this.state = "READY";
      await this.persistCheckpoint();
      await this.options.store.updateRun(this.runId!, this.state, null);
    } catch (error) {
      if (this.stopped) return;
      await this.halt(error instanceof Error ? error.message : "RECONCILIATION_FAILED");
    }
  }

  /** Serializes raw stream delivery so duplicate sockets cannot race a decision. */
  processRawBar(bar: ClosedBar): Promise<void> {
    this.queue = this.queue.then(() => this.processRawBarInternal(bar)).catch(async (error) => {
      await this.halt(error instanceof Error ? error.message : "RAW_BAR_PROCESSING_FAILED");
    });
    return this.queue;
  }

  private async processRawBarInternal(bar: ClosedBar): Promise<void> {
    if (this.state !== "READY") return;
    if (!Number.isFinite(bar.t) || bar.t % 60_000 !== 0) return;
    const observedAt = (this.options.now ?? (() => new Date()))().toISOString();
    const priorLatest = this.checkpoint.latestRawBarTimestamp;
    const write = await this.options.store.recordMarketBar({
      symbol: this.options.config.symbol, bar, providerEventTimestampMs: bar.t, observedAt, origin: "LIVE_WS", recoveryAttemptId: null,
    });
    if (write === "CONFLICT") {
      await this.enterRebuilding("LIVE_BAR_CONFLICT");
      return;
    }
    if (write === "IDENTICAL") return;
    this.checkpoint.latestRawBarTimestamp = Math.max(this.checkpoint.latestRawBarTimestamp ?? 0, bar.t);
    await this.persistCheckpoint();
    const gap = this.expectedLiveGap(priorLatest, bar.t);
    if (gap) {
      await this.recoverGap(gap.start, gap.end, observedAt);
      return;
    }
    await this.processCompletedDecisionBars(Math.floor(bar.t / this.decisionWidthMs) * this.decisionWidthMs);
  }

  private async processCompletedDecisionBars(eligibleBucketStart?: number, evaluateOnly = false): Promise<void> {
    const rawStart = this.checkpoint.latestRawBarTimestamp === null ? undefined :
      // Retain the in-progress bucket plus the 21 completed observations that
      // the unchanged index-20 feature gate can require.
      this.checkpoint.latestRawBarTimestamp - (this.featureDecisionObservations + 1) * this.decisionWidthMs;
    const raw = await this.options.store.listClosedBars(this.options.config.symbol, rawStart);
    if (raw.length === 0) return;
    const width = this.decisionWidthMs;
    const latestBucketStart = Math.floor(raw[raw.length - 1]!.t / width) * width;
    const buckets = new Map<number, ClosedBar[]>();
    for (const bar of raw) {
      const start = Math.floor(bar.t / width) * width;
      const bars = buckets.get(start) ?? [];
      bars.push(bar);
      buckets.set(start, bars);
    }
    const ordered = [...buckets.entries()].sort(([a], [b]) => a - b);
    let incomplete = 0;
    let trailingContinuous: ClosedBar[] = [];
    let previousStart: number | null = null;
    for (const [start, bars] of ordered) {
      const byTimestamp = new Map(bars.map((bar) => [bar.t, bar]));
      const slots = Array.from({ length: width / 60_000 }, (_, index) => byTimestamp.get(start + index * 60_000));
      // Continuity is exchange-calendar semantics, not an injectable dispatch
      // test override. A test may veto dispatch without fabricating a gap.
      const regular = isMarketSessionOpen(this.asset, start);
      const complete = slots.every((slot) => slot);
      if (!complete) {
        // The newest live bucket is still accumulating. Its absence of future
        // minutes is not a continuity gap; a fully populated final bucket is
        // nevertheless eligible (including 15:45–16:00).
        if (start === latestBucketStart) continue;
        if (regular) incomplete += 1;
        if (regular) {
          trailingContinuous = [];
          previousStart = null;
        }
        continue;
      }
      const decisionBar = {
        t: start, open: slots[0]!.open, high: Math.max(...slots.map((slot) => slot!.high)),
        low: Math.min(...slots.map((slot) => slot!.low)), close: slots.at(-1)!.close,
        volume: slots.reduce((sum, slot) => sum + slot!.volume, 0),
      };
      if (!regular) continue;
      if (previousStart !== null && start !== previousStart + width) {
        // A new exchange day has no fabricated missing candles, but it is also
        // not continuous feature history: rebuild from its completed buckets.
        trailingContinuous = [];
        if (newYorkDate(previousStart) === newYorkDate(start)) {
          incomplete += Math.max(0, Math.round((start - previousStart) / width) - 1);
        }
      }
      trailingContinuous.push(decisionBar);
      previousStart = start;
    }
    this.missingDecisionBuckets = incomplete;
    const continuousFeatures = computeFeatures(trailingContinuous);
    const warmupComplete = continuousFeatures.at(-1)?.warmupComplete ?? false;
    this.checkpoint.featureContinuity = warmupComplete ? "HEALTHY" : "REBUILDING";
    // A failed repair can recover only by the unchanged full feature warmup;
    // it never treats an incomplete REST response as continuity.
    if (this.checkpoint.recoveryState === "REBUILDING" && warmupComplete) {
      this.checkpoint.recoveryState = "HEALTHY";
      this.checkpoint.recoveryCompletedAt ??= (this.options.now ?? (() => new Date()))().toISOString();
    }
    // Startup and recovery verification may establish continuity, but must
    // never manufacture a decision or broker command for durable history.
    if (evaluateOnly) return;
    // Decision evidence for a bucket must be calculated only from the current
    // contiguous run; no return, EMA, RSI, volatility, or trend bridges a gap.
    for (let index = 0; index < trailingContinuous.length; index += 1) {
      const decisionBar = trailingContinuous[index]!;
      if (eligibleBucketStart !== undefined && decisionBar.t !== eligibleBucketStart) continue;
      if (this.checkpoint.recoveryDispatchNotBeforeBucketMs !== null && decisionBar.t < this.checkpoint.recoveryDispatchNotBeforeBucketMs) continue;
      const decisionId = deterministicDecisionId(decisionBar.t, this.runtimeIdentity);
      const evidence = await this.decisionEvidence(trailingContinuous, index, decisionId);
      const inSession = (this.options.isRegularSession ?? ((timestamp) => isMarketSessionOpen(this.asset, timestamp)))(decisionBar.t);
      // Dispatch freshness is based on the newest received live bar, not the
      // start timestamp of an already-complete 15-minute decision bucket.
      const latestLiveBarStale = this.isLiveBarStale(this.checkpoint.latestRawBarTimestamp ?? decisionBar.t);
      const reconciliationComplete = this.checkpoint.lastReconciliationTimestamp !== null && this.state === "READY";
      const blockReason = dispatchBlockReasonFor({
        dispatchCapable: this.dispatchCapable,
        inSession,
        warmupComplete: evidence.features.warmupComplete,
        featureContinuity: this.checkpoint.featureContinuity,
        recoveryState: this.checkpoint.recoveryState,
        latestLiveBarStale,
        reconciliationComplete,
        hasOwnership: this.ownership !== null,
      });
      const dispatchEligible = blockReason === null;
      if (evidence.strategyDecision) evidence.strategyDecision.blockReason = blockReason;
      const intent: ExecutionIntent = {
        intentId: `${decisionId}:intent`, decisionId, createdAtBar: index, createdAtTimestamp: decisionBar.t,
        desiredAction: evidence.action, desiredPosition: evidence.targetPosition, status: dispatchEligible ? "PENDING" : "CANCELLED",
        executionModel: "ALPACA_PAPER", clientOrderId: deterministicClientOrderId(decisionId),
      };
      const persisted = await this.options.store.persistDecisionAndIntent(this.key, evidence, intent, blockReason);
      if (!persisted.inserted) continue;
      this.checkpoint.latestClosedDecisionBarTimestamp = decisionBar.t;
      this.checkpoint.latestDecisionId = decisionId;
      if (this.isEmaRsiV1) this.checkpoint.priorRiskApprovedTarget = evidence.targetPosition === 1 ? 1 : 0;
      this.riskState = evidence.risk.reasons.join(" ") || "PASS";
      if (dispatchEligible) {
        try {
          await this.dispatch(intent);
        } catch (error) {
          await this.halt(error instanceof Error ? error.message : "DISPATCH_RECONCILIATION_FAILED");
          return;
        }
      }
      await this.persistCheckpoint();
    }
  }

  private expectedLiveGap(previous: number | null, current: number): { start: number; end: number } | null {
    if (previous === null || current <= previous + 60_000 || newYorkDate(previous) !== newYorkDate(current)) return null;
    let start: number | null = null;
    let end: number | null = null;
    for (let timestamp = previous + 60_000; timestamp < current; timestamp += 60_000) {
      if (!isMarketSessionOpen(this.asset, timestamp)) continue;
      start ??= timestamp;
      end = timestamp + 60_000;
    }
    return start === null || end === null ? null : { start, end };
  }

  /**
   * Scans exactly the raw interval used by feature construction and repairs
   * persisted regular-session holes in deterministic oldest-first order.
   */
  private async recoverStartupFeatureGaps(): Promise<void> {
    const latest = await this.options.store.latestClosedBarTimestamp(this.options.config.symbol);
    if (latest === null) return;
    this.checkpoint.latestRawBarTimestamp = Math.max(this.checkpoint.latestRawBarTimestamp ?? 0, latest);
    const start = latest - (this.featureDecisionObservations + 1) * this.decisionWidthMs;
    const raw = await this.options.store.listClosedBars(this.options.config.symbol, start, latest);
    const present = new Set(raw.filter((bar) => Number.isFinite(bar.t) && bar.t % 60_000 === 0).map((bar) => bar.t));
    const gaps: Array<{ start: number; end: number }> = [];
    let gapStart: number | null = null;
    for (let timestamp = start; timestamp <= latest; timestamp += 60_000) {
      const missingRegularBar = isMarketSessionOpen(this.asset, timestamp) && !present.has(timestamp);
      if (missingRegularBar) {
        gapStart ??= timestamp;
        continue;
      }
      if (gapStart !== null) {
        gaps.push({ start: gapStart, end: timestamp });
        gapStart = null;
      }
    }
    if (gapStart !== null) gaps.push({ start: gapStart, end: latest + 60_000 });
    const detectedAt = (this.options.now ?? (() => new Date()))().toISOString();
    for (const gap of gaps) await this.recoverGap(gap.start, gap.end, detectedAt, true);
    // Even when no gap exists, startup must calculate the feature-continuity
    // state without replaying decisions from durable history.
    await this.processCompletedDecisionBars(undefined, true);
  }

  private async recoverGap(start: number, end: number, detectedAt: string, evaluateOnly = false): Promise<void> {
    const recoveryAttemptId = randomUUID();
    const dispatchNotBefore = (Math.floor(Date.parse(detectedAt) / this.decisionWidthMs) + 1) * this.decisionWidthMs;
    let attempt: GapRecoveryAttempt = {
      recoveryAttemptId, workerKey: this.key, symbol: this.asset.symbol, missingStartMs: start, missingEndMs: end,
      state: "GAP_DETECTED", detectedAt, result: null, reason: null,
    };
    await this.options.store.createGapRecoveryAttempt(attempt);
    this.checkpoint.recoveryState = "GAP_DETECTED";
    this.checkpoint.recoveryAttemptId = recoveryAttemptId;
    this.checkpoint.recoveryMissingStartMs = start;
    this.checkpoint.recoveryMissingEndMs = end;
    this.checkpoint.recoveryDispatchNotBeforeBucketMs = Math.max(this.checkpoint.recoveryDispatchNotBeforeBucketMs ?? 0, dispatchNotBefore);
    await this.persistCheckpoint();
    try {
      const requestedAt = (this.options.now ?? (() => new Date()))().toISOString();
      attempt = { ...attempt, state: "BACKFILLING", requestedAt };
      await this.options.store.updateGapRecoveryAttempt(attempt);
      this.checkpoint.recoveryState = "BACKFILLING";
      await this.persistCheckpoint();
      const source = this.options.historicalBars ?? new AlpacaHistoricalStockBars(this.options.config);
      const bars = await source.bars({ symbol: this.asset.symbol as import("./assets.ts").BoundedEquitySymbol, start, end });
      const expected = Array.from({ length: (end - start) / 60_000 }, (_, index) => start + index * 60_000);
      const byTimestamp = new Map(bars.map((bar) => [bar.t, bar]));
      const structurallyValid = bars.every((bar) => Number.isFinite(bar.t) && bar.t % 60_000 === 0 && bar.t >= start && bar.t < end &&
        [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) && bar.volume >= 0 &&
        bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close) && bar.high >= bar.low);
      if (!structurallyValid || bars.length !== expected.length || byTimestamp.size !== expected.length || expected.some((timestamp) => !byTimestamp.has(timestamp))) {
        const reason = structurallyValid ? "PARTIAL_BACKFILL" : "INVALID_BACKFILL_BAR";
        await this.enterRebuilding(reason, { ...attempt, state: "REBUILDING", returnedBarCount: bars.length, reason });
        return;
      }
      const verifiedAt = (this.options.now ?? (() => new Date()))().toISOString();
      attempt = { ...attempt, state: "VERIFYING", returnedBarCount: bars.length, verifiedAt };
      await this.options.store.updateGapRecoveryAttempt(attempt);
      this.checkpoint.recoveryState = "VERIFYING";
      await this.persistCheckpoint();
      for (const timestamp of expected) {
        const bar = byTimestamp.get(timestamp)!;
        const result = await this.options.store.recordMarketBar({
          symbol: this.asset.symbol, bar, providerEventTimestampMs: bar.t, observedAt: verifiedAt, origin: "REST_BACKFILL", recoveryAttemptId,
        });
        if (result === "CONFLICT") {
          await this.enterRebuilding("BACKFILL_BAR_CONFLICT", { ...attempt, state: "REBUILDING", verifiedBarCount: 0, reason: "BACKFILL_BAR_CONFLICT" });
          return;
        }
      }
      // The barrier uses verification completion, never merely gap detection:
      // queued live bars from a slow REST request cannot become retroactive.
      const completedAt = (this.options.now ?? (() => new Date()))().toISOString();
      const completionBarrier = (Math.floor(Date.parse(completedAt) / this.decisionWidthMs) + 1) * this.decisionWidthMs;
      this.checkpoint.recoveryCompletedAt = completedAt;
      this.checkpoint.recoveryDispatchNotBeforeBucketMs = Math.max(this.checkpoint.recoveryDispatchNotBeforeBucketMs ?? 0, completionBarrier);
      await this.processCompletedDecisionBars(undefined, evaluateOnly);
      const restored = this.checkpoint.featureContinuity === "HEALTHY";
      this.checkpoint.recoveryState = restored ? "HEALTHY" : "REBUILDING";
      attempt = { ...attempt, state: this.checkpoint.recoveryState, verifiedBarCount: bars.length, completedAt, result: restored ? "VERIFIED" : "FEATURE_WARMUP_REQUIRED", reason: restored ? null : "FEATURE_WARMUP_REQUIRED" };
      await this.options.store.updateGapRecoveryAttempt(attempt);
      await this.persistCheckpoint();
    } catch (error) {
      const reason = error instanceof AlpacaTransportError
        ? error.kind
        : "UNKNOWN_FAILURE";
      await this.enterRebuilding("BACKFILL_REQUEST_FAILED", { ...attempt, state: "REBUILDING", reason });
    }
  }

  private async enterRebuilding(reason: string, attempt?: GapRecoveryAttempt): Promise<void> {
    this.checkpoint.recoveryState = "REBUILDING";
    this.checkpoint.featureContinuity = "REBUILDING";
    if (attempt) await this.options.store.updateGapRecoveryAttempt({ ...attempt, state: "REBUILDING", result: attempt.result ?? reason, reason: attempt.reason ?? reason });
    await this.persistCheckpoint();
  }

  private async decisionEvidence(candles: ClosedBar[], index: number, decisionId: string): Promise<Evidence> {
    if (this.dispatchCapable) await this.refreshPaperEquity();
    const features = computeFeatures(candles);
    const feature = features[index]!;
    if (this.targetStrategy) {
      // Only the closed prefix through `index` is supplied. This is both the
      // strategy boundary and the no-lookahead boundary for the 1-minute arm.
      const completedBars = candles.slice(0, index + 1);
      const priorTarget: TargetPosition = this.checkpoint.priorRiskApprovedTarget ?? 0;
      const strategy = this.targetStrategy.evaluate({ completedBars, priorTarget });
      const desired = strategy.targetPosition === 1 ? "LONG" : "FLAT";
      const equityDrawdown = this.paperEquityDrawdown();
      const risk = this.dispatchCapable
        ? evaluateRisk({ desired, features: feature, equityDrawdown: equityDrawdown ?? (() => { throw new Error("PAPER_EQUITY_UNAVAILABLE"); })() })
        : { version: "READ_ONLY_RUNTIME", pass: true, target: desired, reasons: ["READ_ONLY_RUNTIME"], maxPosition: 1, realizedVol: feature.realizedVol, drawdown: feature.drawdown, equityDrawdown: 0 };
      const finalRiskApprovedTarget: TargetPosition = risk.target === "LONG" ? 1 : 0;
      const decisionTimestamp = (this.options.now ?? (() => new Date()))().getTime();
      return {
        id: decisionId,
        timestamp: feature.timestamp,
        barIndex: index,
        symbol: this.asset.symbol,
        timeframe: this.targetStrategy.timeframe,
        tradingMode: "ALPACA_PAPER",
        marketSnapshot: candles[index]!,
        features: feature,
        strategyId: EMA_RSI_V1_ID,
        strategyVersion: this.targetStrategy.version,
        researchRefs: [],
        risk,
        action: risk.target,
        targetPosition: finalRiskApprovedTarget,
        abstained: strategy.targetPosition !== finalRiskApprovedTarget,
        strategyDecision: {
          decisionTimestamp,
          sourceBarTimestamp: candles[index]!.t,
          priorTarget,
          proposedTarget: strategy.targetPosition,
          finalRiskApprovedTarget,
          blockReason: null,
          runtime: { workerKey: this.key, workerVersion: this.runtimeIdentity.workerVersion, runId: this.runId },
          evidenceLinks: {
            marketBar: `closed_bars:${this.asset.symbol}:${candles[index]!.t}`,
            recoveryAttemptId: this.checkpoint.recoveryAttemptId,
          },
          features: strategy.features,
        },
      } as unknown as Evidence;
    }
    const adapter = createMockJevAdapter();
    const signal = evaluateSignal("ema_trend", feature);
    const deterministicRegime = classifyDeterministicRegime(feature);
    const jevRequest = buildJevRequest(feature, adapter.model);
    const jevResponse = adapter.classify(feature);
    const policy = evaluateAssetAwarePolicy({ asset: this.asset, arm: "C", strategyId: "ema_trend", signal, detRegime: deterministicRegime, jev: jevResponse });
    // Read-only durable runtimes retain their unchanged signal/policy evidence
    // path without requiring a broker account reconciliation they cannot use.
    const equityDrawdown = this.dispatchCapable ? this.paperEquityDrawdown() : 0;
    if (equityDrawdown === null) throw new Error("PAPER_EQUITY_UNAVAILABLE");
    const risk = evaluateRisk({ desired: policy.desired, features: feature, equityDrawdown });
    const action = risk.target;
    return {
      id: decisionId, timestamp: feature.timestamp, barIndex: index, symbol: this.asset.symbol, timeframe: ALPACA_WORKER_TIMEFRAME,
      tradingMode: "ALPACA_PAPER", marketSnapshot: candles[index]!, features: feature, strategyId: "ema_trend", strategyVersion: STRATEGY_VERSION,
      researchRefs: ["arXiv:1308.5658", "arXiv:2602.10785"], deterministicSignal: signal, deterministicRegime,
      jevRequest, jevResponse, policy, risk, action, targetPosition: actionToPosition(action),
      abstained: policy.desired !== action || (action === "FLAT" && signal.desired !== "FLAT"),
    };
  }

  private isLiveBarStale(sourceBarTimestamp: number): boolean {
    const now = (this.options.now ?? (() => new Date()))().getTime();
    return now - (sourceBarTimestamp + 60_000) > EMA_RSI_V1_MAX_LIVE_BAR_AGE_MS;
  }

  private async dispatch(intent: ExecutionIntent): Promise<void> {
    if (this.isLiveBarStale(this.checkpoint.latestRawBarTimestamp ?? intent.createdAtTimestamp)) {
      await this.options.store.putIntent({ ...intent, status: "CANCELLED" }, "LATEST_LIVE_BAR_STALE");
      return;
    }
    // Fresh broker reads are mandatory for every target. Local/replay position is never consulted.
    const position = await this.broker().position();
    if (position.symbol !== this.asset.symbol || position.provenance !== "ALPACA_RECONCILED" || !Number.isFinite(position.quantity)) {
      throw new Error("BROKER_POSITION_RECONCILIATION_REQUIRED");
    }
    this.brokerPosition = position;
    await this.options.store.appendBrokerPosition(position);
    this.openOrders = await this.broker().openOrders();
    if (this.openOrders.length > 0) {
      // Conservative policy: never stack a new target behind any open SPY paper order.
      await this.options.store.putIntent(intent, "OPEN_ORDER_CONFLICT");
      return;
    }
    const reconciled = await this.broker().reconcile(intent);
    await this.recordBrokerState(reconciled);
    if (reconciled.lookup === "FOUND" || reconciled.status === "UNKNOWN" || reconciled.status !== "PENDING") return;
    const ownership = this.ownership;
    if (!ownership) throw new Error("DISPATCH_OWNERSHIP_REQUIRED");
    // This durable marker closes the crash window after a broker POST begins.
    // It is also a conditional, fenced claim: an old owner cannot change it.
    if (!await this.options.store.claimIntentForDispatch(ownership, intent, this.runtimeIdentity)) {
      await this.loseOwnership("DISPATCH_OWNERSHIP_LOST");
      throw new Error("DISPATCH_OWNERSHIP_LOST");
    }
    // Revalidate immediately before POST while holding the lease-row lock.
    // A takeover either happened first (no POST) or waits until this bounded
    // call completes; the broker cannot participate in a SQL transaction.
    const submitted = await this.options.store.withDispatchAuthority(
      ownership,
      intent.intentId,
      this.runtimeIdentity,
      // The durable store owns the submission marker. The broker adapter needs
      // its pre-POST reconciliation view to remain PENDING so it can perform
      // the one authorized POST rather than treating the marker as a retry.
      () => this.broker().submit({ ...intent, status: "PENDING" }, position),
    );
    if (!submitted) {
      await this.loseOwnership("DISPATCH_OWNERSHIP_LOST");
      throw new Error("DISPATCH_OWNERSHIP_LOST");
    }
    await this.recordBrokerState(submitted);
    if (submitted.status === "UNKNOWN") await this.halt("UNKNOWN_SUBMISSION_REQUIRES_RECOVERY");
  }

  private async reconcileInternal(): Promise<void> {
    this.state = "RECONCILING";
    if (!this.runId) throw new Error("WORKER_RUN_REQUIRED");
    try {
      await this.options.store.updateRun(this.runId, this.state, null);
    } catch (error) {
      if (this.isLifecycleUpdateRejected(error)) {
        await this.loseOwnership("DISPATCH_OWNERSHIP_LOST");
        return;
      }
      throw error;
    }
    await this.refreshPaperEquity();
    if (this.stopped) return;
    const position = await this.broker().position();
    if (this.stopped) return;
    if (position.symbol !== this.asset.symbol || position.provenance !== "ALPACA_RECONCILED" || !Number.isFinite(position.quantity)) throw new Error("BROKER_POSITION_RECONCILIATION_REQUIRED");
    this.brokerPosition = position;
    await this.options.store.appendBrokerPosition(position);
    this.openOrders = await this.broker().openOrders();
    const intents = await this.options.store.listIntents(this.asset.symbol, this.key);
    const knownClientIds = new Set(intents.map(({ intent }) => intent.clientOrderId ?? intent.intentId));
    const unknownOpenOrder = this.openOrders.find((order) => !knownClientIds.has(order.clientOrderId));
    if (unknownOpenOrder) throw new Error(`CONTRADICTORY_OPEN_BROKER_ORDER:${unknownOpenOrder.clientOrderId || "MISSING_CLIENT_ORDER_ID"}`);
    for (const stored of intents) {
      if (terminal(stored.intent.status)) continue;
      const state = await this.broker().reconcile(stored.intent);
      // A durable pre-POST marker means the process may have crashed after the
      // broker received the order but before its response was persisted. An
      // absent lookup is uncertainty, never permission to downgrade/repost.
      if (stored.intent.status === "SUBMISSION_ATTEMPTED" && state.lookup === "ABSENT") {
        throw new Error("SUBMISSION_ATTEMPTED_RECOVERY_REQUIRED");
      }
      await this.recordBrokerState(state, stored.dispatchBlockReason);
      // UNKNOWN + ABSENT remains UNKNOWN. It is intentionally never submitted here.
      if (state.status === "UNKNOWN") throw new Error("UNKNOWN_SUBMISSION_REQUIRES_RECOVERY");
      // A crash after atomic persistence but before dispatch leaves PENDING.
      // It is safe to resume only after this authoritative absent lookup.
      if (stored.intent.status === "PENDING" && state.lookup === "ABSENT" && state.status === "PENDING") {
        await this.dispatch(stored.intent);
      }
    }
    this.checkpoint.lastReconciliationTimestamp = (this.options.now ?? (() => new Date()))().toISOString();
    this.checkpoint.haltReason = null;
  }

  private async recordBrokerState(state: BrokerOrderState, blockReason: string | null = null): Promise<void> {
    const ownership = this.ownership;
    if (!ownership) throw new Error("DISPATCH_OWNERSHIP_REQUIRED");
    const projected = await this.options.store.recordBrokerOrder(ownership, this.runtimeIdentity, state, blockReason);
    if (projected === null) throw new Error("BROKER_ORDER_OWNERSHIP_OR_CORRELATION_LOST");
    this.latestBrokerOrderState = projected;
  }

  private connectTradeUpdates(): void {
    if (!this.options.tradeUpdates || this.disconnectTradeUpdates || this.stopped) return;
    this.tradeUpdateStreamState = "CONNECTING";
    const generation = this.reconnectGeneration;
    let failedDuringConnect = false;
    const disconnect = this.options.tradeUpdates.connect(
      (update) => { void this.processTradeUpdate(update).catch((error) => this.halt(error instanceof Error ? error.message : "TRADE_UPDATE_PROJECTION_FAILED")); },
      (error) => {
        failedDuringConnect = true;
        void this.handleTradeStreamError(error);
      },
      () => {
        if (generation !== this.reconnectGeneration || this.stopped || this.state !== "READY" || failedDuringConnect) return;
        this.tradeUpdateStreamState = "CONNECTED";
        void this.persistCheckpoint();
      },
    );
    // A fake or transport can report failure synchronously from connect(). Do
    // not retain that socket or overwrite DEGRADED with CONNECTED afterwards.
    if (failedDuringConnect) {
      disconnect();
      return;
    }
    this.disconnectTradeUpdates = disconnect;
    void this.persistCheckpoint();
  }

  async processTradeUpdate(update: Record<string, unknown>): Promise<void> {
    const data = update.data as Record<string, unknown> | undefined;
    const order = data?.order as Record<string, unknown> | undefined;
    const clientOrderId = order ? String(order.client_order_id ?? "") || null : null;
    await this.options.store.appendTradeUpdate(update, clientOrderId);
    this.lastTradeUpdateTimestamp = (this.options.now ?? (() => new Date()))().toISOString();
    if (!this.ownership || this.stopped || this.state === "HALTED") return;
    if (!clientOrderId) return this.persistCheckpoint();
    const stored = (await this.options.store.listIntents(this.asset.symbol, this.key)).find(({ intent }) => (intent.clientOrderId ?? intent.intentId) === clientOrderId);
    if (stored) {
      const state = brokerStateFromTradeUpdate(update, stored.intent, this.asset.symbol);
      if (state) await this.recordBrokerState(state, stored.dispatchBlockReason);
    }
    await this.persistCheckpoint();
  }

  async handleTradeStreamError(_error: Error): Promise<void> {
    if (this.stopped || this.state === "HALTED" || this.tradeRecoveryInFlight || this.tradeReconnectScheduled) return;
    this.tradeRecoveryInFlight = true;
    this.tradeUpdateStreamState = "DEGRADED";
    this.disconnectTradeUpdates?.();
    this.disconnectTradeUpdates = null;
    try {
      await this.persistCheckpoint();
      // Reconciliation is required before reconnect; missed events are never assumed absent.
      await this.reconcile();
      if (this.state === "READY" && !this.stopped) this.scheduleTradeReconnect();
    } finally {
      this.tradeRecoveryInFlight = false;
    }
  }

  private scheduleTradeReconnect(): void {
    if (!this.options.tradeUpdates || this.tradeReconnectScheduled || this.stopped || this.state !== "READY") return;
    this.tradeReconnectScheduled = true;
    const generation = this.reconnectGeneration;
    const attempt = ++this.tradeReconnectAttempt;
    const delay = Math.max(0, this.options.reconnectDelayMs?.(attempt) ?? Math.min(30_000, 250 * 2 ** (attempt - 1)));
    void (async () => {
      await (this.options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))))(delay);
      this.tradeReconnectScheduled = false;
      if (generation !== this.reconnectGeneration || this.stopped || this.state !== "READY") return;
      this.connectTradeUpdates();
    })();
  }

  private startMarketConsumer(): void {
    if (!this.options.source || this.consuming || this.stopped || this.state !== "READY") return;
    this.marketStreamState = "CONNECTING";
    this.consuming = true;
    void this.persistCheckpoint();
    void this.consume(this.options.source);
  }

  private async consume(source: MarketSource): Promise<void> {
    let failed = false;
    try {
      this.marketStreamState = "CONNECTED";
      await this.persistCheckpoint();
      for await (const bar of source.bars()) {
        if (this.stopped || this.state !== "READY") break;
        await this.processRawBar(bar);
      }
    } catch {
      failed = true;
    } finally {
      this.consuming = false;
      if (!this.stopped && this.state !== "HALTED") await this.recoverMarketStream(failed ? "MARKET_STREAM_DISCONNECTED" : "MARKET_STREAM_ENDED");
    }
  }

  private async recoverMarketStream(reason: string): Promise<void> {
    if (this.stopped || this.state === "HALTED") return;
    this.marketStreamState = "DEGRADED";
    await this.persistCheckpoint();
    this.marketStreamState = "RECONCILING";
    try {
      await this.reconcile();
      if (this.state !== "READY" || this.stopped) return;
    } catch {
      await this.halt(`${reason}_RECONCILIATION_FAILED`);
      return;
    }
    this.scheduleMarketReconnect();
  }

  private scheduleMarketReconnect(): void {
    if (!this.options.source || this.marketReconnectScheduled || this.stopped || this.state !== "READY") return;
    this.marketReconnectScheduled = true;
    const generation = this.reconnectGeneration;
    const attempt = ++this.marketReconnectAttempt;
    const delay = Math.max(0, this.options.reconnectDelayMs?.(attempt) ?? Math.min(30_000, 250 * 2 ** (attempt - 1)));
    void (async () => {
      await (this.options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))))(delay);
      this.marketReconnectScheduled = false;
      if (generation !== this.reconnectGeneration || this.stopped || this.state !== "READY") return;
      this.startMarketConsumer();
    })();
  }

  private async refreshPaperEquity(): Promise<void> {
    if (this.requiresPaperEquityHighWaterRecovery) {
      throw new Error("PAPER_EQUITY_HIGH_WATER_RECOVERY_REQUIRED");
    }
    const account = await this.broker().account();
    if (account.provenance !== "ALPACA_PAPER_ACCOUNT" || !Number.isFinite(account.equity) || account.equity <= 0) {
      throw new Error("PAPER_EQUITY_UNAVAILABLE");
    }
    const priorHighWater = this.checkpoint.paperEquityHighWater;
    this.checkpoint.lastPaperEquity = account.equity;
    this.checkpoint.paperEquityHighWater = Math.max(priorHighWater ?? account.equity, account.equity);
    // Persist a new high-water before issuing any evidence or broker command.
    // A restart therefore cannot weaken a drawdown gate by resetting its peak.
    await this.persistCheckpoint();
  }

  private paperEquityDrawdown(): number | null {
    const equity = this.checkpoint.lastPaperEquity;
    const highWater = this.checkpoint.paperEquityHighWater;
    if (typeof equity !== "number" || typeof highWater !== "number" || !Number.isFinite(equity) || !Number.isFinite(highWater) || highWater <= 0) return null;
    return Math.max(0, (highWater - equity) / highWater);
  }

  private normalizeCheckpoint(checkpoint: WorkerCheckpoint): WorkerCheckpoint {
    const legacyState = checkpoint.streamState ?? "DISCONNECTED";
    return {
      ...emptyCheckpoint(),
      ...checkpoint,
      streamState: legacyState,
      marketStreamState: checkpoint.marketStreamState ?? legacyState,
      tradeUpdateStreamState: checkpoint.tradeUpdateStreamState ?? "DISCONNECTED",
      featureContinuity: checkpoint.featureContinuity ?? "REBUILDING",
      recoveryState: checkpoint.recoveryState ?? "HEALTHY",
      recoveryAttemptId: checkpoint.recoveryAttemptId ?? null,
      recoveryMissingStartMs: Number.isFinite(checkpoint.recoveryMissingStartMs) ? checkpoint.recoveryMissingStartMs : null,
      recoveryMissingEndMs: Number.isFinite(checkpoint.recoveryMissingEndMs) ? checkpoint.recoveryMissingEndMs : null,
      recoveryCompletedAt: checkpoint.recoveryCompletedAt ?? null,
      recoveryDispatchNotBeforeBucketMs: Number.isFinite(checkpoint.recoveryDispatchNotBeforeBucketMs) ? checkpoint.recoveryDispatchNotBeforeBucketMs : null,
      paperEquityHighWater: Number.isFinite(checkpoint.paperEquityHighWater) ? checkpoint.paperEquityHighWater : null,
      lastPaperEquity: Number.isFinite(checkpoint.lastPaperEquity) ? checkpoint.lastPaperEquity : null,
      priorRiskApprovedTarget: checkpoint.priorRiskApprovedTarget === 1 ? 1 : checkpoint.priorRiskApprovedTarget === 0 ? 0 : null,
    };
  }

  private startOwnershipRenewal(): void {
    this.stopOwnershipRenewal();
    const generation = this.ownershipGeneration;
    this.ownershipTimer = setInterval(() => {
      void this.renewOwnership(generation);
    }, OWNERSHIP_RENEW_INTERVAL_MS);
    this.ownershipTimer.unref?.();
  }

  private stopOwnershipRenewal(): void {
    if (this.ownershipTimer) clearInterval(this.ownershipTimer);
    this.ownershipTimer = null;
  }

  private async renewOwnership(generation: number): Promise<void> {
    if (generation !== this.ownershipGeneration || this.stopped || this.state === "HALTED") return;
    const ownership = this.ownership;
    if (!ownership) return;
    try {
      const renewed = await this.options.store.renewOwnership(ownership, OWNERSHIP_LEASE_SECONDS);
      if (!renewed) await this.loseOwnership("DISPATCH_OWNERSHIP_LOST");
      else if (generation === this.ownershipGeneration) this.ownership = renewed;
    } catch {
      // A database ambiguity is never dispatch permission. Stop local streams
      // without attempting a checkpoint write that could overwrite the new owner.
      await this.loseOwnership("DISPATCH_OWNERSHIP_RENEWAL_FAILED");
    }
  }

  private async releaseOwnership(): Promise<void> {
    const ownership = this.ownership;
    this.ownership = null;
    this.ownershipGeneration += 1;
    if (!ownership) return;
    try {
      await this.options.store.releaseOwnership(ownership);
    } catch {
      // Expiry is the recovery mechanism. A failed graceful release cannot
      // restore authority or make a crashed owner permanent.
    }
  }

  private async loseOwnership(reason: string): Promise<void> {
    if (this.state === "HALTED" && !this.ownership) return;
    this.ownership = null;
    this.ownershipGeneration += 1;
    this.stopOwnershipRenewal();
    this.stopped = true;
    this.reconnectGeneration += 1;
    this.marketReconnectScheduled = false;
    this.tradeReconnectScheduled = false;
    this.disconnectTradeUpdates?.();
    this.disconnectTradeUpdates = null;
    this.state = "HALTED";
    this.marketStreamState = "DEGRADED";
    this.tradeUpdateStreamState = "DEGRADED";
    this.checkpoint.haltReason = reason;
    // Deliberately no checkpoint mutation after authority is lost.
    if (this.runId) {
      try {
        await this.options.store.updateRun(this.runId, this.state, reason);
      } catch (error) {
        if (!this.isLifecycleUpdateRejected(error)) throw error;
      }
    }
  }

  private async halt(reason: string): Promise<void> {
    if (!this.ownership) {
      await this.loseOwnership(reason);
      return;
    }
    this.state = "HALTED";
    this.stopOwnershipRenewal();
    this.reconnectGeneration += 1;
    this.marketReconnectScheduled = false;
    this.tradeReconnectScheduled = false;
    this.checkpoint.haltReason = reason;
    this.marketStreamState = "DEGRADED";
    this.tradeUpdateStreamState = "DEGRADED";
    try {
      let lifecyclePersisted = true;
      if (this.runId) {
        try {
          await this.options.store.updateRun(this.runId, this.state, reason);
        } catch (error) {
          if (!this.isLifecycleUpdateRejected(error)) throw error;
          lifecyclePersisted = false;
        }
      }
      if (lifecyclePersisted) await this.persistCheckpoint();
    } finally {
      await this.releaseOwnership();
    }
  }

  private async confirmCurrentOwnership(): Promise<boolean> {
    const ownership = this.ownership;
    if (!ownership || this.stopped) return false;
    const renewed = await this.options.store.renewOwnership(ownership, OWNERSHIP_LEASE_SECONDS);
    if (!renewed) {
      await this.loseOwnership("DISPATCH_OWNERSHIP_LOST");
      return false;
    }
    this.ownership = renewed;
    return true;
  }

  private isLifecycleUpdateRejected(error: unknown): boolean {
    return error instanceof Error && error.message === "WORKER_RUN_LIFECYCLE_UPDATE_REJECTED";
  }

  private async persistCheckpoint(): Promise<void> {
    this.checkpoint.streamState = this.marketStreamState;
    this.checkpoint.marketStreamState = this.marketStreamState;
    this.checkpoint.tradeUpdateStreamState = this.tradeUpdateStreamState;
    const ownership = this.ownership;
    if (!ownership) throw new Error("DISPATCH_OWNERSHIP_REQUIRED");
    if (!await this.options.store.writeCheckpointOwned(ownership, this.checkpoint)) {
      await this.loseOwnership("DISPATCH_OWNERSHIP_LOST");
      throw new Error("DISPATCH_OWNERSHIP_LOST");
    }
  }
}

const globalRef = globalThis as typeof globalThis & { __alpacaPaperWorkers__?: Record<string, Promise<AlpacaPaperWorker>> };

/**
 * Runtime singleton for the explicitly launched worker process.
 *
 * Vercel serves the web application and read-only runtime views only. Its
 * request/function lifecycle cannot own the session-long market and
 * trade-update streams, so fail closed before configuration, database, or
 * socket initialization if this factory is ever reached there.
 */
export function getAlpacaPaperWorker(arm: PaperWorkerArm = "ema_trend_arm_c", symbol: string = SPY_SPEC.symbol): Promise<AlpacaPaperWorker> {
  if (process.env.VERCEL === "1") {
    throw new Error("ALPACA_WORKER_FORBIDDEN_ON_VERCEL");
  }
  const asset = boundedEquityAsset(symbol);
  const identity = workerRuntimeIdentityFor(asset, arm);
  const workers = globalRef.__alpacaPaperWorkers__ ??= {};
  workers[identity.workerKey] ??= (async () => {
    // READ_ONLY consumers are relay-only. If the relay cannot merge bounded
    // downstream subscriptions, startup remains fail-closed rather than
    // opening additional Alpaca upstream sockets.
    const relay = loadLocalMarketDataUrl();
    if (identity.capability.kind === "READ_ONLY_DURABLE" && !relay) throw new Error("READ_ONLY_RELAY_SUBSCRIPTION_REQUIRED");
    const config = loadAlpacaConfig({ ...process.env, ALPACA_SYMBOL: asset.symbol });
    const worker = new AlpacaPaperWorker({
      config, asset, store: new SqlAlpacaWorkerStore(),
      ...(identity.capability.kind === "DISPATCH_CAPABLE" ? { broker: new AlpacaPaperBroker(config), tradeUpdates: new AlpacaPaperTradeUpdates(config) } : {}),
      source: new AlpacaMarketSource(config, undefined, undefined, relay), arm,
    });
    await worker.start();
    return worker;
  })().catch((error) => {
    delete workers[identity.workerKey];
    throw error;
  });
  return workers[identity.workerKey]!;
}

/** Read-only operator status; unlike getAlpacaPaperWorker it does not start work. */
export async function readAlpacaPaperWorkerSnapshot(arm: PaperWorkerArm = "ema_trend_arm_c", symbol: string = SPY_SPEC.symbol): Promise<AlpacaWorkerSnapshot | null> {
  const worker = await globalRef.__alpacaPaperWorkers__?.[workerRuntimeIdentityFor(boundedEquityAsset(symbol), arm).workerKey];
  return worker?.snapshot() ?? null;
}

/** Exported solely for focused test fixtures; application runtime uses SQL. */
export { MemoryAlpacaWorkerStore };
