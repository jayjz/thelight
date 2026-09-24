import { createHash } from "node:crypto";
import {
  BTC_MOMENTUM_V1_CONFIG,
  BTC_MOMENTUM_V1_ID,
  BTC_MOMENTUM_V1_VERSION,
  BTC_MOMENTUM_V1_WARMUP_BARS,
  evaluateBtcMomentumV1,
  FLAT_BTC_MOMENTUM_STATE,
  type BtcMomentumState,
} from "./btc-momentum-v1.ts";
import { logReturn } from "./features.ts";
import type { ClosedBar } from "./types.ts";

export const BTC_RESEARCH_SCHEMA_VERSION = "btc-short-horizon-research-v1" as const;
export const BTC_RESEARCH_EXECUTION_MODEL = "NEXT_BAR_CLOSE/v1" as const;
export const BTC_RESEARCH_SYMBOL = "BTC/USD" as const;

export type BtcCostScenario = {
  id: "fees_only" | "spread_only" | "slippage_only" | "combined";
  feeBpsPerSide: number;
  spreadBpsPerSide: number;
  slippageBpsPerSide: number;
};

export const BTC_COST_SCENARIOS: readonly BtcCostScenario[] = Object.freeze([
  // Alpaca's published 0–100k USD tier taker fee is 25bp per side. Spread and
  // slippage remain explicit conservative modelling assumptions, not quotes.
  { id: "fees_only", feeBpsPerSide: 25, spreadBpsPerSide: 0, slippageBpsPerSide: 0 },
  { id: "spread_only", feeBpsPerSide: 0, spreadBpsPerSide: 2, slippageBpsPerSide: 0 },
  { id: "slippage_only", feeBpsPerSide: 0, spreadBpsPerSide: 0, slippageBpsPerSide: 3 },
  { id: "combined", feeBpsPerSide: 25, spreadBpsPerSide: 2, slippageBpsPerSide: 3 },
]);

export type BtcResearchStrategyId = "flat" | "btc_momentum_baseline_v1" | typeof BTC_MOMENTUM_V1_ID;
export type BtcResearchDecision = {
  barIndex: number;
  timestamp: number;
  targetPosition: 0 | 1;
  reason: string;
  features: Record<string, number | boolean | string>;
};
export type BtcResearchTrade = {
  entryBarIndex: number;
  entryTimestamp: number;
  exitBarIndex: number;
  exitTimestamp: number;
  holdingBars: number;
  grossLogReturn: number;
  netLogReturn: number;
  cost: number;
};
export type BtcResearchMetrics = {
  totalDecisions: number;
  entryCount: number;
  completedRoundTrips: number;
  tradesPerDay: number;
  medianHoldingMinutes: number | null;
  turnover: number;
  grossPnl: number;
  netPnl: number;
  averageTrade: number | null;
  medianTrade: number | null;
  hitRate: number | null;
  profitFactor: number | null;
  maxDrawdown: number;
  exposure: number;
  costPaid: number;
  signalFlips: number;
  returnPerUnitTurnover: number | null;
};
export type BtcResearchRun = {
  strategyId: BtcResearchStrategyId;
  strategyVersion: string;
  costScenario: BtcCostScenario;
  decisions: BtcResearchDecision[];
  trades: BtcResearchTrade[];
  metrics: BtcResearchMetrics;
};

export type BtcResearchResult = {
  schemaVersion: typeof BTC_RESEARCH_SCHEMA_VERSION;
  experimentId: "btc_short_horizon_v1";
  frozenAt: "2026-09-24";
  symbol: typeof BTC_RESEARCH_SYMBOL;
  timeframe: "1Min";
  executionModel: typeof BTC_RESEARCH_EXECUTION_MODEL;
  data: { source: "DURABLE_VERIFIED" | "HISTORICAL_READ_ONLY" | "FIXTURE"; startMs: number; endMs: number; barCount: number; hash: string };
  partitions: { development: { startMs: number; endMs: number; barCount: number }; validation: { startMs: number; endMs: number; barCount: number } | null };
  strategies: Record<BtcResearchStrategyId, BtcResearchRun[]>;
  partitionResults: {
    development: Record<BtcResearchStrategyId, BtcResearchRun[]>;
    /** Evaluated independently after its own warmup; no development state leaks forward. */
    validation: Record<BtcResearchStrategyId, BtcResearchRun[]> | null;
  };
  configuration: typeof BTC_MOMENTUM_V1_CONFIG;
  limitations: string[];
};

export type BtcResearchArtifactRun = Omit<BtcResearchRun, "decisions"> & {
  decisionDigest: string;
};
export type BtcResearchArtifact = Omit<BtcResearchResult, "strategies" | "partitionResults"> & {
  strategies: Record<BtcResearchStrategyId, BtcResearchArtifactRun[]>;
  partitionResults: {
    development: Record<BtcResearchStrategyId, BtcResearchArtifactRun[]>;
    validation: Record<BtcResearchStrategyId, BtcResearchArtifactRun[]> | null;
  };
};

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestBtcResearch(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function assertConsecutiveBtcBars(bars: readonly ClosedBar[]): void {
  if (bars.length < BTC_MOMENTUM_V1_WARMUP_BARS + 2) {
    throw new Error("BTC_RESEARCH_INSUFFICIENT_CONSECUTIVE_HISTORY");
  }
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index]!;
    if (
      bar.t % 60_000 !== 0 ||
      !Number.isFinite(bar.open) || !Number.isFinite(bar.high) || !Number.isFinite(bar.low) ||
      !Number.isFinite(bar.close) || !Number.isFinite(bar.volume) ||
      Math.min(bar.open, bar.high, bar.low, bar.close) <= 0 || bar.volume < 0 ||
      bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) ||
      (index > 0 && bar.t !== bars[index - 1]!.t + 60_000)
    ) {
      throw new Error("BTC_RESEARCH_REQUIRES_EXACT_CONSECUTIVE_PROVIDER_BARS");
    }
  }
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function costPerTurnover(scenario: BtcCostScenario): number {
  return (scenario.feeBpsPerSide + scenario.spreadBpsPerSide + scenario.slippageBpsPerSide) / 10_000;
}

type BaselineState = { targetPosition: 0 | 1; barsHeld: number };
function evaluateBaseline(bars: readonly ClosedBar[], prior: BaselineState): BtcResearchDecision & { state: BaselineState } {
  const source = bars.at(-1)!;
  const lookback = 5;
  if (bars.length < 21) {
    return { barIndex: bars.length - 1, timestamp: source.t, targetPosition: prior.targetPosition, state: prior, reason: "Warmup.", features: { warmupComplete: false } };
  }
  const momentumBps = logReturn(bars.at(-(lookback + 1))!.close, source.close) * 10_000;
  const entry = momentumBps >= BTC_MOMENTUM_V1_CONFIG.roundTripCostHurdleBps;
  const held = prior.targetPosition ? prior.barsHeld + 1 : 0;
  const targetPosition = prior.targetPosition
    ? (held >= 5 || momentumBps <= 0 ? 0 : 1)
    : (entry ? 1 : 0);
  return {
    barIndex: bars.length - 1,
    timestamp: source.t,
    targetPosition,
    state: targetPosition ? { targetPosition, barsHeld: prior.targetPosition ? held : 0 } : { targetPosition: 0, barsHeld: 0 },
    reason: targetPosition ? (prior.targetPosition ? "Hold: 5-minute baseline hold." : "Enter: 5-minute return clears 60bp hurdle.") : "Flat: baseline expiry or momentum invalidation.",
    features: { warmupComplete: true, momentumBps, costHurdleBps: BTC_MOMENTUM_V1_CONFIG.roundTripCostHurdleBps },
  };
}

function decisionFor(
  strategyId: BtcResearchStrategyId,
  bars: readonly ClosedBar[],
  momentumState: BtcMomentumState,
  baselineState: BaselineState,
): { decision: BtcResearchDecision; momentumState: BtcMomentumState; baselineState: BaselineState } {
  if (strategyId === "flat") {
    const source = bars.at(-1)!;
    return { decision: { barIndex: bars.length - 1, timestamp: source.t, targetPosition: 0, reason: "Control: permanently flat.", features: { warmupComplete: true } }, momentumState, baselineState };
  }
  if (strategyId === "btc_momentum_baseline_v1") {
    const next = evaluateBaseline(bars, baselineState);
    const { state, ...decision } = next;
    return { decision, momentumState, baselineState: state };
  }
  const next = evaluateBtcMomentumV1(bars, momentumState);
  return {
    decision: { barIndex: bars.length - 1, timestamp: bars.at(-1)!.t, targetPosition: next.targetPosition, reason: next.reason, features: next.features },
    momentumState: next.nextState,
    baselineState,
  };
}

/**
 * The accounting loop performs one NEXT_BAR_CLOSE fill at a time. It accrues
 * existing exposure before that fill, therefore a decision cannot earn the
 * return from its source bar to its fill bar.
 */
export function evaluateBtcResearchStrategy(
  bars: readonly ClosedBar[],
  strategyId: BtcResearchStrategyId,
  costScenario: BtcCostScenario,
): BtcResearchRun {
  assertConsecutiveBtcBars(bars);
  const decisions: BtcResearchDecision[] = [];
  const trades: BtcResearchTrade[] = [];
  const fee = costPerTurnover(costScenario);
  let position: 0 | 1 = 0;
  let pending: BtcResearchDecision | null = null;
  let entry: { barIndex: number; timestamp: number; grossAtEntry: number; netAtEntry: number; cost: number } | null = null;
  let gross = 0;
  let net = 0;
  let cumulativeCost = 0;
  let turnover = 0;
  let entryCount = 0;
  let exposureBars = 0;
  let signalFlips = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let momentumState = FLAT_BTC_MOMENTUM_STATE;
  let baselineState: BaselineState = { targetPosition: 0, barsHeld: 0 };

  for (let index = 0; index < bars.length; index++) {
    const current = bars[index]!;
    const previous = bars[index - 1];
    if (previous && position) {
      const move = logReturn(previous.close, current.close);
      gross += move;
      net += move;
      exposureBars += 1;
    }
    if (pending) {
      const desired = pending.targetPosition;
      if (desired !== position) {
        const transitionCost = fee;
        turnover += 1;
        cumulativeCost += transitionCost;
        net -= transitionCost;
        if (desired === 1) {
          entryCount += 1;
          entry = { barIndex: index, timestamp: current.t, grossAtEntry: gross, netAtEntry: net, cost: transitionCost };
        } else if (entry) {
          trades.push({
            entryBarIndex: entry.barIndex,
            entryTimestamp: entry.timestamp,
            exitBarIndex: index,
            exitTimestamp: current.t,
            holdingBars: index - entry.barIndex,
            grossLogReturn: gross - entry.grossAtEntry,
            netLogReturn: net - entry.netAtEntry - entry.cost,
            cost: entry.cost + transitionCost,
          });
          entry = null;
        }
        position = desired;
      }
      pending = null;
    }
    peak = Math.max(peak, net);
    maxDrawdown = Math.max(maxDrawdown, peak - net);
    if (index >= BTC_MOMENTUM_V1_WARMUP_BARS - 1) {
      const evaluated = decisionFor(strategyId, bars.slice(0, index + 1), momentumState, baselineState);
      momentumState = evaluated.momentumState;
      baselineState = evaluated.baselineState;
      const priorTarget = decisions.at(-1)?.targetPosition;
      if (priorTarget !== undefined && priorTarget !== evaluated.decision.targetPosition) signalFlips += 1;
      decisions.push(evaluated.decision);
      if (index + 1 < bars.length) pending = evaluated.decision;
    }
  }
  const completed = trades.length;
  const netTrades = trades.map((trade) => trade.netLogReturn);
  const winnerSum = netTrades.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const loserSum = Math.abs(netTrades.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  const elapsedDays = Math.max((bars.at(-1)!.t - bars[0]!.t + 60_000) / 86_400_000, 1 / 1_440);
  const metrics: BtcResearchMetrics = {
    totalDecisions: decisions.length,
    entryCount,
    completedRoundTrips: completed,
    tradesPerDay: completed / elapsedDays,
    medianHoldingMinutes: median(trades.map((trade) => trade.holdingBars)),
    turnover,
    grossPnl: Math.exp(gross) - 1,
    netPnl: Math.exp(net) - 1,
    averageTrade: netTrades.length ? netTrades.reduce((sum, value) => sum + value, 0) / netTrades.length : null,
    medianTrade: median(netTrades),
    hitRate: completed ? netTrades.filter((value) => value > 0).length / completed : null,
    profitFactor: loserSum > 0 ? winnerSum / loserSum : winnerSum > 0 ? null : null,
    maxDrawdown: 1 - Math.exp(-maxDrawdown),
    exposure: exposureBars / Math.max(1, bars.length - 1),
    costPaid: cumulativeCost,
    signalFlips,
    returnPerUnitTurnover: turnover ? net / turnover : null,
  };
  return { strategyId, strategyVersion: strategyId === BTC_MOMENTUM_V1_ID ? BTC_MOMENTUM_V1_VERSION : "v1", costScenario, decisions, trades, metrics };
}

function partition(bars: readonly ClosedBar[]): BtcResearchResult["partitions"] {
  const split = bars.length >= 2 * (BTC_MOMENTUM_V1_WARMUP_BARS + 30) ? Math.floor(bars.length * 0.7) : null;
  if (!split) return { development: { startMs: bars[0]!.t, endMs: bars.at(-1)!.t, barCount: bars.length }, validation: null };
  return {
    development: { startMs: bars[0]!.t, endMs: bars[split - 1]!.t, barCount: split },
    validation: { startMs: bars[split]!.t, endMs: bars.at(-1)!.t, barCount: bars.length - split },
  };
}

export function runBtcShortHorizonResearch(
  bars: readonly ClosedBar[],
  source: BtcResearchResult["data"]["source"],
): BtcResearchResult {
  assertConsecutiveBtcBars(bars);
  const strategyIds: BtcResearchStrategyId[] = ["flat", "btc_momentum_baseline_v1", BTC_MOMENTUM_V1_ID];
  const evaluateAll = (series: readonly ClosedBar[]) => Object.fromEntries(strategyIds.map((strategyId) => [
    strategyId,
    BTC_COST_SCENARIOS.map((scenario) => evaluateBtcResearchStrategy(series, strategyId, scenario)),
  ])) as BtcResearchResult["strategies"];
  const partitions = partition(bars);
  const split = partitions.validation ? partitions.development.barCount : null;
  const strategies = evaluateAll(bars);
  return {
    schemaVersion: BTC_RESEARCH_SCHEMA_VERSION,
    experimentId: "btc_short_horizon_v1",
    frozenAt: "2026-09-24",
    symbol: BTC_RESEARCH_SYMBOL,
    timeframe: "1Min",
    executionModel: BTC_RESEARCH_EXECUTION_MODEL,
    data: { source, startMs: bars[0]!.t, endMs: bars.at(-1)!.t, barCount: bars.length, hash: digestBtcResearch(bars) },
    partitions,
    strategies,
    partitionResults: {
      development: evaluateAll(split ? bars.slice(0, split) : bars),
      validation: split ? evaluateAll(bars.slice(split)) : null,
    },
    configuration: BTC_MOMENTUM_V1_CONFIG,
    limitations: [
      "Provider OHLCV minute bars, not executable quotes or order-book data.",
      "NEXT_BAR_CLOSE/v1 is an explicit conservative placeholder, not observed BTC PAPER execution timing.",
      "No parameter was selected from this result; constants are frozen engineering hypotheses.",
      "Long/flat unit exposure only; no broker authority, order submission, or live-money support is present.",
    ],
  };
}

function compactRun(run: BtcResearchRun): BtcResearchArtifactRun {
  const { decisions, ...rest } = run;
  return { ...rest, decisionDigest: digestBtcResearch(decisions) };
}
function compactRuns(runs: Record<BtcResearchStrategyId, BtcResearchRun[]>): Record<BtcResearchStrategyId, BtcResearchArtifactRun[]> {
  return Object.fromEntries(Object.entries(runs).map(([key, value]) => [key, value.map(compactRun)])) as Record<BtcResearchStrategyId, BtcResearchArtifactRun[]>;
}
/** Compact immutable artifact: full decisions are reproducible from data hash and digest. */
export function compactBtcResearchResult(result: BtcResearchResult): BtcResearchArtifact {
  return {
    ...result,
    strategies: compactRuns(result.strategies),
    partitionResults: {
      development: compactRuns(result.partitionResults.development),
      validation: result.partitionResults.validation ? compactRuns(result.partitionResults.validation) : null,
    },
  };
}
