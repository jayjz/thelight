import { recursiveEma, rsiSma } from "./features.ts";
import type { ClosedBar } from "./types.ts";

export const EMA_RSI_V1_ID = "ema_rsi_v1" as const;
export const EMA_RSI_V1_VERSION = "v1" as const;
export const EMA_RSI_V1_TIMEFRAME = "1Min" as const;
export const EMA_RSI_V1_WARMUP_BARS = 21;

export type TargetPosition = 0 | 1;

export type StrategyDecision = {
  targetPosition: TargetPosition;
  reason: string;
  features: Record<string, number | string | boolean>;
};

export interface TradingStrategy {
  readonly id: string;
  readonly version: string;
  readonly timeframe: "1Min" | "15Min";
  readonly warmupBars: number;
  evaluate(input: { completedBars: readonly ClosedBar[]; priorTarget: TargetPosition }): StrategyDecision;
}

/**
 * Deterministic, long/flat-only short-horizon strategy. EMA values are seeded
 * at the first closed price and RSI is the existing SMA-of-gains/losses RSI.
 * A decision is eligible only after 21 consecutive completed one-minute bars.
 */
export const emaRsiV1Strategy: TradingStrategy = {
  id: EMA_RSI_V1_ID,
  version: EMA_RSI_V1_VERSION,
  timeframe: EMA_RSI_V1_TIMEFRAME,
  warmupBars: EMA_RSI_V1_WARMUP_BARS,
  evaluate({ completedBars, priorTarget }) {
    const closes = completedBars.map((bar) => bar.close);
    const sourceBar = completedBars.at(-1);
    if (!sourceBar || completedBars.length < EMA_RSI_V1_WARMUP_BARS) {
      return {
        targetPosition: priorTarget,
        reason: "Warmup incomplete: requires 21 consecutive completed 1-minute bars.",
        features: { warmupComplete: false, completedBarCount: completedBars.length },
      };
    }

    const ema9 = recursiveEma(closes, 2 / (9 + 1)).at(-1)!;
    const ema21 = recursiveEma(closes, 2 / (21 + 1)).at(-1)!;
    const rsi14 = rsiSma(closes, 14).at(-1)!;
    const features = {
      warmupComplete: true,
      completedBarCount: completedBars.length,
      sourceBarTimestamp: sourceBar.t,
      ema9,
      ema21,
      rsi14,
    };

    if (ema9 > ema21 && rsi14 > 50) {
      return { targetPosition: 1, reason: "EMA9 > EMA21 and RSI14 > 50.", features };
    }
    if (ema9 < ema21) {
      return { targetPosition: 0, reason: "EMA9 < EMA21.", features };
    }
    if (rsi14 < 45) {
      return { targetPosition: 0, reason: "RSI14 < 45.", features };
    }
    return { targetPosition: priorTarget, reason: "Neutral band: retaining prior target.", features };
  },
};
