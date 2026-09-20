/** Sprint 0 trading mode. There is no live-order path. */
export const TRADING_MODE = "PAPER_REPLAY" as const;
export type TradingMode = typeof TRADING_MODE;

export const SYMBOL = "SYN.LL1";
export const TIMEFRAME = "1D";
export const SERIES_NOTE =
  "Synthetic seeded path for replay. Not a listed instrument. Not vendor market data.";

export type ExperimentArm = "A" | "B" | "C" | "D";

export const EXPERIMENT_ARMS: Record<
  ExperimentArm,
  { label: string; summary: string }
> = {
  A: {
    label: "Baseline",
    summary: "Buy-and-hold unit long. Comparison arm, not a researched edge.",
  },
  B: {
    label: "Deterministic strategy",
    summary: "Strategy signal only. No regime filter.",
  },
  C: {
    label: "Det. strategy + det. regime",
    summary: "Strategy signal gated by our deterministic regime classifier.",
  },
  D: {
    label: "Det. strategy + Jev regime",
    summary:
      "Strategy signal gated by Jev typed answers. Sprint 0 uses a mock adapter.",
  },
};

export type StrategyId = "ema_trend" | "rsi_mean_reversion";

export type Action = "LONG" | "SHORT" | "FLAT";

export type Candle = {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type FeatureVector = {
  barIndex: number;
  timestamp: number;
  close: number;
  volume: number;
  logReturn: number;
  /** Rolling z-score of log return. Window labeled UNCALIBRATED. */
  normalizedReturn: number;
  /**
   * Grebenkov & Serror (arXiv:1308.5658) trend signal s_t = γ Σ (1-η)^{t-1-k} r_k
   * using only past returns (no contemporaneous r_t).
   */
  emaReturnSignal: number;
  /** Recursive EMA of close. Overlay / displacement input. Span UNCALIBRATED. */
  emaPrice: number;
  /** (close - emaPrice) / emaPrice */
  displacementFromEma: number;
  /** Displacement scaled by rolling close-return vol. */
  displacementZ: number;
  /** Khaidem et al. (arXiv:1605.00003) RSI over 14 periods, SMA of gains/losses. */
  rsi14: number;
  /** Sample std of log returns over UNCALIBRATED window. */
  realizedVol: number;
  /** Peak-to-now drawdown of close from running high. */
  drawdown: number;
  warmupComplete: boolean;
};

export type DeterministicRegime =
  | "trend_up"
  | "trend_down"
  | "mean_reverting"
  | "ambiguous";

export type MarketQuality = "hostile" | "weak" | "usable" | "strong";

export type JevRegime = DeterministicRegime;

export type Signal = {
  strategyId: StrategyId;
  strategyVersion: string;
  desired: Action;
  reason: string;
};

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type NoulAnswer = {
  type: "noul";
  /** Probability the proposition holds, in [0, 1]. */
  noul: number;
};

export type ScoreAnswer = {
  type: "score";
  /** Position on the ordered rubric (0 .. n-1). */
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
  /** Nearest criterion label — display convenience, not a Jev prose field. */
  level: string;
};

export type JevAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export type JevQuestion =
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string>;
    }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

/**
 * Compact numerical state sent to Jev. Indicators are already computed.
 * Jev must not calculate indicators, size, returns, P&L, or risk limits.
 */
export type JevMarketState = {
  symbol: string;
  timeframe: string;
  close: number;
  log_return: number;
  normalized_return: number;
  ema_return_signal: number;
  ema_price: number;
  displacement_from_ema: number;
  displacement_z: number;
  rsi_14: number;
  realized_vol: number;
  drawdown: number;
  volume: number;
};

export type JevRequest = {
  model: string;
  state: JevMarketState;
  questions: Record<string, JevQuestion>;
};

export type JevResponse = {
  model: string;
  requestId: string;
  latencyMs: number;
  answers: {
    REGIME: ChoiceAnswer;
    LONG_SETUP: NoulAnswer;
    SHORT_SETUP: NoulAnswer;
    MEAN_REVERSION: NoulAnswer;
    TREND: NoulAnswer;
    MARKET_QUALITY: ScoreAnswer;
  };
};

export type RiskEvaluation = {
  version: string;
  pass: boolean;
  target: Action;
  reasons: string[];
  maxPosition: number;
  realizedVol: number;
  drawdown: number;
};

export type PolicyEvaluation = {
  version: string;
  arm: ExperimentArm;
  deterministicSignal: Action;
  deterministicRegime: DeterministicRegime;
  jevRegime: JevRegime;
  jevLongPass: boolean;
  jevShortPass: boolean;
  jevTrendPass: boolean;
  jevMeanReversionPass: boolean;
  jevQualityPass: boolean;
  desired: Action;
  reason: string;
};

export type PaperFill = {
  decisionId: string;
  barIndex: number;
  fillBarIndex: number;
  action: Action;
  positionAfter: number;
  fillPrice: number;
  note: string;
};

export type Evidence = {
  id: string;
  timestamp: number;
  barIndex: number;
  symbol: string;
  timeframe: string;
  tradingMode: TradingMode;
  marketSnapshot: Candle;
  features: FeatureVector;
  strategyId: StrategyId;
  strategyVersion: string;
  researchRefs: string[];
  deterministicSignal: Signal;
  deterministicRegime: DeterministicRegime;
  jevRequest: JevRequest;
  jevResponse: JevResponse;
  policy: PolicyEvaluation;
  risk: RiskEvaluation;
  action: Action;
  positionAfter: number;
  abstained: boolean;
};

export type PathMetrics = {
  barCount: number;
  tradeCount: number;
  hitRate: number | null;
  totalReturn: number;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number;
  turnover: number;
  exposure: number;
  transactionCostBps: number;
  slippageBps: number;
  abstainedCount: number;
  note: string;
};

export type JevEvalMetrics = {
  brierRegime: number | null;
  calibrationBuckets: { p: number; freq: number; n: number }[];
  confidenceBuckets: { lo: number; hi: number; n: number; hit: number }[];
  selectiveAccuracy: { coverage: number; accuracy: number }[];
  decisionsAbstained: number;
  byRegime: Record<string, { n: number; meanReturn: number }>;
  note: string;
};

export type SessionResult = {
  arm: ExperimentArm;
  strategyId: StrategyId;
  candles: Candle[];
  evidences: Evidence[];
  fills: PaperFill[];
  metrics: PathMetrics;
  jevMetrics: JevEvalMetrics;
};
