import { THRESHOLDS } from "./thresholds.ts";
import { sampleStd } from "./features.ts";
import type {
  Candle,
  Evidence,
  ExecutionLedger,
  JevEvalMetrics,
  PathMetrics,
} from "./types.ts";

export function computePathMetrics(
  candles: Candle[],
  evidences: Evidence[],
  ledger: ExecutionLedger,
  execution: { transactionCostBps: number; slippageBps: number } = THRESHOLDS,
): PathMetrics {
  // Decision evidence explains an intent; it is never used to rebuild a
  // position here. The ledger is the sole accounting chronology.
  const rets = ledger.equity.slice(1).map((point) => point.periodReturn);
  let peak = 1;
  let maxDd = 0;
  for (const point of ledger.equity) {
    peak = Math.max(peak, point.equity);
    maxDd = Math.max(maxDd, peak === 0 ? 0 : (peak - point.equity) / peak);
  }

  const mu = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd = sampleStd(rets);
  const down = sampleStd(rets.filter((x) => x < 0));
  const ann = Math.sqrt(252);
  const sharpe = sd > 0 ? (mu / sd) * ann : null;
  const sortino = down > 0 ? (mu / down) * ann : null;
  const T = Math.max(1, ledger.equity.length - 1);
  const turnover = ledger.transitions.reduce((sum, transition) => sum + transition.turnover, 0);
  const exposure = ledger.equity
    .slice(1)
    .reduce((sum, point) => sum + Math.abs(point.positionApplied), 0);

  return {
    barCount: candles.length,
    tradeCount: ledger.transitions.length,
    hitRate: null,
    totalReturn: ledger.finalEquity - 1,
    sharpe,
    sortino,
    maxDrawdown: maxDd,
    turnover: turnover / T,
    exposure: exposure / T,
    transactionCostBps: execution.transactionCostBps,
    slippageBps: execution.slippageBps,
    transactionCosts: ledger.totalTransactionCost,
    slippageCosts: ledger.totalSlippage,
    abstainedCount: evidences.filter((e) => e.abstained).length,
    note: "In-sample on synthetic seeded candles. Metrics consume the NEXT_BAR_CLOSE execution ledger. Not walk-forward or a performance claim.",
  };
}

function oneHot(choice: string, keys: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k of keys) o[k] = k === choice ? 1 : 0;
  return o;
}

function outcomeRegime(
  candles: Candle[],
  i: number,
  horizon: number,
): string {
  if (i + horizon >= candles.length) return "ambiguous";
  const p0 = candles[i]!.close;
  const p1 = candles[i + horizon]!.close;
  const r = Math.log(p1 / p0);
  if (r > 0.015) return "trend_up";
  if (r < -0.015) return "trend_down";
  const mid = candles[i + Math.floor(horizon / 2)]!.close;
  const d0 = Math.abs(Math.log(p0 / mid));
  const d1 = Math.abs(Math.log(p1 / mid));
  if (d1 < d0 * 0.7) return "mean_reverting";
  return "ambiguous";
}

export function computeJevMetrics(
  candles: Candle[],
  evidences: Evidence[],
): JevEvalMetrics {
  const keys = ["trend_up", "trend_down", "mean_reverting", "ambiguous"];
  let brierSum = 0;
  let brierN = 0;
  const buckets = [
    { lo: 0, hi: 0.25, n: 0, hit: 0, pSum: 0, ySum: 0 },
    { lo: 0.25, hi: 0.5, n: 0, hit: 0, pSum: 0, ySum: 0 },
    { lo: 0.5, hi: 0.75, n: 0, hit: 0, pSum: 0, ySum: 0 },
    { lo: 0.75, hi: 1.01, n: 0, hit: 0, pSum: 0, ySum: 0 },
  ];
  const confBuckets = [
    { lo: 0, hi: 0.33, n: 0, hit: 0 },
    { lo: 0.33, hi: 0.66, n: 0, hit: 0 },
    { lo: 0.66, hi: 1.01, n: 0, hit: 0 },
  ];
  const byPredictedRegime: Record<string, { n: number; sum: number }> = {};
  for (const k of keys) byPredictedRegime[k] = { n: 0, sum: 0 };

  for (const e of evidences) {
    if (!e.features.warmupComplete) continue;
    const y = outcomeRegime(
      candles,
      e.barIndex,
      THRESHOLDS.regimeOutcomeHorizon,
    );
    const p = e.jevResponse.answers.REGIME.probabilities;
    const yoh = oneHot(y, keys);
    let b = 0;
    for (const k of keys) {
      const pk = p[k] ?? 0;
      b += (pk - (yoh[k] ?? 0)) ** 2;
    }
    brierSum += b;
    brierN += 1;
    const pChosen = p[e.jevResponse.answers.REGIME.choice] ?? 0;
    const hit = e.jevResponse.answers.REGIME.choice === y ? 1 : 0;
    for (const bucket of buckets) {
      if (pChosen >= bucket.lo && pChosen < bucket.hi) {
        bucket.n += 1;
        bucket.hit += hit;
        bucket.pSum += pChosen;
        bucket.ySum += hit;
      }
    }
    const c = e.jevResponse.answers.REGIME.confidence;
    for (const bucket of confBuckets) {
      if (c >= bucket.lo && c < bucket.hi) {
        bucket.n += 1;
        bucket.hit += hit;
      }
    }
    const nxt =
      e.barIndex + 1 < candles.length
        ? Math.log(candles[e.barIndex + 1]!.close / candles[e.barIndex]!.close)
        : 0;
    // This is a prediction diagnostic: the next market return conditional on
    // the predicted regime. It intentionally does not apply a decision action
    // and is not an execution or strategy-return measure.
    const slot = byPredictedRegime[e.jevResponse.answers.REGIME.choice];
    if (slot) {
      slot.n += 1;
      slot.sum += nxt;
    }
  }

  const calibrationBuckets = buckets.map((b) => ({
    p: b.n ? b.pSum / b.n : 0,
    freq: b.n ? b.ySum / b.n : 0,
    n: b.n,
  }));

  const selectiveAccuracy = [0.5, 0.7, 0.9].map((coverage) => {
    const ranked = evidences
      .filter((e) => e.features.warmupComplete)
      .slice()
      .sort(
        (a, b) =>
          b.jevResponse.answers.REGIME.confidence -
          a.jevResponse.answers.REGIME.confidence,
      );
    const take = Math.max(1, Math.floor(ranked.length * coverage));
    const slice = ranked.slice(0, take);
    let hit = 0;
    for (const e of slice) {
      const y = outcomeRegime(
        candles,
        e.barIndex,
        THRESHOLDS.regimeOutcomeHorizon,
      );
      if (e.jevResponse.answers.REGIME.choice === y) hit += 1;
    }
    return { coverage, accuracy: slice.length ? hit / slice.length : 0 };
  });

  return {
    brierRegime: brierN ? brierSum / brierN : null,
    calibrationBuckets,
    confidenceBuckets: confBuckets.map((b) => ({
      lo: b.lo,
      hi: b.hi,
      n: b.n,
      hit: b.n ? b.hit / b.n : 0,
    })),
    selectiveAccuracy,
    decisionsAbstained: evidences.filter((e) => e.abstained).length,
    byPredictedRegime: Object.fromEntries(
      Object.entries(byPredictedRegime).map(([k, v]) => [
        k,
        { n: v.n, meanNextBarMarketReturn: v.n ? v.sum / v.n : 0 },
      ]),
    ),
    note: "Jev metrics vs our proxy regime outcome (next-5-bar return/displacement). byPredictedRegime is a next-bar market-outcome diagnostic, independent of fills or execution. Mock adapter, not TypeSafe Jev. Not a calibration of the live model.",
  };
}
