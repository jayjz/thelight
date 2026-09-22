import { THRESHOLDS, POLICY_VERSION, RISK_VERSION, STRATEGY_VERSION } from "./thresholds.ts";
import { QUALITY_RANK } from "./jev.ts";
import { applyDirectionalCapability, type AssetSpec } from "./assets.ts";
import type {
  Action,
  DeterministicRegime,
  ExperimentArm,
  FeatureVector,
  JevResponse,
  PolicyEvaluation,
  RiskEvaluation,
  Signal,
  StrategyId,
} from "./types.ts";

export function classifyDeterministicRegime(
  f: FeatureVector,
): DeterministicRegime {
  if (!f.warmupComplete) return "ambiguous";
  const s = f.emaReturnSignal;
  const z = f.displacementZ;
  const rsi = f.rsi14;
  const scale = f.realizedVol > 0 ? Math.abs(s) / f.realizedVol : 0;
  const trendish = scale >= THRESHOLDS.emaSignalEnterZ;
  const stretched =
    Math.abs(z) >= 1.2 ||
    rsi <= THRESHOLDS.rsiOversold ||
    rsi >= THRESHOLDS.rsiOverbought;
  if (trendish && s > 0 && z >= 0) return "trend_up";
  if (trendish && s < 0 && z <= 0) return "trend_down";
  if (!trendish && stretched) return "mean_reverting";
  return "ambiguous";
}

export function emaTrendSignal(f: FeatureVector): Signal {
  const reasonBase =
    "Grebenkov-style s_t vs UNCALIBRATED |s|/vol floor. Linear paper positions were not thresholded; discretization is ours.";
  if (!f.warmupComplete) {
    return {
      strategyId: "ema_trend",
      strategyVersion: STRATEGY_VERSION,
      desired: "FLAT",
      reason: "Warmup incomplete.",
    };
  }
  const z = f.realizedVol > 0 ? f.emaReturnSignal / f.realizedVol : 0;
  if (z > THRESHOLDS.emaSignalEnterZ) {
    return {
      strategyId: "ema_trend",
      strategyVersion: STRATEGY_VERSION,
      desired: "LONG",
      reason: `${reasonBase} s/vol=${z.toFixed(2)} > ${THRESHOLDS.emaSignalEnterZ}.`,
    };
  }
  if (z < -THRESHOLDS.emaSignalEnterZ) {
    return {
      strategyId: "ema_trend",
      strategyVersion: STRATEGY_VERSION,
      desired: "SHORT",
      reason: `${reasonBase} s/vol=${z.toFixed(2)} < -${THRESHOLDS.emaSignalEnterZ}.`,
    };
  }
  return {
    strategyId: "ema_trend",
    strategyVersion: STRATEGY_VERSION,
    desired: "FLAT",
    reason: `${reasonBase} |s|/vol below enter.`,
  };
}

export function rsiMeanReversionSignal(f: FeatureVector): Signal {
  const reasonBase =
    "RSI(14) SMA as in Khaidem et al. Oversold/overbought bands are conventional UNCALIBRATED gates, not a paper trading rule.";
  if (!f.warmupComplete) {
    return {
      strategyId: "rsi_mean_reversion",
      strategyVersion: STRATEGY_VERSION,
      desired: "FLAT",
      reason: "Warmup incomplete.",
    };
  }
  if (f.rsi14 <= THRESHOLDS.rsiOversold) {
    return {
      strategyId: "rsi_mean_reversion",
      strategyVersion: STRATEGY_VERSION,
      desired: "LONG",
      reason: `${reasonBase} RSI=${f.rsi14.toFixed(2)} ≤ ${THRESHOLDS.rsiOversold}.`,
    };
  }
  if (f.rsi14 >= THRESHOLDS.rsiOverbought) {
    return {
      strategyId: "rsi_mean_reversion",
      strategyVersion: STRATEGY_VERSION,
      desired: "SHORT",
      reason: `${reasonBase} RSI=${f.rsi14.toFixed(2)} ≥ ${THRESHOLDS.rsiOverbought}.`,
    };
  }
  return {
    strategyId: "rsi_mean_reversion",
    strategyVersion: STRATEGY_VERSION,
    desired: "FLAT",
    reason: `${reasonBase} RSI inside bands.`,
  };
}

export function evaluateSignal(id: StrategyId, f: FeatureVector): Signal {
  return id === "ema_trend" ? emaTrendSignal(f) : rsiMeanReversionSignal(f);
}

function regimeAligned(
  strategyId: StrategyId,
  desired: Action,
  regime: DeterministicRegime,
): boolean {
  if (desired === "FLAT") return true;
  if (strategyId === "ema_trend") {
    if (desired === "LONG") return regime === "trend_up";
    return regime === "trend_down";
  }
  return regime === "mean_reverting";
}

function jevAllows(
  strategyId: StrategyId,
  desired: Action,
  jev: JevResponse,
): { pass: boolean; reason: string } {
  const a = jev.answers;
  const qualityOk =
    QUALITY_RANK[a.MARKET_QUALITY.level] >= QUALITY_RANK[THRESHOLDS.minQuality];
  const regime = a.REGIME.choice;
  const regimeOk = a.REGIME.confidence >= THRESHOLDS.regimeConfidence;

  if (!qualityOk) {
    return {
      pass: false,
      reason: `Jev MARKET_QUALITY=${a.MARKET_QUALITY.level} below UNCALIBRATED ${THRESHOLDS.minQuality}.`,
    };
  }
  if (desired === "FLAT") return { pass: true, reason: "No entry requested." };

  if (desired === "LONG" && a.LONG_SETUP.noul < THRESHOLDS.longSetupNoul) {
    return {
      pass: false,
      reason: `LONG_SETUP noul ${a.LONG_SETUP.noul.toFixed(2)} < ${THRESHOLDS.longSetupNoul} UNCALIBRATED.`,
    };
  }
  if (desired === "SHORT" && a.SHORT_SETUP.noul < THRESHOLDS.shortSetupNoul) {
    return {
      pass: false,
      reason: `SHORT_SETUP noul ${a.SHORT_SETUP.noul.toFixed(2)} < ${THRESHOLDS.shortSetupNoul} UNCALIBRATED.`,
    };
  }

  if (strategyId === "ema_trend") {
    if (a.TREND.noul < THRESHOLDS.trendNoul) {
      return {
        pass: false,
        reason: `TREND noul ${a.TREND.noul.toFixed(2)} < ${THRESHOLDS.trendNoul} UNCALIBRATED.`,
      };
    }
    if (regimeOk) {
      if (desired === "LONG" && regime !== "trend_up") {
        return { pass: false, reason: `Jev REGIME=${regime}, not trend_up.` };
      }
      if (desired === "SHORT" && regime !== "trend_down") {
        return { pass: false, reason: `Jev REGIME=${regime}, not trend_down.` };
      }
    }
  } else {
    if (a.MEAN_REVERSION.noul < THRESHOLDS.meanReversionNoul) {
      return {
        pass: false,
        reason: `MEAN_REVERSION noul ${a.MEAN_REVERSION.noul.toFixed(2)} < ${THRESHOLDS.meanReversionNoul} UNCALIBRATED.`,
      };
    }
    if (regimeOk && regime !== "mean_reverting") {
      return { pass: false, reason: `Jev REGIME=${regime}, not mean_reverting.` };
    }
  }
  return { pass: true, reason: "Jev gates passed (UNCALIBRATED thresholds)." };
}

export function evaluatePolicy(input: {
  arm: ExperimentArm;
  strategyId: StrategyId;
  signal: Signal;
  detRegime: DeterministicRegime;
  jev: JevResponse;
}): PolicyEvaluation {
  const { arm, strategyId, signal, detRegime, jev } = input;
  const a = jev.answers;
  let desired: Action = "FLAT";
  let reason = "";

  if (arm === "A") {
    desired = "LONG";
    reason = "Arm A baseline: unit long buy-and-hold.";
  } else if (arm === "B") {
    desired = signal.desired;
    reason = `Arm B: ${signal.reason}`;
  } else if (arm === "C") {
    if (signal.desired === "FLAT") {
      desired = "FLAT";
      reason = `Arm C: ${signal.reason}`;
    } else if (regimeAligned(strategyId, signal.desired, detRegime)) {
      desired = signal.desired;
      reason = `Arm C: signal ${signal.desired} aligned with det. regime ${detRegime}.`;
    } else {
      desired = "FLAT";
      reason = `Arm C: det. regime ${detRegime} rejected ${signal.desired}.`;
    }
  } else {
    const gate = jevAllows(strategyId, signal.desired, jev);
    desired = gate.pass ? signal.desired : "FLAT";
    reason = `Arm D: ${gate.reason}`;
  }

  return {
    version: POLICY_VERSION,
    arm,
    deterministicSignal: signal.desired,
    deterministicRegime: detRegime,
    jevRegime: a.REGIME.choice as DeterministicRegime,
    jevLongPass: a.LONG_SETUP.noul >= THRESHOLDS.longSetupNoul,
    jevShortPass: a.SHORT_SETUP.noul >= THRESHOLDS.shortSetupNoul,
    jevTrendPass: a.TREND.noul >= THRESHOLDS.trendNoul,
    jevMeanReversionPass: a.MEAN_REVERSION.noul >= THRESHOLDS.meanReversionNoul,
    jevQualityPass:
      QUALITY_RANK[a.MARKET_QUALITY.level] >= QUALITY_RANK[THRESHOLDS.minQuality],
    desired,
    reason,
  };
}

/**
 * Keeps strategy output separate from broker capability. SPY's LONG_SHORT
 * contract is an identity mapping; future long-only assets are deterministic.
 */
export function evaluateAssetAwarePolicy(input: {
  asset: AssetSpec;
  arm: ExperimentArm;
  strategyId: StrategyId;
  signal: Signal;
  detRegime: DeterministicRegime;
  jev: JevResponse;
}): PolicyEvaluation {
  const policy = evaluatePolicy(input);
  const desired = applyDirectionalCapability(input.asset, policy.desired);
  if (desired === policy.desired) return policy;
  return {
    ...policy,
    desired,
    reason: `${policy.reason} Asset direction mode ${input.asset.directionMode} mapped unsupported SHORT to FLAT.`,
  };
}

export function evaluateRisk(input: {
  desired: Action;
  features: FeatureVector;
  equityDrawdown: number;
}): RiskEvaluation {
  const reasons: string[] = [];
  const { desired, features, equityDrawdown } = input;
  let target = desired;
  if (!features.warmupComplete) {
    target = "FLAT";
    reasons.push("Warmup incomplete.");
  }
  if (
    Number.isFinite(features.realizedVol) &&
    features.realizedVol > THRESHOLDS.maxRealizedVol &&
    desired !== "FLAT"
  ) {
    target = "FLAT";
    reasons.push(
      `realized_vol ${features.realizedVol.toFixed(4)} > UNCALIBRATED ${THRESHOLDS.maxRealizedVol}.`,
    );
  }
  if (features.drawdown > THRESHOLDS.maxDrawdown && desired !== "FLAT") {
    target = "FLAT";
    reasons.push(
      `price drawdown ${features.drawdown.toFixed(3)} > UNCALIBRATED ${THRESHOLDS.maxDrawdown}.`,
    );
  }
  if (equityDrawdown > THRESHOLDS.maxDrawdown && desired !== "FLAT") {
    target = "FLAT";
    reasons.push(
      `paper equity drawdown ${equityDrawdown.toFixed(3)} > UNCALIBRATED ${THRESHOLDS.maxDrawdown}.`,
    );
  }
  if (reasons.length === 0) reasons.push("Risk checks passed (UNCALIBRATED).");
  return {
    version: RISK_VERSION,
    pass: target === desired,
    target,
    reasons,
    maxPosition: 1,
    realizedVol: features.realizedVol,
    drawdown: features.drawdown,
    equityDrawdown,
  };
}

export function actionToPosition(action: Action): number {
  if (action === "LONG") return 1;
  if (action === "SHORT") return -1;
  return 0;
}
