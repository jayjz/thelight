import { SYMBOL } from "./types.ts";
import type { Candle } from "./types.ts";

/** Deterministic PRNG. Same seed ⇒ same path. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function nextBusinessDayUtc(ms: number): number {
  const d = new Date(ms);
  d.setUTCDate(d.getUTCDate() + 1);
  const day = d.getUTCDay();
  if (day === 6) d.setUTCDate(d.getUTCDate() + 2);
  if (day === 0) d.setUTCDate(d.getUTCDate() + 1);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 21, 0, 0);
}

export const SYNTHETIC_SEED = 20260919;
export const SYNTHETIC_BARS = 320;
export const SYNTHETIC_START_UTC = Date.UTC(2024, 0, 2, 21, 0, 0);

/**
 * Seeded synthetic OHLCV with four visual regimes so the terminal can
 * demonstrate gating. This is NOT market data. Do not evaluate as a backtest
 * of a listed instrument.
 */
export function generateSyntheticCandles(
  seed = SYNTHETIC_SEED,
  bars = SYNTHETIC_BARS,
): Candle[] {
  const rng = mulberry32(seed);
  const candles: Candle[] = [];
  let t = SYNTHETIC_START_UTC;
  let price = 100;
  let prevClose = 100;

  for (let i = 0; i < bars; i++) {
    const phase = Math.floor(i / 80);
    let drift = 0;
    let vol = 0.011;
    let meanRevert = 0;
    if (phase === 0) {
      drift = 0.0002;
      vol = 0.008;
    } else if (phase === 1) {
      drift = 0.0018;
      vol = 0.01;
    } else if (phase === 2) {
      drift = 0;
      vol = 0.009;
      meanRevert = 0.12;
    } else {
      drift = -0.0015;
      vol = 0.014;
    }

    const shock = vol * gaussian(rng);
    const pull = meanRevert > 0 ? -meanRevert * Math.log(price / 108) : 0;
    const r = drift + pull + shock;
    const close = prevClose * Math.exp(r);
    const wick = vol * (0.4 + rng()) * prevClose;
    const open = prevClose * (1 + (rng() - 0.5) * vol * 0.3);
    const high = Math.max(open, close) + Math.abs(wick) * rng();
    const low = Math.min(open, close) - Math.abs(wick) * rng();
    const volume = Math.round(1_200_000 * (1 + 8 * Math.abs(r)) * (0.7 + rng()));

    candles.push({
      t,
      open,
      high: Math.max(high, open, close),
      low: Math.min(low, open, close),
      close,
      volume,
    });
    prevClose = close;
    price = close;
    t = nextBusinessDayUtc(t);
  }
  return candles;
}

export const SERIES_META = {
  symbol: SYMBOL,
  timeframe: "1D",
  vendor: "none",
  kind: "synthetic_seeded",
  seed: SYNTHETIC_SEED,
} as const;
