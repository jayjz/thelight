import type { ClosedBar } from "./types.ts";
import type { AlpacaCryptoCredentials } from "./alpaca-crypto.server.ts";

export const ALPACA_CRYPTO_BARS_URL = "https://data.alpaca.markets/v1beta3/crypto/us/bars";
export const BTC_RECOVERY_WINDOW_MS = 24 * 60 * 60_000;
export const MIN_BOOTSTRAP_VERIFIED_MINUTES = 60;
export type HistoricalInterval = { symbol: "BTC/USD"; startMs: number; endMs: number };
export type CryptoHistoricalBars = { fetchCompletedBars(interval: HistoricalInterval): Promise<ClosedBar[]> };
export type HistoricalMissingRange = { startMs: number; endMs: number };
export type BootstrapCoverage = {
  requestedBarCount: number;
  returnedBarCount: number;
  missingMinuteCount: number;
  missingRanges: HistoricalMissingRange[];
  verifiedStartMs: number | null;
  verifiedThroughMs: number | null;
  verifiedContiguousMinuteCount: number;
  qualifies: boolean;
};
export type HistoricalFailure = "AUTHENTICATION_FAILURE" | "TIMEOUT" | "HTTP_FAILURE" | "PROTOCOL_FAILURE" | "INCOMPLETE_RECOVERY" | "CONFLICT";
export class CryptoHistoricalError extends Error {
  readonly code: HistoricalFailure;
  fetchedBarCount = 0;
  constructor(code: HistoricalFailure) { super(code); this.name = "CryptoHistoricalError"; this.code = code; }
}
const fail = (code: HistoricalFailure): never => { throw new CryptoHistoricalError(code); };
export const sameClosedBar = (a: ClosedBar, b: ClosedBar): boolean =>
  a.t === b.t && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;
export function validateHistoricalInterval(interval: HistoricalInterval, now: number): void {
  if (interval.symbol !== "BTC/USD" || !Number.isSafeInteger(interval.startMs) || !Number.isSafeInteger(interval.endMs) ||
    interval.startMs % 60_000 !== 0 || interval.endMs % 60_000 !== 0 || interval.startMs > interval.endMs ||
    interval.endMs - interval.startMs + 60_000 > BTC_RECOVERY_WINDOW_MS || !Number.isFinite(now) || interval.endMs + 60_000 > now) fail("PROTOCOL_FAILURE");
}
/** Also used after durable persistence: a count alone is never continuity proof. */
export function verifyExactBars(bars: ClosedBar[], interval: HistoricalInterval): void {
  if (bars.length !== (interval.endMs - interval.startMs) / 60_000 + 1) fail("INCOMPLETE_RECOVERY");
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.t !== interval.startMs + i * 60_000) fail("INCOMPLETE_RECOVERY");
    if ([b.open, b.high, b.low, b.close, b.volume].some(v => !Number.isFinite(v)) ||
      Math.min(b.open, b.high, b.low, b.close) <= 0 || b.volume < 0 || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)) fail("PROTOCOL_FAILURE");
  }
}
export function validateHistoricalBars(bars: ClosedBar[], interval: HistoricalInterval): void {
  let previous = interval.startMs - 60_000;
  for (const bar of bars) {
    if (bar.t <= previous) fail("PROTOCOL_FAILURE");
    verifyExactBars([bar], { ...interval, startMs: bar.t, endMs: bar.t });
    previous = bar.t;
  }
}
export function analyzeBootstrapCoverage(bars: ClosedBar[], interval: HistoricalInterval): BootstrapCoverage {
  validateHistoricalBars(bars, interval);
  const present = new Set(bars.map((bar) => bar.t));
  const missingRanges: HistoricalMissingRange[] = [];
  for (let timestamp = interval.startMs; timestamp <= interval.endMs; timestamp += 60_000) {
    if (present.has(timestamp)) continue;
    const prior = missingRanges.at(-1);
    if (prior && prior.endMs + 60_000 === timestamp) prior.endMs = timestamp;
    else missingRanges.push({ startMs: timestamp, endMs: timestamp });
  }
  let verifiedContiguousMinuteCount = 0;
  const newestReturnedMs = bars.at(-1)?.t ?? null;
  for (let timestamp = newestReturnedMs; timestamp !== null && present.has(timestamp); timestamp -= 60_000) verifiedContiguousMinuteCount += 1;
  const verifiedThroughMs = verifiedContiguousMinuteCount ? newestReturnedMs : null;
  const verifiedStartMs = verifiedThroughMs === null ? null : verifiedThroughMs - (verifiedContiguousMinuteCount - 1) * 60_000;
  return {
    requestedBarCount: (interval.endMs - interval.startMs) / 60_000 + 1,
    returnedBarCount: bars.length,
    missingMinuteCount: missingRanges.reduce((count, range) => count + (range.endMs - range.startMs) / 60_000 + 1, 0),
    missingRanges, verifiedStartMs, verifiedThroughMs, verifiedContiguousMinuteCount,
    qualifies: verifiedContiguousMinuteCount >= MIN_BOOTSTRAP_VERIFIED_MINUTES,
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("PROTOCOL_FAILURE");
  return value as Record<string, unknown>;
}
function parseBar(raw: unknown, interval: HistoricalInterval): ClosedBar {
  const v = object(raw);
  // REST bars are symbol-keyed aggregates, never WebSocket b/u messages.
  if ("T" in v || "S" in v || typeof v.t !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.0+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v.t)) return fail("PROTOCOL_FAILURE");
  const t = Date.parse(v.t);
  if (!Number.isFinite(t) || new Date(Date.parse(v.t.slice(0, 19) + "Z")).toISOString().slice(0, 19) !== v.t.slice(0, 19) || t % 60_000 !== 0 ||
    t < interval.startMs || t > interval.endMs) return fail("PROTOCOL_FAILURE");
  const b = { t, open: v.o, high: v.h, low: v.l, close: v.c, volume: v.v } as ClosedBar;
  verifyExactBars([b], { ...interval, startMs: t, endMs: t });
  return b;
}

type Options = {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
};
/** Fixed GET-only market-data capability. No endpoint override or broker dependency. */
export class AlpacaCryptoHistoricalBarsClient implements CryptoHistoricalBars {
  private readonly credentials: AlpacaCryptoCredentials;
  private readonly options: Options;
  constructor(credentials: AlpacaCryptoCredentials, options: Options = {}) {
    this.credentials = credentials;
    this.options = options;
  }
  async fetchCompletedBars(interval: HistoricalInterval): Promise<ClosedBar[]> {
    validateHistoricalInterval(interval, (this.options.now ?? Date.now)());
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.collect(interval, controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new CryptoHistoricalError("TIMEOUT")); }, this.options.totalTimeoutMs ?? 20_000); }),
      ]);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  private async collect(interval: HistoricalInterval, signal: AbortSignal): Promise<ClosedBar[]> {
    const bars = new Map<number, ClosedBar>();
    const tokens = new Set<string>();
    let token: string | null = null;
    try {
      // Bounds pathological providers issuing endlessly different tokens as well.
      for (let page = 0; page < 1441; page++) {
        if (signal.aborted) return fail("TIMEOUT");
        const url = new URL(ALPACA_CRYPTO_BARS_URL);
        url.search = new URLSearchParams({ symbols: interval.symbol, timeframe: "1Min", start: new Date(interval.startMs).toISOString(), end: new Date(interval.endMs).toISOString(), sort: "asc", limit: "10000", ...(token === null ? {} : { page_token: token }) }).toString();
        const data = object(await this.page(url, signal));
        const bySymbol = object(data.bars);
        if (Object.keys(bySymbol).some(key => key !== interval.symbol) || (bySymbol[interval.symbol] !== undefined && !Array.isArray(bySymbol[interval.symbol]))) return fail("PROTOCOL_FAILURE");
        for (const raw of (bySymbol[interval.symbol] ?? []) as unknown[]) {
          const b = parseBar(raw, interval);
          const prior = bars.get(b.t);
          if (prior && !sameClosedBar(prior, b)) return fail("CONFLICT");
          bars.set(b.t, b);
        }
        const next = data.next_page_token;
        if (next === null) {
          const result = [...bars.values()].sort((a, b) => a.t - b.t);
          validateHistoricalBars(result, interval);
          return result;
        }
        if (typeof next !== "string" || !next || tokens.has(next)) return fail("PROTOCOL_FAILURE");
        tokens.add(next); token = next;
      }
      return fail("PROTOCOL_FAILURE");
    } catch (error) {
      if (error instanceof CryptoHistoricalError) error.fetchedBarCount = bars.size;
      throw error;
    }
  }
  private async page(url: URL, signal: AbortSignal): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) return fail("TIMEOUT");
      let retryMs = 250 * 2 ** attempt;
      let retryCode: HistoricalFailure = "HTTP_FAILURE";
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          (async () => {
            const response = await (this.options.fetch ?? globalThis.fetch)(url, {
              method: "GET", redirect: "error", signal: controller.signal,
              headers: { "APCA-API-KEY-ID": this.credentials.apiKeyId, "APCA-API-SECRET-KEY": this.credentials.apiSecretKey },
            });
            if (response.status === 401 || response.status === 403) return fail("AUTHENTICATION_FAILURE");
            if (response.status === 429 || response.status >= 500) {
              const retryAfter = response.headers.get("retry-after");
              const reset = response.headers.get("x-ratelimit-reset");
              const now = (this.options.now ?? Date.now)();
              if (retryAfter) retryMs = Math.max(retryMs, /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now);
              if (reset && Number.isFinite(Number(reset))) retryMs = Math.max(retryMs, Number(reset) * 1000 - now);
              await response.body?.cancel();
              return { retry: true as const };
            }
            if (!response.ok) return fail("HTTP_FAILURE");
            // Body transport errors are transient reads; only invalid JSON syntax
            // is a protocol failure. Keep these paths distinct for safe retries.
            const body = await response.text();
            try { return { retry: false as const, data: JSON.parse(body) as unknown }; }
            catch { return fail("PROTOCOL_FAILURE"); }
          })(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new CryptoHistoricalError("TIMEOUT")); }, this.options.requestTimeoutMs ?? 4_000); }),
        ]);
        if (!result.retry) return result.data;
      } catch (error) {
        if (error instanceof CryptoHistoricalError && error.code !== "TIMEOUT") throw error;
        retryCode = error instanceof CryptoHistoricalError ? error.code : "HTTP_FAILURE";
      } finally { clearTimeout(timer); controller.abort(); signal.removeEventListener("abort", abort); }
      // Never retry sooner than provider rate limits; long waits fail closed.
      if (signal.aborted) return fail("TIMEOUT");
      if (attempt === 2 || !Number.isFinite(retryMs) || retryMs > 5_000) return fail(retryCode);
      await (this.options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms))))(retryMs);
    }
    return fail("HTTP_FAILURE");
  }
}
