/**
 * All numeric policy cutoffs are UNCALIBRATED until measured on a declared
 * walk-forward design (see Mroziewicz & Ślepaczuk, arXiv:2602.10785).
 * Do not treat these as paper findings.
 */
export const THRESHOLDS = {
  label: "UNCALIBRATED",
  /** Inverse timescale η for Grebenkov return-EMA signal. Illustrative 20-bar. */
  emaEta: 0.05,
  /** Price EMA span in bars (overlay + displacement). */
  priceEmaSpan: 20,
  /** Rolling window for realized vol and return z-score. */
  volWindow: 20,
  /** Khaidem et al. write RSI over 14 days. */
  rsiPeriod: 14,
  /**
   * Minimum |s_t| / realized_vol to take an EMA-trend position.
   * Grebenkov scales γ so s has unit variance when returns are standardized.
   * Our r_t are raw log returns, so we compare s to local vol. UNCALIBRATED.
   */
  emaSignalEnterZ: 1.0,
  /**
   * Conventional RSI bands. Not specified as a trading rule in the cited papers.
   * Khaidem uses RSI as a random-forest feature, not an oversold/overbought gate.
   */
  rsiOversold: 30,
  rsiOverbought: 70,
  /** Daily log-return std above which new risk is blocked. */
  maxRealizedVol: 0.035,
  /** Close drawdown from peak that forces flatten. */
  maxDrawdown: 0.18,
  /** Noul floors for Jev setup / environment gates. */
  longSetupNoul: 0.55,
  shortSetupNoul: 0.55,
  trendNoul: 0.55,
  meanReversionNoul: 0.55,
  /** Minimum MARKET_QUALITY level (ordered) to allow entry. */
  minQuality: "usable" as const,
  /** Choice confidence floor for using Jev REGIME. */
  regimeConfidence: 0.35,
  /** Paper transaction cost applied on |Δposition|. 0 until calibrated. */
  transactionCostBps: 0,
  slippageBps: 0,
  /** Bars of future return used as a regime outcome proxy for Brier (ours). */
  regimeOutcomeHorizon: 5,
} as const;

export const STRATEGY_VERSION = "sprint0.1";
export const POLICY_VERSION = "sprint0.1";
export const RISK_VERSION = "sprint0.1";
export const FEATURE_VERSION = "sprint0.1";
