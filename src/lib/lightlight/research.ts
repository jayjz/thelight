import type { StrategyId } from "./types.ts";

export type ResearchCard = {
  id: StrategyId | "evaluation" | "indicators";
  paper: {
    authors: string;
    title: string;
    arxiv: string;
    year: string;
  };
  hypothesis: string;
  implementation: string;
  observed: string;
};

export const RESEARCH: Record<string, ResearchCard> = {
  ema_trend: {
    id: "ema_trend",
    paper: {
      authors: "Grebenkov & Serror",
      title:
        "Following a Trend with an Exponential Moving Average: Analytical Results for a Gaussian Model",
      arxiv: "1308.5658",
      year: "2013",
    },
    hypothesis:
      "Under a Gaussian model of log returns with autocorrelation, a trend-following signal formed as an EMA of past returns has an analyzable P&L distribution (often small losses, less frequent larger profits). They derive moments, turnover, and an optimal timescale that depends on autocorrelation and transaction costs. Illustrated on the Dow Jones index. They do not claim live profitability, and they note quantitative results are model-dependent (heavy tails ignored).",
    implementation:
      "We compute s_t = γ Σ_{k<t} (1-η)^{t-1-k} r_k with γ² = η(2-η) as in their eq. (13), using only past returns. η = 0.05 is UNCALIBRATED (illustrative 20-bar inverse timescale), not their Dow Jones market-model fit λ ≈ 0.011. They trade a linear position in s_t; we discretize with an UNCALIBRATED |s_t|/realized_vol enter floor because our returns are not pre-standardized. Paper fill is next-bar close. Synthetic path, not Dow Jones.",
    observed:
      "Observed numbers on this screen are in-sample on a seeded synthetic series. They are not a test of Grebenkov & Serror and are not alpha.",
  },
  rsi_mean_reversion: {
    id: "rsi_mean_reversion",
    paper: {
      authors: "Khaidem, Saha & Dey; Kakushadze; Deep et al.",
      title:
        "RSI as a classification feature; mean-reversion via demeaning; indicator impact OOS",
      arxiv: "1605.00003 / 1408.2217 / 2412.15448",
      year: "2016–2024",
    },
    hypothesis:
      "Khaidem et al. (arXiv:1605.00003) use RSI(14) = 100 − 100/(1+RS) with RS = average gain / average loss over 14 days as an input to a random forest for direction classification — not as an oversold/overbought trading rule. Kakushadze (arXiv:1408.2217) treats mean-reversion as cross-sectional demeaning of returns (pairs / regression residuals), which a single series cannot implement. Deep et al. (arXiv:2412.15448) find that on minute SPY, RSI and similar indicators contribute ~14–15% of RF importance vs >60% for price features; OOS R² turns negative; indicator-enhanced models underperformed buy-and-hold (−2.4% to −3.9% in their test).",
    implementation:
      "We compute Khaidem's RSI(14) SMA on one synthetic series. The long-if-RSI≤30 / short-if-RSI≥70 gate is OUR conventional heuristic, UNCALIBRATED, and is not a finding of those papers. Displacement from price EMA is a time-series demeaning analog, not Kakushadze's cross-sectional residual.",
    observed:
      "Do not read a profitable RSI rule out of this replay. Deep et al. already warn that in-sample indicator fits can collapse OOS.",
  },
  evaluation: {
    id: "evaluation",
    paper: {
      authors: "Mroziewicz & Ślepaczuk",
      title:
        "A novel approach to trading strategy parameter optimization using double out-of-sample data and walk-forward techniques",
      arxiv: "2602.10785",
      year: "2026",
    },
    hypothesis:
      "Walk-forward window lengths (train/test) are themselves parameters. They evaluate an EMA strategy on intraday Bitcoin with 81 window combinations, then apply the two best sets once on a later 21-month OOS period, and transfer parameters to BNB and ETH. They include 0.1% fees and a cost-sensitivity check (break-even around 0.4%/transaction in their study). This is a methodology paper.",
    implementation:
      "Sprint 0 does NOT run their double-OOS walk-forward. Arms A–D share one synthetic path (in-sample contamination if treated as a result). Transaction cost = 0 bps UNCALIBRATED. Architecture exposes the four arms and the metric set so that procedure can be added next.",
    observed:
      "Any Sharpe/return on this screen is an in-sample synthetic diagnostic, not an OOS result and not a claim that walk-forward was performed.",
  },
  indicators: {
    id: "indicators",
    paper: {
      authors: "Deep et al.",
      title:
        "Assessing the Impact of Technical Indicators on Machine Learning Models for Stock Price Prediction",
      arxiv: "2412.15448",
      year: "2024",
    },
    hypothesis:
      "On minute-level SPY, adding established technical indicators (RSI, Bollinger, …) to RF regression did not yield OOS predictive skill. Price-based features dominated importance. Authors suggest indicators may be more relevant to risk management than to return prediction in that high-frequency setting, and stress robust OOS testing.",
    implementation:
      "We keep a small feature set (EMA-return signal, RSI14, realized vol, normalized return, EMA displacement) and do not train an RF. Jev sees already-computed numbers only.",
    observed:
      "No ML price-prediction model is fit here. Feature values are diagnostics, not a forecast.",
  },
};

export function cardForStrategy(id: StrategyId): ResearchCard {
  return RESEARCH[id]!;
}
