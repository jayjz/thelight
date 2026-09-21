import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALPACA_PAPER_BASE_URL, type AlpacaConfig, type BrokerAccountSnapshot, type BrokerOrderState, type BrokerPositionSnapshot, type HistoricalStockBars, type OpenBrokerOrder } from "./alpaca.server.ts";
import { AlpacaPaperWorker, MemoryAlpacaWorkerStore } from "./alpaca-worker.server.ts";
import { EMA_RSI_V1_WARMUP_BARS, emaRsiV1Strategy } from "./ema-rsi-v1.ts";
import type { ExecutionIntent } from "./types.ts";

const config: AlpacaConfig = {
  apiKeyId: "key", apiSecretKey: "secret", paperBaseUrl: ALPACA_PAPER_BASE_URL,
  dataBaseUrl: "https://data.alpaca.markets", dataFeed: "iex", symbol: "SPY",
};

const start = Date.parse("2026-09-21T13:30:00.000Z"); // Monday 09:30 ET
const bar = (index: number, close: number) => ({ t: start + index * 60_000, open: close - 0.1, high: close + 0.2, low: close - 0.2, close, volume: 100 });
const risingBars = (count = EMA_RSI_V1_WARMUP_BARS + 3) => Array.from({ length: count }, (_, index) => bar(index, 100 + index));

class Broker {
  posts = 0;
  async account(): Promise<BrokerAccountSnapshot> { return { equity: 100_000, reconciledAt: "2026-09-21T13:30:00.000Z", provenance: "ALPACA_PAPER_ACCOUNT" }; }
  async position(): Promise<BrokerPositionSnapshot> { return { symbol: "SPY", quantity: 0, reconciledAt: "2026-09-21T13:30:00.000Z", provenance: "ALPACA_RECONCILED" }; }
  async openOrders(): Promise<OpenBrokerOrder[]> { return []; }
  async reconcile(intent: ExecutionIntent): Promise<BrokerOrderState> {
    return { decisionId: intent.decisionId, intentId: intent.intentId, clientOrderId: intent.clientOrderId ?? intent.intentId, brokerOrderId: null, status: "PENDING", updatedAt: null, rawStatus: null, lookup: "ABSENT" };
  }
  async submit(intent: ExecutionIntent): Promise<BrokerOrderState> {
    this.posts += 1;
    return { decisionId: intent.decisionId, intentId: intent.intentId, clientOrderId: intent.clientOrderId ?? intent.intentId, brokerOrderId: `order-${this.posts}`, status: "ACCEPTED", updatedAt: "2026-09-21T14:00:00.000Z", rawStatus: "accepted", lookup: "FOUND" };
  }
}

function decision(bars: ReturnType<typeof risingBars>, priorTarget: 0 | 1 = 0) {
  return emaRsiV1Strategy.evaluate({ completedBars: bars, priorTarget });
}

describe("ema_rsi_v1 deterministic strategy", () => {
  it("has explicit deterministic warmup and never reads beyond the completed prefix", () => {
    const incomplete = decision(risingBars(EMA_RSI_V1_WARMUP_BARS - 1));
    assert.equal(incomplete.features.warmupComplete, false);
    assert.equal(incomplete.targetPosition, 0);

    const prefix = risingBars();
    const before = decision(prefix);
    const withFuture = [...prefix, ...Array.from({ length: 20 }, (_, index) => bar(100 + index, 10_000 - index))];
    const after = emaRsiV1Strategy.evaluate({ completedBars: withFuture.slice(0, prefix.length), priorTarget: 0 });
    assert.deepEqual(after, before, "future bars cannot affect an earlier completed-bar decision");
  });

  it("goes LONG only when EMA9 exceeds EMA21 and RSI14 exceeds 50", () => {
    const result = decision(risingBars());
    assert.ok((result.features.ema9 as number) > (result.features.ema21 as number));
    assert.ok((result.features.rsi14 as number) > 50);
    assert.equal(result.targetPosition, 1);
  });

  it("goes FLAT when EMA9 is below EMA21 or RSI14 is below 45", () => {
    const falling = Array.from({ length: EMA_RSI_V1_WARMUP_BARS + 2 }, (_, index) => bar(index, 200 - index));
    const emaFlat = emaRsiV1Strategy.evaluate({ completedBars: falling, priorTarget: 1 });
    assert.equal(emaFlat.targetPosition, 0);
    assert.match(emaFlat.reason, /EMA9 < EMA21/);

    // A fast rise followed by a short loss sequence keeps EMA9 above EMA21
    // while the 14-period RSI falls through the explicit exit threshold.
    const rsiExit = [
      ...Array.from({ length: 21 }, (_, index) => bar(index, 100 + index)),
      ...Array.from({ length: 14 }, (_, index) => bar(21 + index, 119 - index * 2)),
    ];
    const rsiFlat = emaRsiV1Strategy.evaluate({ completedBars: rsiExit, priorTarget: 1 });
    assert.equal(rsiFlat.targetPosition, 0);
    assert.ok((rsiFlat.features.rsi14 as number) < 45);
  });

  it("retains the current target in the neutral band", () => {
    const neutral = Array.from({ length: 21 }, (_, index) => bar(index, 100));
    const result = emaRsiV1Strategy.evaluate({ completedBars: neutral, priorTarget: 1 });
    assert.equal(result.targetPosition, 1);
    assert.match(result.reason, /Neutral band/);
  });
});

describe("ema_rsi_v1 PAPER worker gates", () => {
  async function createWorker(input: { inSession?: boolean; now?: () => Date; historicalBars?: HistoricalStockBars } = {}) {
    const store = new MemoryAlpacaWorkerStore();
    const broker = new Broker();
    const worker = new AlpacaPaperWorker({
      config, store, broker, arm: "ema_rsi_v1", isRegularSession: () => input.inSession ?? true,
      now: input.now, historicalBars: input.historicalBars,
    });
    await worker.start();
    return { store, broker, worker };
  }

  it("uses only completed 1-minute bars, records immutable target evidence, and deduplicates a bucket", async () => {
    let now = start + 60_000;
    const { store, broker, worker } = await createWorker({ now: () => new Date(now) });
    const bars = risingBars();
    for (const current of bars) { now = current.t + 60_000; await worker.processRawBar(current); }
    const firstCount = store.decisionCount();
    const firstPosts = broker.posts;
    await worker.processRawBar(bars.at(-1)!);
    assert.equal(store.decisionCount(), firstCount, "the same completed 1m bucket cannot create a second decision/intent");
    assert.equal(broker.posts, firstPosts);
    const evidence = store.decisionEvidence().at(-1)!;
    assert.equal(evidence.strategyId, "ema_rsi_v1");
    assert.equal(evidence.timeframe, "1Min");
    assert.equal(evidence.strategyDecision?.sourceBarTimestamp, bars.at(-1)!.t);
    assert.equal(evidence.strategyDecision?.runtime.workerKey, "alpaca-paper:SPY:1Min:ema-rsi-v1-paper-worker-v1");
    assert.equal(evidence.jevRequest, undefined, "the arm has no Jev/TypeSafe evaluation");
  });

  it("does not create a decision for an incomplete minute and blocks recovery/rebuilding dispatch", async () => {
    let now = start + 60_000;
    const historical: HistoricalStockBars = { bars: async () => [] };
    const { store, broker, worker } = await createWorker({ now: () => new Date(now), historicalBars: historical });
    const bars = risingBars(EMA_RSI_V1_WARMUP_BARS + 4);
    for (const current of bars.slice(0, EMA_RSI_V1_WARMUP_BARS)) { now = current.t + 60_000; await worker.processRawBar(current); }
    const beforeGapDecisions = store.decisionCount();
    const beforeGapPosts = broker.posts;
    now = bars[EMA_RSI_V1_WARMUP_BARS + 1]!.t + 60_000;
    await worker.processRawBar(bars[EMA_RSI_V1_WARMUP_BARS + 1]!); // skips one 1m bucket
    assert.equal(store.decisionCount(), beforeGapDecisions, "a gap leaves the missing minute without a decision");
    assert.equal(broker.posts, beforeGapPosts, "rebuilding recovery cannot dispatch");
    assert.equal(worker.snapshot().recoveryState, "REBUILDING");
  });

  it("blocks outside RTH and stale live bars before broker dispatch", async () => {
    const outside = await createWorker({ inSession: false, now: () => new Date(start + 25 * 60_000) });
    for (const current of risingBars()) await outside.worker.processRawBar(current);
    assert.equal(outside.broker.posts, 0);
    assert.ok((await outside.store.listIntents("SPY", outside.worker.snapshot().workerKey)).some((row) => row.dispatchBlockReason === "OUTSIDE_REGULAR_SESSION"));

    const stale = await createWorker({ now: () => new Date(start + 60 * 60_000) });
    for (const current of risingBars()) await stale.worker.processRawBar(current);
    assert.equal(stale.broker.posts, 0);
    assert.ok((await stale.store.listIntents("SPY", stale.worker.snapshot().workerKey)).some((row) => row.dispatchBlockReason === "LATEST_LIVE_BAR_STALE"));
  });
});
