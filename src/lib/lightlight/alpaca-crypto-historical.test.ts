import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlpacaCryptoHistoricalBarsClient, ALPACA_CRYPTO_BARS_URL, CryptoHistoricalError, MIN_BOOTSTRAP_VERIFIED_MINUTES, analyzeBootstrapCoverage, verifyExactBars } from "./alpaca-crypto-historical.server.ts";

const t = Date.parse("2026-01-04T12:00:00Z");
const raw = (time = t, volume = 2) => ({ t: new Date(time).toISOString(), o: 100, h: 102, l: 99, c: 101, v: volume });
const response = (bars: unknown[] = [raw()], token: string | null = null) => new Response(JSON.stringify({ bars: { "BTC/USD": bars }, next_page_token: token }));
const interval = (endMs = t) => ({ symbol: "BTC/USD" as const, startMs: t, endMs });
const credentials = { apiKeyId: "test-key", apiSecretKey: "test-secret" };
const errorCode = (code: string) => (error: unknown) => error instanceof CryptoHistoricalError && error.code === code;
globalThis.fetch = async () => { throw new Error("REAL_NETWORK_FORBIDDEN"); };
const client = (fetch: typeof globalThis.fetch, options = {}) => new AlpacaCryptoHistoricalBarsClient(credentials, { fetch, now: () => t + 600_000, sleep: async () => undefined, ...options });

describe("BTC historical market-data client", () => {
  it("sends only the exact inclusive BTC/USD 1Min interval to a fixed GET endpoint", async () => {
    let calls = 0;
    const c = client(async (input, init) => {
      calls++; const url = new URL(String(input));
      assert.equal(url.origin + url.pathname, ALPACA_CRYPTO_BARS_URL);
      assert.deepEqual(Object.fromEntries(url.searchParams), { symbols: "BTC/USD", timeframe: "1Min", start: new Date(t).toISOString(), end: new Date(t).toISOString(), sort: "asc", limit: "10000" });
      assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
      assert.deepEqual(init?.headers, { "APCA-API-KEY-ID": "test-key", "APCA-API-SECRET-KEY": "test-secret" });
      return response();
    });
    assert.equal((await c.fetchCompletedBars(interval()))[0]?.t, t); assert.equal(calls, 1);
  });
  for (const full of [false, true]) it(`follows every token even when first page looks ${full ? "full" : "short"}`, async () => {
    const tokens: (string | null)[] = [];
    const c = client(async input => {
      const token = new URL(String(input)).searchParams.get("page_token"); tokens.push(token);
      if (!token) return response(full ? Array.from({ length: 10000 }, () => raw()) : [], "page-2");
      if (token === "page-2") return response([raw()], "page-3");
      return response([raw(t + 60_000)]);
    });
    assert.equal((await c.fetchCompletedBars(interval(t + 60_000))).length, 2);
    assert.deepEqual(tokens, [null, "page-2", "page-3"]);
  });
  it("rejects repeated pagination tokens", async () => {
    let calls = 0;
    await assert.rejects(client(async () => { calls++; return response([raw()], "loop"); }).fetchCompletedBars(interval()), errorCode("PROTOCOL_FAILURE"));
    assert.equal(calls, 2);
  });
  for (const body of ["not-json", "[]", "null", '{}', '{"bars":[],"next_page_token":null}', '{"bars":{}}']) it(`rejects malformed JSON/shape ${body}`, async () => {
    await assert.rejects(client(async () => new Response(body)).fetchCompletedBars(interval()), errorCode("PROTOCOL_FAILURE"));
  });
  for (const status of [401, 403, 400]) it(`${status} is terminal`, async () => {
    let calls = 0;
    await assert.rejects(client(async () => { calls++; return new Response(null, { status }); }).fetchCompletedBars(interval()), errorCode(status === 400 ? "HTTP_FAILURE" : "AUTHENTICATION_FAILURE"));
    assert.equal(calls, 1);
  });
  for (const status of [429, 500, 503]) it(`${status} retries deterministically and stops after three reads`, async () => {
    let calls = 0; const delays: number[] = [];
    await assert.rejects(client(async () => { calls++; return new Response(null, { status }); }, { sleep: async (ms: number) => { delays.push(ms); } }).fetchCompletedBars(interval()), errorCode("HTTP_FAILURE"));
    assert.equal(calls, 3); assert.deepEqual(delays, [250, 500]);
  });
  it("honors rate-limit headers and fails rather than retrying earlier than a long reset", async () => {
    const delays: number[] = []; let calls = 0;
    const c = client(async () => ++calls === 1 ? new Response(null, { status: 429, headers: { "retry-after": "1", "x-ratelimit-reset": String((t + 602_000) / 1000) } }) : response(), { sleep: async (ms: number) => { delays.push(ms); } });
    await c.fetchCompletedBars(interval()); assert.deepEqual(delays, [2000]);
    calls = 0;
    await assert.rejects(client(async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": "60" } }); }).fetchCompletedBars(interval()), errorCode("HTTP_FAILURE"));
    assert.equal(calls, 1);
  });
  it("bounds request timeout including a stalled body, and total pagination time", async () => {
    let calls = 0;
    await assert.rejects(client(async () => { calls++; return new Promise<Response>(() => undefined); }, { requestTimeoutMs: 2 }).fetchCompletedBars(interval()), errorCode("TIMEOUT"));
    assert.equal(calls, 3);
    await assert.rejects(client(async () => new Response(new ReadableStream({ start() {} })), { requestTimeoutMs: 2 }).fetchCompletedBars(interval()), errorCode("TIMEOUT"));
    await assert.rejects(client(async () => new Promise<Response>(() => undefined), { totalTimeoutMs: 2 }).fetchCompletedBars(interval()), errorCode("TIMEOUT"));
  });
  it("retries a transport failure while reading a successful response body", async () => {
    let calls = 0;
    const c = client(async () => {
      calls++;
      if (calls === 1) {
        const interrupted = response();
        Object.defineProperty(interrupted, "text", { value: async () => { throw new TypeError("connection reset during body read"); } });
        return interrupted;
      }
      return response();
    });
    assert.equal((await c.fetchCompletedBars(interval())).length, 1);
    assert.equal(calls, 2);
  });
  it("rejects wrong symbols even alongside valid BTC bars", async () => {
    await assert.rejects(client(async () => new Response(JSON.stringify({ bars: { "BTC/USD": [raw()], "ETH/USD": [] }, next_page_token: null }))).fetchCompletedBars(interval()), errorCode("PROTOCOL_FAILURE"));
  });
  for (const bad of [raw(t - 60_000), raw(t + 60_000), raw(t + 1), { ...raw(), t: "2026-02-30T12:00:00Z" }, { ...raw(), o: "100" }, { ...raw(), h: 1 }, { ...raw(), l: 200 }, { ...raw(), v: -1 }, { ...raw(), c: null }, { ...raw(), T: "u" }, { ...raw(), T: "b", S: "BTC/USD" }]) it(`rejects out-of-range, malformed or live-only bar ${JSON.stringify(bad)}`, async () => {
    await assert.rejects(client(async () => response([bad])).fetchCompletedBars(interval()), errorCode("PROTOCOL_FAILURE"));
  });
  it("deduplicates identical bars and accepts valid zero-volume quote-midpoint bars", async () => {
    const bars = await client(async () => response([raw(t, 0), raw(t, 0)])).fetchCompletedBars(interval());
    assert.equal(bars.length, 1); assert.equal(bars[0]?.volume, 0);
  });
  it("preserves RFC3339 offset timestamps as the exact provider instant", async () => {
    const bars = await client(async () => response([{ ...raw(), t: "2026-01-04T07:00:00-05:00" }])).fetchCompletedBars(interval());
    assert.equal(bars[0]?.t, t);
  });
  it("rejects conflicting duplicates across pages", async () => {
    let calls = 0;
    await assert.rejects(client(async () => ++calls === 1 ? response([raw()], "next") : response([{ ...raw(), c: 100 }])).fetchCompletedBars(interval()), errorCode("CONFLICT"));
  });
  it("preserves provider-absent minutes for bootstrap analysis while exact repair remains strict", async () => {
    const sparse = await client(async () => response([raw()])).fetchCompletedBars(interval(t + 60_000));
    assert.deepEqual(sparse.map(bar => bar.t), [t]);
    assert.throws(() => verifyExactBars(sparse, interval(t + 60_000)), errorCode("INCOMPLETE_RECOVERY"));
  });
  it("qualifies only a suffix at the frozen bootstrap threshold", () => {
    const startMs = t - (MIN_BOOTSTRAP_VERIFIED_MINUTES + 2) * 60_000;
    const endMs = t;
    const sixty = Array.from({ length: MIN_BOOTSTRAP_VERIFIED_MINUTES }, (_, index) => raw(endMs - (MIN_BOOTSTRAP_VERIFIED_MINUTES - 1 - index) * 60_000));
    const coverage = analyzeBootstrapCoverage(sixty.map(value => ({ t: Date.parse(value.t), open: value.o, high: value.h, low: value.l, close: value.c, volume: value.v })), { symbol: "BTC/USD", startMs, endMs });
    assert.equal(coverage.qualifies, true); assert.equal(coverage.verifiedContiguousMinuteCount, MIN_BOOTSTRAP_VERIFIED_MINUTES);
    const fiftyNine = coverage.verifiedStartMs === null ? [] : sixty.slice(1);
    const short = analyzeBootstrapCoverage(fiftyNine.map(value => ({ t: Date.parse(value.t), open: value.o, high: value.h, low: value.l, close: value.c, volume: value.v })), { symbol: "BTC/USD", startMs, endMs });
    assert.equal(short.qualifies, false); assert.equal(short.verifiedContiguousMinuteCount, MIN_BOOTSTRAP_VERIFIED_MINUTES - 1);
  });
  it("qualifies the latest returned 60-minute suffix when the requested end minute is absent", () => {
    const endMs = t;
    const returned = Array.from({ length: 60 }, (_, index) => ({ t: endMs - (60 - index) * 60_000, open: 100, high: 102, low: 99, close: 101, volume: 0 }));
    const coverage = analyzeBootstrapCoverage(returned, { symbol: "BTC/USD", startMs: endMs - 60 * 60_000, endMs });
    assert.equal(coverage.missingMinuteCount, 1);
    assert.deepEqual(coverage.missingRanges, [{ startMs: endMs, endMs }]);
    assert.equal(coverage.verifiedContiguousMinuteCount, 60);
    assert.equal(coverage.verifiedThroughMs, endMs - 60_000);
    assert.equal(coverage.verifiedStartMs, endMs - 60 * 60_000);
    assert.equal(coverage.qualifies, true);
  });
  it("rejects incomplete minute, nonaligned, wrong-symbol and over-horizon requests before GET", async () => {
    let calls = 0; const c = client(async () => { calls++; return response(); });
    for (const request of [{ ...interval(), startMs: t + 1 }, interval(t + 600_000), { ...interval(), startMs: t - 24 * 60 * 60_000 }, { ...interval(), symbol: "ETH/USD" as "BTC/USD" }]) await assert.rejects(c.fetchCompletedBars(request), errorCode("PROTOCOL_FAILURE"));
    assert.equal(calls, 0);
  });
});
