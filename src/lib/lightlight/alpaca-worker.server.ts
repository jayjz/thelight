import { createHash, randomUUID } from "node:crypto";
import {
  AlpacaMarketSource,
  AlpacaPaperBroker,
  AlpacaPaperTradeUpdates,
  brokerStateFromTradeUpdate,
  loadAlpacaConfig,
  type AlpacaConfig,
  type BrokerAccountSnapshot,
  type BrokerOrderState,
  type BrokerPositionSnapshot,
  type OpenBrokerOrder,
  type SubmissionRecovery,
} from "./alpaca.server.ts";
import { MemoryAlpacaWorkerStore, SqlAlpacaWorkerStore, type AlpacaWorkerStore, type WorkerCheckpoint } from "./alpaca-worker-store.server.ts";
import { computeFeatures } from "./features.ts";
import { buildJevRequest, createMockJevAdapter } from "./jev.ts";
import type { MarketSource } from "./market.ts";
import { classifyDeterministicRegime, evaluatePolicy, evaluateRisk, evaluateSignal } from "./policy.ts";
import { STRATEGY_VERSION } from "./thresholds.ts";
import type { ClosedBar, Evidence, ExecutionIntent, ExecutionStatus } from "./types.ts";

export const ALPACA_WORKER_SYMBOL = "SPY";
export const ALPACA_WORKER_TIMEFRAME = "15Min";
export const ALPACA_WORKER_CONFIG_VERSION = "alpaca-paper-worker-v1";

export type WorkerState = "STOPPED" | "STARTING" | "RECONCILING" | "READY" | "HALTED";
export type WorkerStreamState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "DEGRADED" | "RECONCILING";
export type FeatureContinuity = "HEALTHY" | "REBUILDING";

export type AlpacaWorkerSnapshot = {
  mode: "ALPACA_PAPER";
  workerState: WorkerState;
  symbol: string;
  feed: string;
  decisionTimeframe: "15Min";
  latestRawBarTimestamp: number | null;
  latestClosedDecisionBarTimestamp: number | null;
  latestDecisionId: string | null;
  strategy: "ema_trend";
  experimentArm: "C";
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
  connect(onUpdate: (update: Record<string, unknown>) => void, onError: (error: Error) => void): () => void;
}

export type AlpacaPaperWorkerOptions = {
  config: AlpacaConfig;
  store: AlpacaWorkerStore;
  broker: WorkerBroker;
  source?: MarketSource;
  tradeUpdates?: WorkerTradeUpdates;
  /** Makes exchange-session semantics injectable and deterministic in tests. */
  isRegularSession?: (timestamp: number) => boolean;
  now?: () => Date;
  /** Injectable bounded backoff for deterministic reconnect tests. */
  reconnectDelayMs?: (attempt: number) => number;
  sleep?: (milliseconds: number) => Promise<void>;
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
  paperEquityHighWater: null,
  lastPaperEquity: null,
  haltReason: null,
});

/** NYSE regular session, interpreted in America/New_York rather than host local time. */
export function isRegularUsEquitySession(timestamp: number): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = value("weekday");
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minuteOfDay = Number(value("hour")) * 60 + Number(value("minute"));
  // A 15:45–16:00 completed bar is a regular-session decision bar.
  return minuteOfDay >= 9 * 60 + 30 && minuteOfDay < 16 * 60;
}

export function deterministicDecisionId(timestamp: number): string {
  const identity = [ALPACA_WORKER_SYMBOL, ALPACA_WORKER_TIMEFRAME, timestamp, "ema_trend", "C", ALPACA_WORKER_CONFIG_VERSION].join("|");
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
  private disconnectTradeUpdates: (() => void) | null = null;
  private consuming = false;
  private marketReconnectScheduled = false;
  private marketReconnectAttempt = 0;
  private reconnectGeneration = 0;
  private requiresPaperEquityHighWaterRecovery = false;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: AlpacaPaperWorkerOptions) {
    this.options = options;
    if (options.config.paperBaseUrl !== "https://paper-api.alpaca.markets") throw new Error("LIVE_TRADING_FORBIDDEN");
    if (options.config.symbol !== ALPACA_WORKER_SYMBOL) throw new Error("ALPACA_WORKER_ONLY_SUPPORTS_SPY");
    this.key = `alpaca-paper:${options.config.symbol}:${ALPACA_WORKER_TIMEFRAME}:${ALPACA_WORKER_CONFIG_VERSION}`;
  }

  snapshot(): AlpacaWorkerSnapshot {
    return {
      mode: "ALPACA_PAPER", workerState: this.state, symbol: this.options.config.symbol, feed: this.options.config.dataFeed,
      decisionTimeframe: "15Min", latestRawBarTimestamp: this.checkpoint.latestRawBarTimestamp,
      latestClosedDecisionBarTimestamp: this.checkpoint.latestClosedDecisionBarTimestamp, latestDecisionId: this.checkpoint.latestDecisionId,
      strategy: "ema_trend", experimentArm: "C", riskState: this.riskState,
      brokerPosition: this.brokerPosition?.quantity ?? null,
      openOrderSummary: { count: this.openOrders.length, clientOrderIds: this.openOrders.map((order) => order.clientOrderId) },
      latestBrokerOrderState: this.latestBrokerOrderState, lastTradeUpdateTimestamp: this.lastTradeUpdateTimestamp,
      lastReconciliationTimestamp: this.checkpoint.lastReconciliationTimestamp, streamState: this.marketStreamState,
      marketStreamState: this.marketStreamState, tradeUpdateStreamState: this.tradeUpdateStreamState,
      featureContinuity: this.checkpoint.featureContinuity,
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
    await this.options.store.createRun(this.runId, this.state);
    const storedCheckpoint = await this.options.store.readCheckpoint(this.key);
    this.requiresPaperEquityHighWaterRecovery = storedCheckpoint !== null &&
      (typeof storedCheckpoint.paperEquityHighWater !== "number" || !Number.isFinite(storedCheckpoint.paperEquityHighWater));
    this.checkpoint = this.normalizeCheckpoint(storedCheckpoint ?? emptyCheckpoint());
    this.marketStreamState = this.checkpoint.marketStreamState;
    this.tradeUpdateStreamState = this.checkpoint.tradeUpdateStreamState;
    try {
      await this.reconcileInternal();
      this.state = "READY";
      // Durable bars may outlive a process that failed while atomically
      // creating their decision/intent pair. Re-evaluate them after broker
      // reconciliation; idempotent identity prevents duplicate dispatch.
      await this.processCompletedDecisionBars();
      await this.persistCheckpoint();
      this.connectTradeUpdates();
      this.startMarketConsumer();
    } catch (error) {
      await this.halt(error instanceof Error ? error.message : "STARTUP_RECONCILIATION_FAILED");
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.reconnectGeneration += 1;
    this.marketReconnectScheduled = false;
    this.disconnectTradeUpdates?.();
    this.disconnectTradeUpdates = null;
    this.marketStreamState = "DISCONNECTED";
    this.tradeUpdateStreamState = "DISCONNECTED";
    this.state = "STOPPED";
    await this.persistCheckpoint();
    if (this.runId) await this.options.store.updateRun(this.runId, this.state, null);
  }

  /** Server/CLI operator control. It never authorizes unknown resubmission. */
  async reconcile(): Promise<void> {
    if (this.state === "HALTED" || this.stopped) return;
    try {
      await this.reconcileInternal();
      this.state = "READY";
      await this.persistCheckpoint();
    } catch (error) {
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
    const inserted = await this.options.store.insertClosedBar(this.options.config.symbol, bar);
    if (!inserted) return;
    this.checkpoint.latestRawBarTimestamp = Math.max(this.checkpoint.latestRawBarTimestamp ?? 0, bar.t);
    await this.persistCheckpoint();
    await this.processCompletedDecisionBars();
  }

  private async processCompletedDecisionBars(): Promise<void> {
    const raw = await this.options.store.listClosedBars(this.options.config.symbol);
    if (raw.length === 0) return;
    const width = 15 * 60_000;
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
      const slots = Array.from({ length: 15 }, (_, index) => byTimestamp.get(start + index * 60_000));
      // Continuity is exchange-calendar semantics, not an injectable dispatch
      // test override. A test may veto dispatch without fabricating a gap.
      const regular = isRegularUsEquitySession(start);
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
        low: Math.min(...slots.map((slot) => slot!.low)), close: slots[14]!.close,
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
    // Decision evidence for a bucket must be calculated only from the current
    // contiguous run; no return, EMA, RSI, volatility, or trend bridges a gap.
    for (let index = 0; index < trailingContinuous.length; index += 1) {
      const decisionBar = trailingContinuous[index]!;
      const decisionId = deterministicDecisionId(decisionBar.t);
      const evidence = await this.decisionEvidence(trailingContinuous, index, decisionId);
      const inSession = (this.options.isRegularSession ?? isRegularUsEquitySession)(decisionBar.t);
      const dispatchEligible = inSession && evidence.features.warmupComplete;
      const intent: ExecutionIntent = {
        intentId: `${decisionId}:intent`, decisionId, createdAtBar: index, createdAtTimestamp: decisionBar.t,
        desiredAction: evidence.action, desiredPosition: evidence.targetPosition, status: dispatchEligible ? "PENDING" : "CANCELLED",
        executionModel: "ALPACA_PAPER", clientOrderId: deterministicClientOrderId(decisionId),
      };
      const blockReason = !inSession ? "OUTSIDE_REGULAR_SESSION" : !evidence.features.warmupComplete ? "FEATURE_CONTINUITY_REBUILDING" : null;
      const persisted = await this.options.store.persistDecisionAndIntent(evidence, intent, blockReason);
      if (!persisted.inserted) continue;
      this.checkpoint.latestClosedDecisionBarTimestamp = decisionBar.t;
      this.checkpoint.latestDecisionId = decisionId;
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

  private async decisionEvidence(candles: ClosedBar[], index: number, decisionId: string): Promise<Evidence> {
    await this.refreshPaperEquity();
    const features = computeFeatures(candles);
    const feature = features[index]!;
    const adapter = createMockJevAdapter();
    const signal = evaluateSignal("ema_trend", feature);
    const deterministicRegime = classifyDeterministicRegime(feature);
    const jevRequest = buildJevRequest(feature, adapter.model);
    const jevResponse = adapter.classify(feature);
    const policy = evaluatePolicy({ arm: "C", strategyId: "ema_trend", signal, detRegime: deterministicRegime, jev: jevResponse });
    const equityDrawdown = this.paperEquityDrawdown();
    if (equityDrawdown === null) throw new Error("PAPER_EQUITY_UNAVAILABLE");
    const risk = evaluateRisk({ desired: policy.desired, features: feature, equityDrawdown });
    const action = risk.target;
    return {
      id: decisionId, timestamp: feature.timestamp, barIndex: index, symbol: ALPACA_WORKER_SYMBOL, timeframe: ALPACA_WORKER_TIMEFRAME,
      tradingMode: "ALPACA_PAPER", marketSnapshot: candles[index]!, features: feature, strategyId: "ema_trend", strategyVersion: STRATEGY_VERSION,
      researchRefs: ["arXiv:1308.5658", "arXiv:2602.10785"], deterministicSignal: signal, deterministicRegime,
      jevRequest, jevResponse, policy, risk, action, targetPosition: action === "LONG" ? 1 : action === "SHORT" ? -1 : 0,
      abstained: policy.desired !== action || (action === "FLAT" && signal.desired !== "FLAT"),
    };
  }

  private async dispatch(intent: ExecutionIntent): Promise<void> {
    // Fresh broker reads are mandatory for every target. Local/replay position is never consulted.
    const position = await this.options.broker.position();
    if (position.symbol !== ALPACA_WORKER_SYMBOL || position.provenance !== "ALPACA_RECONCILED" || !Number.isFinite(position.quantity)) {
      throw new Error("BROKER_POSITION_RECONCILIATION_REQUIRED");
    }
    this.brokerPosition = position;
    await this.options.store.appendBrokerPosition(position);
    this.openOrders = await this.options.broker.openOrders();
    if (this.openOrders.length > 0) {
      // Conservative policy: never stack a new target behind any open SPY paper order.
      await this.options.store.putIntent(intent, "OPEN_ORDER_CONFLICT");
      return;
    }
    const reconciled = await this.options.broker.reconcile(intent);
    await this.recordBrokerState(intent, reconciled);
    if (reconciled.lookup === "FOUND" || reconciled.status === "UNKNOWN" || reconciled.status !== "PENDING") return;
    // This durable marker closes the crash window after a broker POST begins.
    // Restart reconciliation never treats it as fresh permission to resubmit.
    await this.options.store.putIntent({ ...intent, status: "SUBMISSION_ATTEMPTED" });
    const submitted = await this.options.broker.submit({ ...intent, status: reconciled.status }, position);
    await this.recordBrokerState(intent, submitted);
    if (submitted.status === "UNKNOWN") await this.halt("UNKNOWN_SUBMISSION_REQUIRES_RECOVERY");
  }

  private async reconcileInternal(): Promise<void> {
    this.state = "RECONCILING";
    await this.refreshPaperEquity();
    const position = await this.options.broker.position();
    if (position.symbol !== ALPACA_WORKER_SYMBOL || position.provenance !== "ALPACA_RECONCILED" || !Number.isFinite(position.quantity)) throw new Error("BROKER_POSITION_RECONCILIATION_REQUIRED");
    this.brokerPosition = position;
    await this.options.store.appendBrokerPosition(position);
    this.openOrders = await this.options.broker.openOrders();
    const intents = await this.options.store.listIntents();
    const knownClientIds = new Set(intents.map(({ intent }) => intent.clientOrderId ?? intent.intentId));
    const unknownOpenOrder = this.openOrders.find((order) => !knownClientIds.has(order.clientOrderId));
    if (unknownOpenOrder) throw new Error(`CONTRADICTORY_OPEN_BROKER_ORDER:${unknownOpenOrder.clientOrderId || "MISSING_CLIENT_ORDER_ID"}`);
    for (const stored of intents) {
      if (terminal(stored.intent.status)) continue;
      const state = await this.options.broker.reconcile(stored.intent);
      await this.recordBrokerState(stored.intent, state, stored.dispatchBlockReason);
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

  private async recordBrokerState(intent: ExecutionIntent, state: BrokerOrderState, blockReason: string | null = null): Promise<void> {
    const updated = { ...intent, status: state.status, clientOrderId: state.clientOrderId };
    this.latestBrokerOrderState = state.status;
    await this.options.store.putIntent(updated, blockReason);
    await this.options.store.appendBrokerOrder(state);
  }

  private connectTradeUpdates(): void {
    if (!this.options.tradeUpdates || this.disconnectTradeUpdates || this.stopped) return;
    this.tradeUpdateStreamState = "CONNECTING";
    this.disconnectTradeUpdates = this.options.tradeUpdates.connect(
      (update) => { void this.processTradeUpdate(update); },
      (error) => { void this.handleTradeStreamError(error); },
    );
    this.tradeUpdateStreamState = "CONNECTED";
    void this.persistCheckpoint();
  }

  async processTradeUpdate(update: Record<string, unknown>): Promise<void> {
    const data = update.data as Record<string, unknown> | undefined;
    const order = data?.order as Record<string, unknown> | undefined;
    const clientOrderId = order ? String(order.client_order_id ?? "") || null : null;
    await this.options.store.appendTradeUpdate(update, clientOrderId);
    this.lastTradeUpdateTimestamp = (this.options.now ?? (() => new Date()))().toISOString();
    if (!clientOrderId) return this.persistCheckpoint();
    const stored = (await this.options.store.listIntents()).find(({ intent }) => (intent.clientOrderId ?? intent.intentId) === clientOrderId);
    if (stored) {
      const state = brokerStateFromTradeUpdate(update, stored.intent);
      if (state) await this.recordBrokerState(stored.intent, state, stored.dispatchBlockReason);
    }
    await this.persistCheckpoint();
  }

  async handleTradeStreamError(_error: Error): Promise<void> {
    if (this.stopped || this.state === "HALTED") return;
    this.tradeUpdateStreamState = "DEGRADED";
    this.disconnectTradeUpdates?.();
    this.disconnectTradeUpdates = null;
    await this.persistCheckpoint();
    // Reconciliation is required before reconnect; missed events are never assumed absent.
    await this.reconcile();
    if (this.state === "READY" && !this.stopped) this.connectTradeUpdates();
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
    const account = await this.options.broker.account();
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
      paperEquityHighWater: Number.isFinite(checkpoint.paperEquityHighWater) ? checkpoint.paperEquityHighWater : null,
      lastPaperEquity: Number.isFinite(checkpoint.lastPaperEquity) ? checkpoint.lastPaperEquity : null,
    };
  }

  private async halt(reason: string): Promise<void> {
    this.state = "HALTED";
    this.reconnectGeneration += 1;
    this.marketReconnectScheduled = false;
    this.checkpoint.haltReason = reason;
    this.marketStreamState = "DEGRADED";
    this.tradeUpdateStreamState = "DEGRADED";
    await this.persistCheckpoint();
    if (this.runId) await this.options.store.updateRun(this.runId, this.state, reason);
  }

  private async persistCheckpoint(): Promise<void> {
    this.checkpoint.streamState = this.marketStreamState;
    this.checkpoint.marketStreamState = this.marketStreamState;
    this.checkpoint.tradeUpdateStreamState = this.tradeUpdateStreamState;
    await this.options.store.writeCheckpoint(this.key, this.checkpoint);
  }
}

const globalRef = globalThis as typeof globalThis & { __alpacaPaperWorker__?: Promise<AlpacaPaperWorker> };

/** Runtime singleton: React requests observe one worker, never create one each. */
export function getAlpacaPaperWorker(): Promise<AlpacaPaperWorker> {
  globalRef.__alpacaPaperWorker__ ??= (async () => {
    const config = loadAlpacaConfig();
    const worker = new AlpacaPaperWorker({
      config, store: new SqlAlpacaWorkerStore(), broker: new AlpacaPaperBroker(config),
      source: new AlpacaMarketSource(config), tradeUpdates: new AlpacaPaperTradeUpdates(config),
    });
    await worker.start();
    return worker;
  })().catch((error) => {
    globalRef.__alpacaPaperWorker__ = undefined;
    throw error;
  });
  return globalRef.__alpacaPaperWorker__;
}

/** Read-only operator status; unlike getAlpacaPaperWorker it does not start work. */
export async function readAlpacaPaperWorkerSnapshot(): Promise<AlpacaWorkerSnapshot | null> {
  const worker = await globalRef.__alpacaPaperWorker__;
  return worker?.snapshot() ?? null;
}

/** Exported solely for focused test fixtures; application runtime uses SQL. */
export { MemoryAlpacaWorkerStore };
