import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALPACA_DATA_BASE_URL,
  ALPACA_PAPER_BASE_URL,
  AlpacaPaperExecution,
  AlpacaHistoricalStockBars,
  AlpacaPaperTradeUpdates,
  AlpacaMarketSource,
  AlpacaTransportError,
  brokerStateFromTradeUpdate,
  closedBarFromAlpaca,
  loadAlpacaConfig,
  loadLocalMarketDataUrl,
  websocketPayloadToText,
} from "./alpaca.server.ts";
import type { ExecutionIntent } from "./types.ts";

const reconciledFlatPosition = {
  symbol: "SPY",
  quantity: 0,
  reconciledAt: "2026-09-19T00:00:00.000Z",
  provenance: "ALPACA_RECONCILED" as const,
};

const env = {
  ALPACA_API_KEY_ID: "key",
  ALPACA_API_SECRET_KEY: "secret",
  ALPACA_SYMBOL: "SPY",
} as NodeJS.ProcessEnv;

const intent: ExecutionIntent = {
  intentId: "LL-SPY-0001:intent",
  decisionId: "LL-SPY-0001",
  createdAtBar: 1,
  createdAtTimestamp: 1,
  desiredAction: "LONG",
  desiredPosition: 1,
  status: "PENDING",
  executionModel: "ALPACA_PAPER",
};

class FakeWebSocket {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void | Promise<void>>>();

  send(payload: string): void { this.sent.push(payload); }
  close(): void { this.closed = true; }
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown }) => void | Promise<void>): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }
  open(): Promise<void> { return this.emit("open"); }
  message(payload: unknown): Promise<void> { return this.emit("message", payload); }

  private async emit(type: "open" | "message" | "error" | "close", data?: unknown): Promise<void> {
    for (const listener of this.listeners.get(type) ?? []) await listener({ data });
  }
}

describe("Alpaca paper boundaries", () => {
  it("requires credentials and fixes paper/data domains", () => {
    assert.throws(() => loadAlpacaConfig({}), /Missing ALPACA_API_KEY_ID/);
    const config = loadAlpacaConfig(env);
    assert.equal(config.paperBaseUrl, ALPACA_PAPER_BASE_URL);
    assert.equal(config.dataBaseUrl, ALPACA_DATA_BASE_URL);
    assert.throws(() => loadAlpacaConfig({ ...env, ALPACA_PAPER_BASE_URL: "https://example.invalid" }), /fixed Alpaca paper domain/);
    assert.throws(() => loadAlpacaConfig({ ...env, ALPACA_PAPER_BASE_URL: "https://api.alpaca.markets" }), /fixed Alpaca paper domain/);
  });

  it("derives the default SPY market source as an IEX subscription", async () => {
    const socket = new FakeWebSocket();
    const source = new AlpacaMarketSource(loadAlpacaConfig({ ALPACA_API_KEY_ID: "key", ALPACA_API_SECRET_KEY: "secret" }), () => socket);
    assert.equal(source.id, "alpaca:iex:SPY:1Min");
    const iterator = source.bars()[Symbol.asyncIterator]();
    void iterator.next();
    await socket.message(JSON.stringify([{ T: "success", msg: "connected" }]));
    await socket.message(JSON.stringify([{ T: "success", msg: "authenticated" }]));
    assert.deepEqual(socket.sent.map((payload) => JSON.parse(payload)), [
      { action: "auth", key: "key", secret: "secret" },
      { action: "subscribe", bars: ["SPY"] },
    ]);
  });

  it("uses the fixed local relay without sending data credentials and preserves a completed SPY bar", async () => {
    const config = loadAlpacaConfig(env);
    const directSocket = new FakeWebSocket();
    const localSocket = new FakeWebSocket();
    const now = Date.parse("2026-01-01T00:01:00Z");
    const direct = new AlpacaMarketSource(config, () => directSocket, () => now).bars()[Symbol.asyncIterator]();
    const local = new AlpacaMarketSource(
      config,
      () => localSocket,
      () => now,
      "ws://127.0.0.1:8765",
    ).bars()[Symbol.asyncIterator]();
    const directNext = direct.next();
    const localNext = local.next();
    const bar = { T: "b", S: "SPY", o: 1, h: 2, l: 0.5, c: 1.5, v: 10, t: "2026-01-01T00:00:00Z" };

    await directSocket.message(JSON.stringify([{ T: "success", msg: "connected" }]));
    await directSocket.message(JSON.stringify([{ T: "success", msg: "authenticated" }]));
    await directSocket.message(JSON.stringify([bar]));
    await localSocket.open();
    await localSocket.message(JSON.stringify([{ T: "subscription", bars: ["SPY"], quotes: [] }]));
    await localSocket.message(JSON.stringify([bar]));

    assert.deepEqual((await directNext).value, await localNext.then((result) => result.value));
    assert.deepEqual(localSocket.sent.map((payload) => JSON.parse(payload)), [{ action: "subscribe", bars: ["SPY"] }]);
    assert.ok(!JSON.stringify(localSocket.sent).includes(config.apiSecretKey));
    await direct.return?.();
    await local.return?.();
  });

  it("allows only the fixed localhost relay origin", () => {
    assert.equal(loadLocalMarketDataUrl({}), null);
    assert.equal(loadLocalMarketDataUrl({ ALPACA_LOCAL_FEED_URL: "ws://127.0.0.1:8765" }), "ws://127.0.0.1:8765");
    assert.throws(
      () => loadLocalMarketDataUrl({ ALPACA_LOCAL_FEED_URL: "ws://example.invalid:8765" }),
      /fixed localhost market-data relay/,
    );
    assert.throws(
      () => new AlpacaMarketSource(loadAlpacaConfig(env), undefined, undefined, "ws://example.invalid:8765"),
      /fixed localhost relay/,
    );
  });

  it("accepts only a completed 1Min market-data bar", () => {
    const message = { T: "b" as const, S: "SPY", o: 1, h: 2, l: 0.5, c: 1.5, v: 10, t: "2026-01-01T00:00:00Z" };
    assert.equal(closedBarFromAlpaca(message, Date.parse("2026-01-01T00:00:30Z")), null);
    assert.equal(closedBarFromAlpaca(message, Date.parse("2026-01-01T00:01:00Z"))?.close, 1.5);
  });

  it("uses a read-only fixed SPY/IEX 1Min historical boundary", async () => {
    let requested = "";
    const historical = new AlpacaHistoricalStockBars(loadAlpacaConfig(env), async (url) => {
      requested = String(url);
      return new Response(JSON.stringify({ bars: { SPY: [{ t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] } }), { status: 200 });
    });
    const bars = await historical.bars({ symbol: "SPY", start: Date.parse("2026-01-01T00:00:00Z"), end: Date.parse("2026-01-01T00:01:00Z") });
    assert.equal(bars.length, 1);
    assert.match(requested, /\/v2\/stocks\/bars\?/);
    assert.match(requested, /timeframe=1Min/); assert.match(requested, /feed=iex/); assert.match(requested, /symbols=SPY/);
  });

  it("accepts a complete bounded interval even when Alpaca returns a next-page token", async () => {
    const historical = new AlpacaHistoricalStockBars(loadAlpacaConfig(env), async () => new Response(JSON.stringify({
      bars: { SPY: [
        { t: "2026-09-21T15:30:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
        { t: "2026-09-21T15:31:00Z", o: 2, h: 3, l: 1.5, c: 2.5, v: 20 },
      ] },
      next_page_token: "continuation-is-irrelevant-after-completeness-check",
    }), { status: 200 }));
    const bars = await historical.bars({ symbol: "SPY", start: Date.parse("2026-09-21T15:30:00Z"), end: Date.parse("2026-09-21T15:32:00Z") });
    assert.deepEqual(bars.map((bar) => bar.t), [Date.parse("2026-09-21T15:30:00Z"), Date.parse("2026-09-21T15:31:00Z")]);
  });

  it("rejects an incomplete bounded interval even when Alpaca returns a next-page token", async () => {
    const historical = new AlpacaHistoricalStockBars(loadAlpacaConfig(env), async () => new Response(JSON.stringify({
      bars: { SPY: [{ t: "2026-09-21T15:30:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] },
      next_page_token: "more-results",
    }), { status: 200 }));
    await assert.rejects(
      historical.bars({ symbol: "SPY", start: Date.parse("2026-09-21T15:30:00Z"), end: Date.parse("2026-09-21T15:32:00Z") }),
      (error: unknown) => error instanceof AlpacaTransportError && error.kind === "PROTOCOL_FAILURE" && /incomplete/.test(error.message),
    );
  });

  it("accepts an exact complete historical interval without a page token", async () => {
    const historical = new AlpacaHistoricalStockBars(loadAlpacaConfig(env), async () => new Response(JSON.stringify({ bars: { SPY: [
      { t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { t: "2026-01-01T00:01:00Z", o: 2, h: 3, l: 1.5, c: 2.5, v: 20 },
    ] } }), { status: 200 }));
    const bars = await historical.bars({ symbol: "SPY", start: Date.parse("2026-01-01T00:00:00Z"), end: Date.parse("2026-01-01T00:02:00Z") });
    assert.equal(bars.length, 2);
  });

  it("rejects duplicate historical timestamps rather than filling a gap", async () => {
    const historical = new AlpacaHistoricalStockBars(loadAlpacaConfig(env), async () => new Response(JSON.stringify({ bars: { SPY: [
      { t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
      { t: "2026-01-01T00:00:00Z", o: 2, h: 3, l: 1.5, c: 2.5, v: 20 },
    ] } }), { status: 200 }));
    await assert.rejects(
      historical.bars({ symbol: "SPY", start: Date.parse("2026-01-01T00:00:00Z"), end: Date.parse("2026-01-01T00:01:00Z") }),
      (error: unknown) => error instanceof AlpacaTransportError && error.kind === "PROTOCOL_FAILURE" && /duplicate timestamps/.test(error.message),
    );
  });

  it("rejects out-of-range historical timestamps", async () => {
    const historical = new AlpacaHistoricalStockBars(loadAlpacaConfig(env), async () => new Response(JSON.stringify({ bars: { SPY: [
      { t: "2026-01-01T00:01:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
    ] } }), { status: 200 }));
    await assert.rejects(
      historical.bars({ symbol: "SPY", start: Date.parse("2026-01-01T00:00:00Z"), end: Date.parse("2026-01-01T00:01:00Z") }),
      (error: unknown) => error instanceof AlpacaTransportError && error.kind === "PROTOCOL_FAILURE",
    );
  });

  it("normalizes string, Blob, and ArrayBuffer WebSocket payloads to UTF-8 text", async () => {
    const payload = JSON.stringify({ stream: "trade_updates" });
    const bytes = new TextEncoder().encode(payload);
    assert.equal(await websocketPayloadToText(payload), payload);
    assert.equal(await websocketPayloadToText(new Blob([payload])), payload);
    assert.equal(await websocketPayloadToText(bytes.buffer), payload);
  });

  it("accepts completed market bars from Blob and ArrayBuffer WebSocket messages", async () => {
    const now = Date.parse("2026-01-01T00:01:00Z");
    const messages = [
      new Blob([JSON.stringify([{ T: "b", S: "SPY", o: 1, h: 2, l: 0.5, c: 1.5, v: 10, t: "2026-01-01T00:00:00Z" }])]),
      new TextEncoder().encode(JSON.stringify([{ T: "b", S: "SPY", o: 2, h: 3, l: 1.5, c: 2.5, v: 20, t: "2026-01-01T00:00:00Z" }])).buffer,
    ];
    for (const payload of messages) {
      const socket = new FakeWebSocket();
      const bars = new AlpacaMarketSource(loadAlpacaConfig(env), () => socket, () => now).bars();
      const iterator = bars[Symbol.asyncIterator]();
      const nextBar = iterator.next();
      await socket.message(payload);
      assert.equal((await nextBar).value?.close, payload instanceof Blob ? 1.5 : 2.5);
      await iterator.return?.();
    }
  });

  it("reconciles before submitting and posts only to the fixed paper orders endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (String(url).includes("by_client_order_id")) return new Response("", { status: 404 });
      return Response.json({ id: "broker-1", status: "accepted", client_order_id: intent.intentId });
    };
    const execution = new AlpacaPaperExecution(loadAlpacaConfig(env), request as typeof fetch);
    const state = await execution.submit(intent, reconciledFlatPosition);
    assert.equal(state.status, "ACCEPTED");
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.url, `${ALPACA_PAPER_BASE_URL}/v2/orders`);
    assert.equal(calls[1]!.init?.method, "POST");
    assert.match(String(calls[1]!.init?.body), /client_order_id/);
  });

  it("halts normal dispatch after an unknown POST even when later lookup remains absent", async () => {
    let lookups = 0;
    let posts = 0;
    const request = async (url: string | URL | Request): Promise<Response> => {
      if (String(url).includes("by_client_order_id")) {
        lookups += 1;
        return new Response("", { status: 404 });
      }
      posts += 1;
      throw new Error("transport result lost after broker may have accepted order");
    };
    const execution = new AlpacaPaperExecution(loadAlpacaConfig(env), request as typeof fetch);
    const first = await execution.submit(intent, reconciledFlatPosition);
    assert.equal(first.status, "UNKNOWN");
    assert.equal(first.lookup, "UNRESOLVED");
    assert.equal(posts, 1);

    const unknownIntent = { ...intent, status: first.status };
    const absent = await execution.reconcile(unknownIntent);
    assert.equal(absent.lookup, "ABSENT");
    assert.equal(absent.status, "UNKNOWN");

    const normalDispatch = await execution.submit(unknownIntent, reconciledFlatPosition);
    assert.equal(normalDispatch.lookup, "ABSENT");
    assert.equal(normalDispatch.status, "UNKNOWN");
    assert.equal(posts, 1, "normal dispatch must not issue a second POST after UNKNOWN");
    assert.equal(lookups, 3);
  });

  it("calculates order quantity from the reconciled broker position, not caller-local state", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (String(url).includes("by_client_order_id")) return new Response("", { status: 404 });
      return Response.json({ id: "broker-2", status: "accepted", client_order_id: intent.intentId });
    };
    const execution = new AlpacaPaperExecution(loadAlpacaConfig(env), request as typeof fetch);
    const state = await execution.submit(intent, { ...reconciledFlatPosition, quantity: -1 });
    assert.equal(state.status, "ACCEPTED");
    const body = JSON.parse(String(calls[1]!.init?.body)) as { qty: string; side: string };
    assert.equal(body.qty, "2");
    assert.equal(body.side, "buy");
  });

  it("models trade updates separately and references the originating intent", () => {
    const state = brokerStateFromTradeUpdate(
      { stream: "trade_updates", data: { event: "fill", order: { id: "broker-2", status: "filled", client_order_id: intent.intentId } } },
      intent,
    );
    assert.equal(state?.decisionId, intent.decisionId);
    assert.equal(state?.status, "FILLED");
  });

  it("authenticates and subscribes trade updates in Alpaca protocol order with Blob messages", async () => {
    const socket = new FakeWebSocket();
    const updates: Array<Record<string, unknown>> = [];
    const errors: Error[] = [];
    let ready = 0;
    new AlpacaPaperTradeUpdates(loadAlpacaConfig(env), () => socket).connect(
      (update) => updates.push(update),
      (error) => errors.push(error),
      () => { ready += 1; },
    );

    assert.deepEqual(socket.sent, [], "socket construction must not send before open");
    await socket.open();
    await socket.open();
    assert.deepEqual(socket.sent.map((payload) => JSON.parse(payload)), [
      { action: "auth", key: "key", secret: "secret" },
    ], "auth is sent exactly once after open");

    const authorization = socket.message(new Blob([JSON.stringify({ stream: "authorization", data: { status: "authorized", action: "authenticate" } })]));
    const listening = socket.message(new Blob([JSON.stringify({ stream: "listening", data: { streams: ["trade_updates"] } })]));
    assert.equal(ready, 0, "authorization alone is not a subscribed stream");
    await Promise.all([authorization, listening]);
    assert.deepEqual(socket.sent.map((payload) => JSON.parse(payload)).at(-1), {
      action: "listen", data: { streams: ["trade_updates"] },
    });

    // Alpaca acknowledges `listen` on `stream: listening`; readiness is the
    // strongest protocol boundary because the acknowledgement lists active streams.
    assert.equal(ready, 1);
    await socket.message(new Blob([JSON.stringify({ stream: "trade_updates", data: { event: "fill", order: { id: "broker-1" } } })]));
    assert.equal(updates.length, 1, "updates are delivered only after authorization and subscription readiness");
    assert.deepEqual(errors, []);
  });

  it("reports Alpaca authorization rejection as an authentication failure", async () => {
    const socket = new FakeWebSocket();
    const errors: Error[] = [];
    new AlpacaPaperTradeUpdates(loadAlpacaConfig(env), () => socket).connect(
      () => undefined,
      (error) => errors.push(error),
      () => assert.fail("unauthorized stream must never become ready"),
    );
    await socket.open();
    await socket.message(JSON.stringify({ stream: "authorization", data: { status: "unauthorized", action: "authenticate" } }));
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof AlpacaTransportError);
    assert.equal((errors[0] as AlpacaTransportError).kind, "AUTHENTICATION_FAILURE");
    assert.equal(socket.sent.length, 1, "rejected authentication must not send listen");
  });

  it("reports invalid WebSocket payloads as disconnected streams", async () => {
    const socket = new FakeWebSocket();
    const errors: Error[] = [];
    new AlpacaPaperTradeUpdates(loadAlpacaConfig(env), () => socket).connect(
      () => undefined,
      (error) => errors.push(error),
      () => undefined,
    );
    await socket.message({ unsupported: true });
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof AlpacaTransportError);
    assert.equal((errors[0] as AlpacaTransportError).kind, "DISCONNECTED_STREAM");
  });
});
