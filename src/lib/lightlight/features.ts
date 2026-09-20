import { THRESHOLDS } from "./thresholds.ts";
import type { Candle, FeatureVector } from "./types.ts";

export function logReturn(prevClose: number, close: number): number {
  if (prevClose <= 0 || close <= 0) return 0;
  return Math.log(close / prevClose);
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function sampleStd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let v = 0;
  for (const x of xs) {
    const d = x - m;
    v += d * d;
  }
  return Math.sqrt(v / (xs.length - 1));
}

/**
 * Recursive EMA: tilde_x_t = (1-λ) tilde_x_{t-1} + λ x_t
 * Grebenkov & Serror eq. (1) recurrent form, arXiv:1308.5658.
 * Seeds at the first observation (finite-sample start; paper also writes a
 * matrix form over a finite window).
 */
export function recursiveEma(values: number[], lambda: number): number[] {
  if (values.length === 0) return [];
  if (!(lambda > 0 && lambda <= 1)) {
    throw new Error("EMA lambda must be in (0, 1]");
  }
  const out = new Array<number>(values.length);
  out[0] = values[0]!;
  const oneMinus = 1 - lambda;
  for (let i = 1; i < values.length; i++) {
    out[i] = oneMinus * out[i - 1]! + lambda * values[i]!;
  }
  return out;
}

/**
 * Grebenkov & Serror (arXiv:1308.5658) eq. (13):
 *   s_t = γ Σ_{k=1}^{t-1} (1-η)^{t-1-k} r_k
 * with γ² = η(2-η) so the signal has unit variance for independent returns.
 * Recurrence: u_1 = 0; u_t = r_{t-1} + (1-η) u_{t-1}; s_t = γ u_t.
 * Uses only past returns — s_t does not include r_t.
 */
export function grebenkovReturnSignal(
  logReturns: number[],
  eta: number,
): number[] {
  if (!(eta > 0 && eta <= 1)) {
    throw new Error("eta must be in (0, 1]");
  }
  const gamma = Math.sqrt(eta * (2 - eta));
  const decay = 1 - eta;
  const s = new Array<number>(logReturns.length);
  let u = 0;
  s[0] = 0;
  for (let t = 1; t < logReturns.length; t++) {
    u = logReturns[t - 1]! + decay * u;
    s[t] = gamma * u;
  }
  return s;
}

/**
 * RSI as written by Khaidem, Saha & Dey (arXiv:1605.00003):
 *   RSI = 100 - 100 / (1 + RS)
 *   RS  = (Average Gain Over past 14 days) / (Average Loss Over past 14 days)
 * Simple averages (not Wilder smoothing). Period defaults to 14 as they specify.
 * RSI is undefined until `period` closed changes exist; we return NaN then.
 */
export function rsiSma(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(Number.NaN);
  if (closes.length < period + 1) return out;
  for (let i = period; i < closes.length; i++) {
    let gain = 0;
    let loss = 0;
    for (let k = i - period + 1; k <= i; k++) {
      const d = closes[k]! - closes[k - 1]!;
      if (d > 0) gain += d;
      else loss -= d;
    }
    const avgGain = gain / period;
    const avgLoss = loss / period;
    if (avgLoss === 0 && avgGain === 0) out[i] = 50;
    else if (avgLoss === 0) out[i] = 100;
    else if (avgGain === 0) out[i] = 0;
    else {
      const rs = avgGain / avgLoss;
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

export function rollingStd(xs: number[], window: number): number[] {
  const out = new Array<number>(xs.length).fill(Number.NaN);
  for (let i = 0; i < xs.length; i++) {
    if (i + 1 < window) continue;
    out[i] = sampleStd(xs.slice(i + 1 - window, i + 1));
  }
  return out;
}

export function runningDrawdown(closes: number[]): number[] {
  const out = new Array<number>(closes.length);
  let peak = closes[0] ?? 0;
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i]!;
    if (c > peak) peak = c;
    out[i] = peak === 0 ? 0 : (peak - c) / peak;
  }
  return out;
}

export function computeFeatures(candles: Candle[]): FeatureVector[] {
  const n = candles.length;
  if (n === 0) return [];
  const closes = candles.map((c) => c.close);
  const logReturns = new Array<number>(n);
  logReturns[0] = 0;
  for (let i = 1; i < n; i++) {
    logReturns[i] = logReturn(closes[i - 1]!, closes[i]!);
  }

  const eta = THRESHOLDS.emaEta;
  const priceLambda = 2 / (THRESHOLDS.priceEmaSpan + 1);
  const emaPrice = recursiveEma(closes, priceLambda);
  const emaSignal = grebenkovReturnSignal(logReturns, eta);
  const rsi = rsiSma(closes, THRESHOLDS.rsiPeriod);
  const vol = rollingStd(logReturns, THRESHOLDS.volWindow);
  const dd = runningDrawdown(closes);
  const warmup = Math.max(
    THRESHOLDS.volWindow,
    THRESHOLDS.rsiPeriod + 1,
    THRESHOLDS.priceEmaSpan,
  );

  const out: FeatureVector[] = [];
  for (let i = 0; i < n; i++) {
    const rv = vol[i]!;
    const ready = i >= warmup && Number.isFinite(rsi[i]!) && Number.isFinite(rv);
    const disp =
      emaPrice[i]! === 0 ? 0 : (closes[i]! - emaPrice[i]!) / emaPrice[i]!;
    const dispZ = rv > 0 ? disp / rv : 0;
    const z = rv > 0 ? logReturns[i]! / rv : 0;
    out.push({
      barIndex: i,
      timestamp: candles[i]!.t,
      close: closes[i]!,
      volume: candles[i]!.volume,
      logReturn: logReturns[i]!,
      normalizedReturn: ready ? z : Number.NaN,
      emaReturnSignal: emaSignal[i]!,
      emaPrice: emaPrice[i]!,
      displacementFromEma: disp,
      displacementZ: ready ? dispZ : Number.NaN,
      rsi14: rsi[i]!,
      realizedVol: rv,
      drawdown: dd[i]!,
      warmupComplete: ready,
    });
  }
  return out;
}
