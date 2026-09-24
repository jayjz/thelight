import { emaRsiV1Strategy, type TradingStrategy } from "./ema-rsi-v1.ts";
import { computeFeatures } from "./features.ts";
import type { ClosedBar } from "./types.ts";
export const EMA_RSI_V2_CONFIG = Object.freeze({
  version: "v2",
  windowBars: 23,
  featureWarmup: 21,
  warmupBars: 22,
  entryStrength: 0.5,
  exitStrength: -0.25,
  confirmationBars: 2,
  entryRsi: 50,
  exitRsi: 45,
});
/** Matches the audited finite-seed PAPER V1 feature horizon. */
export function crossoverFeatures(bars: readonly ClosedBar[]) {
  const window = bars.slice(-EMA_RSI_V2_CONFIG.windowBars);
  const v1 = emaRsiV1Strategy.evaluate({ completedBars: window, priorTarget: 0 });
  const f = computeFeatures(window).at(-1);
  const ema9 = typeof v1.features.ema9 === "number" ? v1.features.ema9 : null;
  const ema21 = typeof v1.features.ema21 === "number" ? v1.features.ema21 : null;
  const rsi14 = typeof v1.features.rsi14 === "number" ? v1.features.rsi14 : null;
  const close = window.at(-1)?.close ?? 0;
  const realizedVolatility = f && Number.isFinite(f.realizedVol) ? f.realizedVol : null;
  const volatilityScale = realizedVolatility === null ? null : close * realizedVolatility;
  const emaSpread = ema9 === null || ema21 === null ? null : ema9 - ema21;
  const signedStrength =
    emaSpread !== null && volatilityScale !== null && volatilityScale > 0
      ? emaSpread / volatilityScale
      : null;
  return {
    ema9,
    ema21,
    rsi14,
    emaSpread,
    emaSpreadBps: emaSpread === null ? null : (emaSpread / close) * 10000,
    absoluteEmaSeparation: emaSpread === null ? null : Math.abs(emaSpread),
    relativeEmaSeparation: emaSpread === null ? null : Math.abs(emaSpread) / close,
    realizedVolatility,
    volatilityScale,
    signedStrength,
    normalizedEmaSpread: signedStrength === null ? null : Math.abs(signedStrength),
  };
}
export const emaRsiV2Strategy: TradingStrategy = {
  id: "ema_rsi_v2",
  version: "v2",
  timeframe: "1Min",
  warmupBars: 22,
  evaluate({ completedBars, priorTarget }) {
    // Refuse unordered/noncontinuous input; a caller must restart at a gap.
    if (
      completedBars.some(
        (b, i) =>
          !Number.isFinite(b.close) ||
          b.close <= 0 ||
          b.t % 60000 !== 0 ||
          (i > 0 && b.t !== completedBars[i - 1]!.t + 60000),
      )
    )
      throw new Error("V2 requires ordered consecutive closed minute bars");
    const current = crossoverFeatures(completedBars);
    const previous = crossoverFeatures(completedBars.slice(0, -1));
    const candidate = (f: ReturnType<typeof crossoverFeatures>) =>
      f.signedStrength !== null &&
      f.signedStrength >= EMA_RSI_V2_CONFIG.entryStrength &&
      f.emaSpread! > 0 &&
      f.rsi14! > EMA_RSI_V2_CONFIG.entryRsi;
    const warmupComplete = completedBars.length >= EMA_RSI_V2_CONFIG.warmupBars;
    const confirmed = warmupComplete && candidate(current) && candidate(previous);
    const invalidated =
      (current.signedStrength !== null &&
        current.signedStrength <= EMA_RSI_V2_CONFIG.exitStrength) ||
      (current.rsi14 !== null && current.rsi14 < EMA_RSI_V2_CONFIG.exitRsi);
    const targetPosition = !warmupComplete
      ? priorTarget
      : priorTarget === 1
        ? invalidated
          ? 0
          : 1
        : confirmed
          ? 1
          : 0;
    return {
      targetPosition,
      reason: !warmupComplete
        ? "Warmup: requires 22 consecutive closed bars."
        : priorTarget === 1
          ? invalidated
            ? "Exit: negative strength or RSI deterioration."
            : "Hold: hysteresis retains long."
          : confirmed
            ? "Enter: strength persisted for two closed bars."
            : "Hold flat: strength/persistence gate not met.",
      features: {
        ...Object.fromEntries(Object.entries(current).map(([k, v]) => [k, v ?? "UNAVAILABLE"])),
        warmupComplete,
        entryCandidate: candidate(current),
        previousEntryCandidate: candidate(previous),
        confirmed,
        invalidated,
        completedBarCount: completedBars.length,
        sourceBarTimestamp: completedBars.at(-1)?.t ?? "UNAVAILABLE",
      },
    };
  },
};
