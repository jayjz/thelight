import { THRESHOLDS } from "./thresholds.ts";
import type {
  FeatureVector,
  JevMarketState,
  JevQuestion,
  JevRequest,
  JevResponse,
  MarketQuality,
} from "./types.ts";
import { SYMBOL, TIMEFRAME } from "./types.ts";

export const JEV_MODEL_LIVE = "jev-latest";
export const JEV_MODEL_MOCK = "mock-jev-not-typesafe";

/**
 * Atomic questions asked independently of each other.
 * Jev is never asked to emit BUY/SELL prose.
 *
 * Official clients (Sprint 0 not called):
 *   Python: typesafe_sdk.TypeSafeClient().system_one(state, questions)
 *           with Choice / Noul / Score
 *   JS:     @typesafe-ai/sdk TypeSafeClient.systemOne({ state, questions })
 *           with choice() / noul() / score()
 * HTTP:     POST https://api.typesafe.ai/v1/systemone
 */
export const JEV_QUESTIONS: Record<string, JevQuestion> = {
  REGIME: {
    type: "choice",
    instructions:
      "Classify the current market regime from the supplied quantitative state only. Do not recommend a trade. trend_up: persistent positive ema_return_signal with displacement_from_ema aligned positive. trend_down: persistent negative ema_return_signal with displacement aligned negative. mean_reverting: large |displacement_z| and RSI away from 50 that is more consistent with a snap-back than with continuation. ambiguous: mixed or insufficient evidence.",
    criteria: {
      trend_up:
        "Directional upward environment: ema_return_signal > 0 and price not stretched against the signal.",
      trend_down:
        "Directional downward environment: ema_return_signal < 0 and price not stretched against the signal.",
      mean_reverting:
        "Mean-reversion environment: displacement from the local EMA is large relative to realized_vol.",
      ambiguous: "No option is clearly supported by the supplied numbers.",
    },
  },
  LONG_SETUP: {
    type: "noul",
    instructions:
      "Does the supplied quantitative state support the predefined long setup? Predefined long setup: (directional) ema_return_signal is positive and displacement_from_ema is not deeply negative, OR (mean-reversion) rsi_14 is below 30 and displacement_from_ema is negative. Answer from the numbers only. Do not output a trade instruction.",
  },
  SHORT_SETUP: {
    type: "noul",
    instructions:
      "Does the supplied quantitative state support the predefined short setup? Predefined short setup: (directional) ema_return_signal is negative and displacement_from_ema is not deeply positive, OR (mean-reversion) rsi_14 is above 70 and displacement_from_ema is positive. Answer from the numbers only. Do not output a trade instruction.",
  },
  MEAN_REVERSION: {
    type: "noul",
    instructions:
      "Does the supplied state exhibit the predefined characteristics of a mean-reversion environment: elevated |displacement_z|, RSI away from 50, and a modest |ema_return_signal|? Do not output a trade instruction.",
  },
  TREND: {
    type: "noul",
    instructions:
      "Does the supplied state exhibit the predefined characteristics of a directional trend environment: |ema_return_signal| large relative to typical scale, with displacement_from_ema aligned to the signal? Do not output a trade instruction.",
  },
  MARKET_QUALITY: {
    type: "score",
    instructions:
      "Score the usability of this state for a predefined quantitative setup. hostile: extreme realized_vol or deep drawdown. weak: noisy, mixed features. usable: features defined, vol not extreme. strong: features aligned and vol moderate. This is not a forecast of P&L.",
    criteria: ["hostile", "weak", "usable", "strong"],
  },
};

export function featuresToJevState(f: FeatureVector): JevMarketState {
  const num = (x: number) =>
    Number.isFinite(x) ? Number(x.toFixed(8)) : null;
  return {
    symbol: SYMBOL,
    timeframe: TIMEFRAME,
    close: Number(f.close.toFixed(6)),
    log_return: num(f.logReturn) ?? 0,
    normalized_return: num(f.normalizedReturn) ?? 0,
    ema_return_signal: num(f.emaReturnSignal) ?? 0,
    ema_price: Number(f.emaPrice.toFixed(6)),
    displacement_from_ema: num(f.displacementFromEma) ?? 0,
    displacement_z: num(f.displacementZ) ?? 0,
    rsi_14: Number.isFinite(f.rsi14) ? Number(f.rsi14.toFixed(4)) : 50,
    realized_vol: Number.isFinite(f.realizedVol)
      ? Number(f.realizedVol.toFixed(8))
      : 0,
    drawdown: Number(f.drawdown.toFixed(6)),
    volume: f.volume,
  };
}

export function buildJevRequest(f: FeatureVector, model: string): JevRequest {
  return {
    model,
    state: featuresToJevState(f),
    questions: JEV_QUESTIONS,
  };
}

export type JevAdapter = {
  id: string;
  model: string;
  classify: (features: FeatureVector) => JevResponse;
};

function softmax(logits: Record<string, number>): Record<string, number> {
  const keys = Object.keys(logits);
  const max = Math.max(...keys.map((k) => logits[k]!));
  const exps: Record<string, number> = {};
  let z = 0;
  for (const k of keys) {
    const e = Math.exp(logits[k]! - max);
    exps[k] = e;
    z += e;
  }
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = exps[k]! / z;
  return out;
}

function sigmoid(x: number): number {
  if (x > 20) return 1;
  if (x < -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

function argmax(probs: Record<string, number>): string {
  let best = "";
  let v = -Infinity;
  for (const [k, p] of Object.entries(probs)) {
    if (p > v) {
      v = p;
      best = k;
    }
  }
  return best;
}

const QUALITY: MarketQuality[] = ["hostile", "weak", "usable", "strong"];

/**
 * Deterministic stand-in. Same features ⇒ same typed answers.
 * Not Jev. Arm D on this adapter is not a TypeSafe evaluation.
 */
export function mockClassify(features: FeatureVector): JevResponse {
  const s = features.emaReturnSignal;
  const z = Number.isFinite(features.displacementZ)
    ? features.displacementZ
    : 0;
  const rsi = Number.isFinite(features.rsi14) ? features.rsi14 : 50;
  const rv = Number.isFinite(features.realizedVol) ? features.realizedVol : 0;
  const dd = features.drawdown;
  const sZ = rv > 0 ? s / rv : s * 80;

  const regimeP = softmax({
    trend_up: 1.1 * sZ + 0.25 * z,
    trend_down: -1.1 * sZ - 0.25 * z,
    mean_reverting:
      0.45 * Math.abs(z) + 0.03 * Math.abs(rsi - 50) - 0.9 * Math.abs(sZ),
    ambiguous: 0.7 - 0.55 * Math.abs(sZ) - 0.2 * Math.abs(z),
  });
  const regimeChoice = argmax(regimeP);
  const regimeConf = Math.min(
    0.99,
    Math.max(0.05, (regimeP[regimeChoice]! - 1 / 4) / (1 - 1 / 4)),
  );

  const longTrend = 1.15 * sZ - 0.25 * Math.max(0, -z);
  const longMr = 0.14 * (THRESHOLDS.rsiOversold - rsi) + 0.35 * Math.max(0, -z);
  const longNoul = sigmoid(Math.max(longTrend, longMr));
  const shortTrend = -1.15 * sZ - 0.25 * Math.max(0, z);
  const shortMr = 0.14 * (rsi - THRESHOLDS.rsiOverbought) + 0.35 * Math.max(0, z);
  const shortNoul = sigmoid(Math.max(shortTrend, shortMr));
  const mrNoul = sigmoid(
    0.55 * Math.abs(z) + 0.04 * Math.abs(rsi - 50) - 0.7 * Math.abs(sZ) - 0.15,
  );
  const trendNoul = sigmoid(0.95 * Math.abs(sZ) + 0.2 * Math.sign(sZ) * z - 0.15);

  let qLogit = 1.2 - 40 * Math.max(0, rv - 0.02) - 4 * dd;
  if (!features.warmupComplete) qLogit = -2;
  const qP = softmax({
    hostile: -qLogit + 1.4 * Math.max(0, rv - 0.03) * 40 + 3 * Math.max(0, dd - 0.1),
    weak: 0.6 - 0.4 * qLogit,
    usable: qLogit,
    strong: qLogit - 0.8 + (Math.abs(s) > 0.2 ? 0.4 : 0),
  });
  const qLevel = argmax(qP);
  const qScore = QUALITY.indexOf(qLevel as MarketQuality);
  const qConf = Math.min(
    0.99,
    Math.max(0.05, (qP[qLevel]! - 0.25) / 0.75),
  );

  const requestId = `mock-${features.barIndex}-${Math.round(features.close * 1e4)}`;
  const latencyMs = 4 + (features.barIndex % 9);

  return {
    model: JEV_MODEL_MOCK,
    requestId,
    latencyMs,
    answers: {
      REGIME: {
        type: "choice",
        choice: regimeChoice,
        probabilities: regimeP,
        confidence: Number(regimeConf.toFixed(4)),
      },
      LONG_SETUP: { type: "noul", noul: Number(longNoul.toFixed(4)) },
      SHORT_SETUP: { type: "noul", noul: Number(shortNoul.toFixed(4)) },
      MEAN_REVERSION: { type: "noul", noul: Number(mrNoul.toFixed(4)) },
      TREND: { type: "noul", noul: Number(trendNoul.toFixed(4)) },
      MARKET_QUALITY: {
        type: "score",
        score: qScore,
        probabilities: qP,
        confidence: Number(qConf.toFixed(4)),
        level: qLevel,
      },
    },
  };
}

export function createMockJevAdapter(): JevAdapter {
  return {
    id: "mock",
    model: JEV_MODEL_MOCK,
    classify: (features) => mockClassify(features),
  };
}

/**
 * Live TypeSafe client is intentionally not constructed in Sprint 0.
 * Swap by implementing classify() with:
 *   const client = new TypeSafeClient({ model: "jev-latest" })
 *   const result = await client.systemOne({ state, questions })
 * without changing Evidence / dashboard contracts.
 */
export function createTypeSafeJevAdapter(): JevAdapter {
  return {
    id: "typesafe",
    model: JEV_MODEL_LIVE,
    classify: () => {
      throw new Error(
        "LIVE_JEV_DISABLED: Sprint 0 is PAPER/REPLAY only. The mock adapter is the active Jev port. Wire @typesafe-ai/sdk TypeSafeClient.systemOne (or Python typesafe_sdk) here without changing Evidence fields.",
      );
    },
  };
}

export const QUALITY_RANK: Record<string, number> = {
  hostile: 0,
  weak: 1,
  usable: 2,
  strong: 3,
};
