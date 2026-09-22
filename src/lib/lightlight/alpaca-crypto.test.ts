import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BTC_USD_SPEC } from "./assets.ts";
import {
  ALPACA_CRYPTO_STREAM_URL,
  AlpacaCryptoMarketSource,
  closedBarFromAlpacaCrypto,
} from "./alpaca-crypto.server.ts";
import { AlpacaTransportError, loadAlpacaConfig } from "./alpaca.server.ts";

const config = loadAlpacaConfig({
  ALPACA_API_KEY_ID: "key",
  ALPACA_API_SECRET_KEY: "secret",
} as NodeJS.ProcessEnv);
const now = Date.parse("2026-01-01T00:03:00.000Z");

class FakeWebSocket {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => unknown>>();

  send(payload: string): void { this.sent.push(payload); }
  close(): void { this.closed = true; }
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown }) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(listener);
    this.listeners.set(type, handlers);
  }
  async message(data: unknown): Promise<void> { await this.emit("message", data); }
  async error(): Promise<void> { await this.emit("error"); }
  async closeFromServer(): Promise<void> { await this.emit("close"); }

  private async emit(type: "open" | "message" | "error" | "close", data?: unknown): Promise<void> {
    for (const listener of this.listeners.get(type) ?? []) await listener({ data });
  }
}

const minuteBar = (overrides: Record<string, unknown> = {}) => ({
  T: "b" as const,
  S: BTC_USD_SPEC.symbol,
  o: 100,
  h: 102,
  l: 99,
  c: 101,
  v: 1.25,
  t: "2026-01-01T00:00:00Z",
  ...overrides,
});

async function authenticateAndSubscribe(socket: FakeWebSocket): Promise<void> {
  await socket.message(JSON.stringify([{ T: "success", msg: "connected" }]));
  await socket.message(JSON.stringify([{ T: "success", msg: "authenticated" }]));
  await socket.message(JSON.stringify([{ T: "subscription", bars: [BTC_USD_SPEC.symbol] }]));
}

describe("Alpaca BTC/USD crypto market-data adapter", () => {
  it("uses the dedicated crypto endpoint and subscribes only to BTC/USD bars", async () => {
    const socket = new FakeWebSocket();
    let url = "";
    const source = new AlpacaCryptoMarketSource(config, (candidate) => {
      url = candidate;
      return socket;
    }, () => now);
    const iterator = source.bars()[Symbol.asyncIterator]();
    const pending = iterator.next();
    assert.equal(url, ALPACA_CRYPTO_STREAM_URL);
    await authenticateAndSubscribe(socket);
    assert.deepEqual(socket.sent.map((entry) => JSON.parse(entry)), [
      { action: "auth", key: "key", secret: "secret" },
      { action: "subscribe", bars: ["BTC/USD"] },
    ]);
    assert.deepEqual(source.snapshot(), {
      state: "SUBSCRIBED",
      subscriptionAcknowledged: true,
      generation: 1,
      reconnectAttempt: 0,
      lastError: null,
    });
    source.close();
    await pending;
  });

  it("normalizes a completed BTC minute bar with the existing bar-start timestamp convention", async () => {
    const normalized = closedBarFromAlpacaCrypto(minuteBar(), now);
    assert.deepEqual(normalized, {
      t: Date.parse("2026-01-01T00:00:00Z"),
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 1.25,
    });
    assert.equal(closedBarFromAlpacaCrypto(minuteBar(), Date.parse("2026-01-01T00:00:30.000Z")), null);
  });

  it("delivers Blob and ArrayBuffer payload bars in arrival order", async () => {
    for (const { payload, expectedClose } of [
      { payload: new Blob([JSON.stringify([minuteBar({ c: 101.5 })])]), expectedClose: 101.5 },
      { payload: new TextEncoder().encode(JSON.stringify([minuteBar({ c: 102.5, h: 103 })])).buffer, expectedClose: 102.5 },
      { payload: Buffer.from(JSON.stringify([minuteBar({ c: 103.5, h: 104 })])), expectedClose: 103.5 },
    ]) {
      const socket = new FakeWebSocket();
      const source = new AlpacaCryptoMarketSource(config, () => socket, () => now);
      const iterator = source.bars()[Symbol.asyncIterator]();
      const next = iterator.next();
      await authenticateAndSubscribe(socket);
      await socket.message(payload);
      assert.equal((await next).value?.close, expectedClose);
      await iterator.return?.();
    }

    const socket = new FakeWebSocket();
    const source = new AlpacaCryptoMarketSource(config, () => socket, () => now);
    const iterator = source.bars()[Symbol.asyncIterator]();
    const first = iterator.next();
    await authenticateAndSubscribe(socket);
    await socket.message(JSON.stringify([
      minuteBar({ t: "2026-01-01T00:00:00Z", c: 101 }),
      minuteBar({ t: "2026-01-01T00:01:00Z", o: 101, h: 104, l: 100, c: 103 }),
    ]));
    assert.equal((await first).value?.close, 101);
    assert.equal((await iterator.next()).value?.close, 103);
    await iterator.return?.();
  });

  it("masks unrelated symbols and all non-bar or correction messages", async () => {
    const socket = new FakeWebSocket();
    const source = new AlpacaCryptoMarketSource(config, () => socket, () => now);
    const iterator = source.bars()[Symbol.asyncIterator]();
    const pending = iterator.next();
    await authenticateAndSubscribe(socket);
    await socket.message(JSON.stringify([
      { T: "q", S: BTC_USD_SPEC.symbol, bp: 99, ap: 101, t: "2026-01-01T00:00:00Z" },
      minuteBar({ T: "u", c: 88 }),
      minuteBar({ S: "ETH/USD", c: 77 }),
    ]));
    source.close();
    assert.equal((await pending).done, true);
  });

  it("rejects malformed BTC bars without placing them in the pipeline", async () => {
    const socket = new FakeWebSocket();
    const source = new AlpacaCryptoMarketSource(config, () => socket, () => now);
    const iterator = source.bars()[Symbol.asyncIterator]();
    const pending = iterator.next();
    await authenticateAndSubscribe(socket);
    await socket.message(JSON.stringify([minuteBar({ h: 90 })]));
    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof AlpacaTransportError);
      assert.equal(error.kind, "PROTOCOL_FAILURE");
      return true;
    });
    assert.equal(source.snapshot().state, "FAILED");
  });

  it("fails clearly on authentication and subscription errors", async () => {
    const authSocket = new FakeWebSocket();
    const authSource = new AlpacaCryptoMarketSource(config, () => authSocket, () => now);
    const authIterator = authSource.bars()[Symbol.asyncIterator]();
    const authPending = authIterator.next();
    await authSocket.message(JSON.stringify([{ T: "success", msg: "connected" }]));
    await authSocket.message(JSON.stringify([{ T: "error", code: 402, msg: "not authorized" }]));
    await assert.rejects(authPending, (error: unknown) => error instanceof AlpacaTransportError && error.kind === "AUTHENTICATION_FAILURE");

    const subscriptionSocket = new FakeWebSocket();
    const subscriptionSource = new AlpacaCryptoMarketSource(config, () => subscriptionSocket, () => now);
    const subscriptionIterator = subscriptionSource.bars()[Symbol.asyncIterator]();
    const subscriptionPending = subscriptionIterator.next();
    await subscriptionSocket.message(JSON.stringify([{ T: "success", msg: "connected" }]));
    await subscriptionSocket.message(JSON.stringify([{ T: "success", msg: "authenticated" }]));
    await subscriptionSocket.message(JSON.stringify([{ T: "subscription", bars: ["ETH/USD"] }]));
    await assert.rejects(subscriptionPending, (error: unknown) => error instanceof AlpacaTransportError && error.kind === "SUBSCRIPTION_FAILURE");
  });

  it("reconnects once after transport loss and invalidates stale socket callbacks", async () => {
    const sockets: FakeWebSocket[] = [];
    const waits: Array<() => void> = [];
    const source = new AlpacaCryptoMarketSource(
      config,
      () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      () => now,
      () => 1,
      () => new Promise<void>((resolve) => waits.push(resolve)),
    );
    const iterator = source.bars()[Symbol.asyncIterator]();
    const next = iterator.next();
    await authenticateAndSubscribe(sockets[0]!);
    await sockets[0]!.error();
    assert.equal(source.snapshot().state, "RECONNECTING");
    assert.equal(waits.length, 1);
    await sockets[0]!.message(JSON.stringify([minuteBar({ c: 55 })]));
    waits[0]!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sockets.length, 2, "one backoff creates exactly one replacement socket");
    await authenticateAndSubscribe(sockets[1]!);
    await sockets[1]!.message(JSON.stringify([minuteBar({ c: 105, h: 106 })]));
    assert.equal((await next).value?.close, 105, "stale generation must not emit a bar");
    source.close();
  });

  it("cleanly closes and prevents a pending reconnect from replacing the socket", async () => {
    const sockets: FakeWebSocket[] = [];
    const waits: Array<() => void> = [];
    const source = new AlpacaCryptoMarketSource(
      config,
      () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      () => now,
      () => 1,
      () => new Promise<void>((resolve) => waits.push(resolve)),
    );
    const iterator = source.bars()[Symbol.asyncIterator]();
    const pending = iterator.next();
    await authenticateAndSubscribe(sockets[0]!);
    await sockets[0]!.closeFromServer();
    assert.equal(waits.length, 1);
    source.close();
    await pending;
    waits[0]!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sockets.length, 1);
    assert.equal(source.snapshot().state, "CLOSED");
    assert.equal(sockets[0]!.closed, true);
    await pending;
  });
});
