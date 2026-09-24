import { logReturn, recursiveEma, rollingStd } from "./features.ts";
import type { ClosedBar } from "./types.ts";

/**
 * Frozen engineering hypothesis for a long/flat BTC/USD minute-bar experiment.
 * These are deliberately not fitted to LIGHTLIGHT data. The cost gate is set
 * before evaluation to the conservative combined-cost scenario in the research
 * runner, so an EMA cross by itself can never create an entry.
 */
export const BTC_MOMENTUM_V1_ID = "btc_momentum_v1" as const;
export const BTC_MOMENTUM_V1_VERSION = "v1" as const;
export const BTC_MOMENTUM_V1_CONFIG = Object.freeze({
  timeframe: "1Min" as const,
  momentumLookbackBars: 5,
  fastEmaSpan: 8,
  slowEmaSpan: 21,
  realizedVolWindowBars: 20,
  minimumMomentumBps: 70,
  momentumNoiseMultiple: 1.5,
  minimumEmaSpreadBps: 3,
  roundTripCostHurdleBps: 60,
  minimumHoldBars: 2,
  maximumHoldBars: 30,
  trailingStopVolMultiple: 2,
  minimumTrailingStopBps: 12,
});

export const BTC_MOMENTUM_V1_WARMUP_BARS = Math.max(
  BTC_MOMENTUM_V1_CONFIG.slowEmaSpan,
  BTC_MOMENTUM_V1_CONFIG.realizedVolWindowBars + 1,
  BTC_MOMENTUM_V1_CONFIG.momentumLookbackBars + 1,
);

export type BtcTargetPosition = 0 | 1;

export type BtcMomentumState = {
  targetPosition: BtcTargetPosition;
  barsHeld: number;
  highWaterClose: number | null;
};

export type BtcMomentumDecision = {
  targetPosition: BtcTargetPosition;
  nextState: BtcMomentumState;
  reason: string;
  features: Record<string, number | boolean | string>;
};

export const FLAT_BTC_MOMENTUM_STATE: BtcMomentumState = Object.freeze({
  targetPosition: 0,
  barsHeld: 0,
  highWaterClose: null,
});

function finiteBars(bars: readonly ClosedBar[]): void {
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]!;
    if (
      bar.t % 60_000 !== 0 ||
      !Number.isFinite(bar.close) ||
      bar.close <= 0 ||
      (i > 0 && bar.t !== bars[i - 1]!.t + 60_000)
    ) {
      throw new Error("BTC_MOMENTUM_V1_REQUIRES_CONSECUTIVE_COMPLETED_MINUTE_BARS");
    }
  }
}

function bps(value: number): number {
  return value * 10_000;
}

/** Pure and causal: only the supplied completed-bar prefix is inspected. */
export function evaluateBtcMomentumV1(
  completedBars: readonly ClosedBar[],
  prior: BtcMomentumState = FLAT_BTC_MOMENTUM_STATE,
): BtcMomentumDecision {
  finiteBars(completedBars);
  const source = completedBars.at(-1);
  if (!source || completedBars.length < BTC_MOMENTUM_V1_WARMUP_BARS) {
    return {
      targetPosition: prior.targetPosition,
      nextState: prior,
      reason: "Warmup: requires 21 consecutive completed BTC/USD minute bars.",
      features: { warmupComplete: false, completedBarCount: completedBars.length },
    };
  }

  const closes = completedBars.map((bar) => bar.close);
  const returns = closes.map((close, index) =>
    index === 0 ? 0 : logReturn(closes[index - 1]!, close),
  );
  const fastEma = recursiveEma(closes, 2 / (BTC_MOMENTUM_V1_CONFIG.fastEmaSpan + 1)).at(-1)!;
  const slowEma = recursiveEma(closes, 2 / (BTC_MOMENTUM_V1_CONFIG.slowEmaSpan + 1)).at(-1)!;
  const realizedVol = rollingStd(returns, BTC_MOMENTUM_V1_CONFIG.realizedVolWindowBars).at(-1)!;
  const lookbackClose = closes.at(-(BTC_MOMENTUM_V1_CONFIG.momentumLookbackBars + 1))!;
  const momentum = logReturn(lookbackClose, source.close);
  const momentumBps = bps(momentum);
  const emaSpreadBps = bps((fastEma - slowEma) / source.close);
  const noiseFloorBps = bps(
    BTC_MOMENTUM_V1_CONFIG.momentumNoiseMultiple *
      realizedVol *
      Math.sqrt(BTC_MOMENTUM_V1_CONFIG.momentumLookbackBars),
  );
  const requiredMoveBps = Math.max(
    BTC_MOMENTUM_V1_CONFIG.minimumMomentumBps,
    noiseFloorBps,
    BTC_MOMENTUM_V1_CONFIG.roundTripCostHurdleBps,
  );
  const trailingStopBps = Math.max(
    BTC_MOMENTUM_V1_CONFIG.minimumTrailingStopBps,
    bps(BTC_MOMENTUM_V1_CONFIG.trailingStopVolMultiple * realizedVol),
  );
  const highWaterClose = prior.targetPosition === 1
    ? Math.max(prior.highWaterClose ?? source.close, source.close)
    : source.close;
  const trailingStopHit = prior.targetPosition === 1 &&
    source.close <= highWaterClose * (1 - trailingStopBps / 10_000);
  const trendValid = fastEma > slowEma && emaSpreadBps >= BTC_MOMENTUM_V1_CONFIG.minimumEmaSpreadBps;
  const momentumValid = momentumBps >= requiredMoveBps;
  const invalidated = momentumBps <= 0 || fastEma <= slowEma;
  const heldBars = prior.targetPosition === 1 ? prior.barsHeld + 1 : 0;
  const features = {
    warmupComplete: true,
    completedBarCount: completedBars.length,
    sourceBarTimestamp: source.t,
    momentumBps,
    fastEma,
    slowEma,
    emaSpreadBps,
    realizedVol,
    noiseFloorBps,
    requiredMoveBps,
    costHurdleBps: BTC_MOMENTUM_V1_CONFIG.roundTripCostHurdleBps,
    trendValid,
    momentumValid,
    barsHeld: heldBars,
    highWaterClose,
    trailingStopBps,
    trailingStopHit,
  };

  if (prior.targetPosition === 0) {
    if (trendValid && momentumValid) {
      return {
        targetPosition: 1,
        nextState: { targetPosition: 1, barsHeld: 0, highWaterClose: source.close },
        reason: "Enter: 5-minute momentum clears noise and 60bp round-trip hurdle with positive EMA confirmation.",
        features,
      };
    }
    return {
      targetPosition: 0,
      nextState: FLAT_BTC_MOMENTUM_STATE,
      reason: "Hold flat: momentum, trend, noise, or cost-hurdle gate not met.",
      features,
    };
  }

  const minimumHoldComplete = heldBars >= BTC_MOMENTUM_V1_CONFIG.minimumHoldBars;
  if (trailingStopHit) {
    return {
      targetPosition: 0,
      nextState: FLAT_BTC_MOMENTUM_STATE,
      reason: "Exit: volatility-scaled trailing stop.",
      features,
    };
  }
  if (heldBars >= BTC_MOMENTUM_V1_CONFIG.maximumHoldBars) {
    return {
      targetPosition: 0,
      nextState: FLAT_BTC_MOMENTUM_STATE,
      reason: "Exit: 30-minute maximum holding-time stop.",
      features,
    };
  }
  if (minimumHoldComplete && invalidated) {
    return {
      targetPosition: 0,
      nextState: FLAT_BTC_MOMENTUM_STATE,
      reason: "Exit: momentum or EMA trend invalidation after minimum hold.",
      features,
    };
  }
  return {
    targetPosition: 1,
    nextState: { targetPosition: 1, barsHeld: heldBars, highWaterClose },
    reason: "Hold: deterministic momentum state remains valid.",
    features,
  };
}
