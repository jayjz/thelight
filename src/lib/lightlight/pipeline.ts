import { generateSyntheticCandles } from "./candles.ts";
import { computeFeatures } from "./features.ts";
import { buildJevRequest, createMockJevAdapter, type JevAdapter } from "./jev.ts";
import {
  classifyDeterministicRegime,
  evaluatePolicy,
  evaluateRisk,
  evaluateSignal,
} from "./policy.ts";
import { computeJevMetrics, computePathMetrics } from "./evaluate.ts";
import { ReplayExecution } from "./execution.ts";
import type { MarketSource } from "./market.ts";
import { STRATEGY_VERSION, THRESHOLDS } from "./thresholds.ts";
import {
  SYMBOL,
  TIMEFRAME,
  TRADING_MODE,
  type Candle,
  type Evidence,
  type ExperimentArm,
  type SessionResult,
  type StrategyId,
  type TradingMode,
} from "./types.ts";

export function assertPaperOnly(mode: string): void {
  if (mode !== "PAPER_REPLAY" && mode !== "ALPACA_PAPER") {
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
  execution?: { transactionCostBps: number; slippageBps: number };
  tradingMode?: TradingMode;
}): SessionResult {
  const tradingMode = input.tradingMode ?? TRADING_MODE;
  assertPaperOnly(tradingMode);
  const candles = input.candles ?? generateSyntheticCandles();
  const adapter = input.adapter ?? createMockJevAdapter();
  const features = computeFeatures(candles);
  const evidences: Evidence[] = [];
  const execution = new ReplayExecution(
    input.execution ?? {
      transactionCostBps: THRESHOLDS.transactionCostBps,
      slippageBps: THRESHOLDS.slippageBps,
    },
  );

  for (let i = 0; i < candles.length; i++) {
    execution.advanceBar(i, candles[i]!, candles[i - 1]);
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
    const risk = evaluateRisk({
      desired: policy.desired,
      features: f,
      equityDrawdown: execution.currentDrawdown,
    });
    const action = risk.target;
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
      tradingMode,
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
      targetPosition: action === "LONG" ? 1 : action === "SHORT" ? -1 : 0,
      abstained,
    };
    evidences.push(ev);
    execution.createIntent({
      decisionId: id,
      createdAtBar: i,
      createdAtTimestamp: f.timestamp,
      action,
    });
  }

  const ledger = execution.snapshot();

  return {
    arm: input.arm,
    strategyId: input.strategyId,
    candles,
    evidences,
    ledger,
    fills: ledger.fills,
    metrics: computePathMetrics(candles, evidences, ledger, input.execution),
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

/** Runs a finite closed-bar source through exactly the same decision pipeline. */
export async function runSessionFromMarketSource(
  input: Omit<Parameters<typeof runSession>[0], "candles"> & { source: MarketSource },
): Promise<SessionResult> {
  const candles: Candle[] = [];
  for await (const bar of input.source.bars()) candles.push(bar);
  return runSession({ ...input, candles });
}
