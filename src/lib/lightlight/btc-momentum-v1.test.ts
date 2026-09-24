import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BTC_MOMENTUM_V1_CONFIG,
  BTC_MOMENTUM_V1_WARMUP_BARS,
  evaluateBtcMomentumV1,
  FLAT_BTC_MOMENTUM_STATE,
} from "./btc-momentum-v1.ts";
import {
  assertConsecutiveBtcBars,
  evaluateBtcResearchStrategy,
  runBtcShortHorizonResearch,
} from "./btc-research.ts";
import type { ClosedBar } from "./types.ts";

function bars(prices: number[]): ClosedBar[] {
  const start = Math.floor(1_726_000_000_000 / 60_000) * 60_000;
  return prices.map((close, index) => ({
    t: start + index * 60_000,
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    volume: 100 + index,
  }));
}
function trendingBars(length = 100, step = 0.002): ClosedBar[] {
  return bars(Array.from({ length }, (_, index) => 100_000 * Math.exp(index * step)));
}

describe("btc_momentum_v1", () => {
  it("does not trade on an EMA crossover unless movement also clears noise and cost gates", () => {
    const decision = evaluateBtcMomentumV1(trendingBars(BTC_MOMENTUM_V1_WARMUP_BARS, 0.00004), FLAT_BTC_MOMENTUM_STATE);
    assert.equal(decision.targetPosition, 0);
    assert.equal(decision.features.costHurdleBps, BTC_MOMENTUM_V1_CONFIG.roundTripCostHurdleBps);
    assert.equal(decision.features.momentumValid, false);
  });

  it("is causal: future bars cannot alter a decision made from an earlier prefix", () => {
    const original = trendingBars(90);
    const before = evaluateBtcMomentumV1(original.slice(0, 50), FLAT_BTC_MOMENTUM_STATE);
    const perturbedFuture = original.slice();
    for (let index = 50; index < perturbedFuture.length; index++) {
      perturbedFuture[index] = { ...perturbedFuture[index]!, close: 1, high: 1, low: 1, open: 1 };
    }
    const after = evaluateBtcMomentumV1(perturbedFuture.slice(0, 50), FLAT_BTC_MOMENTUM_STATE);
    assert.deepEqual(after, before);
  });

  it("rejects missing timestamps instead of silently repairing them", () => {
    const gap = trendingBars(30);
    gap.splice(10, 1);
    assert.throws(() => assertConsecutiveBtcBars(gap), /EXACT_CONSECUTIVE/);
  });

  it("fills a BTC research decision only on the next completed bar", () => {
    const run = evaluateBtcResearchStrategy(trendingBars(100), "btc_momentum_baseline_v1", {
      id: "fees_only", feeBpsPerSide: 0, spreadBpsPerSide: 0, slippageBpsPerSide: 0,
    });
    const entryDecision = run.decisions.find((decision) => decision.targetPosition === 1)!;
    assert.equal(run.trades[0]?.entryBarIndex, entryDecision.barIndex + 1);
  });

  it("reports flat, baseline, and candidate under all fixed cost scenarios", () => {
    const result = runBtcShortHorizonResearch(trendingBars(100), "FIXTURE");
    assert.equal(result.strategies.flat.length, 4);
    assert.equal(result.strategies.btc_momentum_baseline_v1.length, 4);
    assert.equal(result.strategies.btc_momentum_v1.length, 4);
    const candidate = result.strategies.btc_momentum_v1;
    assert.ok(candidate[3]!.metrics.netPnl <= candidate[3]!.metrics.grossPnl);
  });
});
