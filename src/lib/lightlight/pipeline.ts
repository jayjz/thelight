import { generateSyntheticCandles } from "./candles.ts";
import { computeFeatures } from "./features.ts";
import { buildJevRequest, createMockJevAdapter, type JevAdapter } from "./jev.ts";
import {
  actionToPosition,
  classifyDeterministicRegime,
  evaluatePolicy,
  evaluateRisk,
  evaluateSignal,
} from "./policy.ts";
import { computeJevMetrics, computePathMetrics } from "./evaluate.ts";
import { STRATEGY_VERSION } from "./thresholds.ts";
import {
  SYMBOL,
  TIMEFRAME,
  TRADING_MODE,
  type Candle,
  type Evidence,
  type ExperimentArm,
  type PaperFill,
  type SessionResult,
  type StrategyId,
} from "./types.ts";

export function assertPaperOnly(mode: string): void {
  if (mode !== TRADING_MODE) {
    throw new Error("LIVE_TRADING_FORBIDDEN");
  }
}

const RESEARCH_FOR: Record<StrategyId, string[]> = {
  ema_trend: ["arXiv:1308.5658", "arXiv:2602.10785"],
  rsi_mean_reversion: [
    "arXiv:1605.00003",
    "arXiv:1408.2217",
    "arXiv:2412.15448",
  ],
};

export function runSession(input: {
  arm: ExperimentArm;
  strategyId: StrategyId;
  candles?: Candle[];
  adapter?: JevAdapter;
}): SessionResult {
  assertPaperOnly(TRADING_MODE);
  const candles = input.candles ?? generateSyntheticCandles();
  const adapter = input.adapter ?? createMockJevAdapter();
  const features = computeFeatures(candles);
  const evidences: Evidence[] = [];
  const fills: PaperFill[] = [];

  let position = 0;
  let equity = 1;
  let peak = 1;

  for (let i = 0; i < candles.length; i++) {
    const f = features[i]!;
    const signal = evaluateSignal(input.strategyId, f);
    const detRegime = classifyDeterministicRegime(f);
    const jevRequest = buildJevRequest(f, adapter.model);
    const jevResponse = adapter.classify(f);
    const policy = evaluatePolicy({
      arm: input.arm,
      strategyId: input.strategyId,
      signal,
      detRegime,
      jev: jevResponse,
    });
    const equityDd = peak === 0 ? 0 : Math.max(0, (peak - equity) / peak);
    const risk = evaluateRisk({
      desired: policy.desired,
      features: f,
      equityDrawdown: equityDd,
    });
    const action = risk.target;
    const pos = actionToPosition(action);
    const abstained =
      policy.desired !== action ||
      (action === "FLAT" && signal.desired !== "FLAT");
    const id = `LL-${SYMBOL}-${TIMEFRAME}-${String(i).padStart(4, "0")}`;

    const ev: Evidence = {
      id,
      timestamp: f.timestamp,
      barIndex: i,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      tradingMode: TRADING_MODE,
      marketSnapshot: candles[i]!,
      features: f,
      strategyId: input.strategyId,
      strategyVersion: STRATEGY_VERSION,
      researchRefs: RESEARCH_FOR[input.strategyId],
      deterministicSignal: signal,
      deterministicRegime: detRegime,
      jevRequest,
      jevResponse,
      policy,
      risk,
      action,
      positionAfter: pos,
      abstained,
    };
    evidences.push(ev);

    if (pos !== position && i + 1 < candles.length) {
      fills.push({
        decisionId: id,
        barIndex: i,
        fillBarIndex: i + 1,
        action,
        positionAfter: pos,
        fillPrice: candles[i + 1]!.close,
        note: "UNCALIBRATED next-bar close fill. Paper only.",
      });
    }

    if (i + 1 < candles.length) {
      const r = Math.log(candles[i + 1]!.close / candles[i]!.close);
      equity *= Math.exp(position * r);
      if (equity > peak) peak = equity;
    }
    position = pos;
  }

  return {
    arm: input.arm,
    strategyId: input.strategyId,
    candles,
    evidences,
    fills,
    metrics: computePathMetrics(candles, evidences),
    jevMetrics: computeJevMetrics(candles, evidences),
  };
}

export function runAllArms(strategyId: StrategyId, candles?: Candle[]) {
  const series = candles ?? generateSyntheticCandles();
  const adapter = createMockJevAdapter();
  const arms: ExperimentArm[] = ["A", "B", "C", "D"];
  return Object.fromEntries(
    arms.map((arm) => [
      arm,
      runSession({ arm, strategyId, candles: series, adapter }),
    ]),
  ) as Record<ExperimentArm, SessionResult>;
}
