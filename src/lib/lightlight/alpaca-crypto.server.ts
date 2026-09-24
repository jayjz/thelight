import type { MarketSource } from "./market.ts";
import type { ClosedBar } from "./types.ts";
import { BTC_USD_SPEC } from "./assets.ts";
import {
  AlpacaTransportError,
  type WebSocketFactory,
  type WebSocketLike,
  websocketPayloadToText,
} from "./alpaca-transport.ts";

/** Alpaca's dedicated US crypto market-data stream; this is not a trading URL. */
export const ALPACA_CRYPTO_STREAM_URL = "wss://stream.data.alpaca.markets/v1beta3/crypto/us";

export type AlpacaCryptoBarMessage = {
  T: "b";
  S: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: string;
};

export type CryptoMarketStreamState =
  | "DISCONNECTED"
  | "CONNECTING"
  | "AUTHENTICATING"
  | "SUBSCRIBING"
  | "SUBSCRIBED"
  | "RECONNECTING"
  | "CLOSED"
  | "FAILED";

export type AlpacaCryptoMarketSnapshot = {
  state: CryptoMarketStreamState;
  subscriptionAcknowledged: boolean;
  generation: number;
  reconnectAttempt: number;
  lastError: string | null;
};

export type AlpacaCryptoCredentials = { apiKeyId: string; apiSecretKey: string };

export function loadAlpacaCryptoCredentials(env: NodeJS.ProcessEnv = process.env): AlpacaCryptoCredentials {
  const apiKeyId = env.ALPACA_API_KEY_ID?.trim();
  const apiSecretKey = env.ALPACA_API_SECRET_KEY?.trim();
  if (!apiKeyId || !apiSecretKey) throw new Error("ALPACA_MARKET_DATA_CREDENTIALS_REQUIRED");
  return { apiKeyId, apiSecretKey };
}

export const CRYPTO_MAX_RECONNECT_ATTEMPTS = 8;
export const CRYPTO_HANDSHAKE_TIMEOUT_MS = 10_000;
export const cryptoReconnectDelayMs = (attempt: number): number => Math.min(30_000, 250 * 2 ** (attempt - 1));
const MAX_QUEUED_BARS = 120;

type Sleep = (milliseconds: number) => Promise<void>;

const defaultSleep: Sleep = (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function protocolError(message: string): AlpacaTransportError {
  return new AlpacaTransportError("PROTOCOL_FAILURE", message);
}

/**
 * Normalizes one completed Alpaca crypto minute bar. `t` is the provider's
 * RFC-3339 minute-start timestamp, which is the same bar-start convention as
 * the existing 1Min source and downstream aggregation contract.
 */
export function closedBarFromAlpacaCrypto(
  message: AlpacaCryptoBarMessage,
  now = Date.now(),
): ClosedBar | null {
  if (message.T !== "b" || message.S !== BTC_USD_SPEC.symbol) return null;
  const timestamp = Date.parse(message.t);
  const values = [message.o, message.h, message.l, message.c, message.v];
  if (
    !Number.isFinite(timestamp) || timestamp % 60_000 !== 0 ||
    values.some((value) => !Number.isFinite(value)) ||
    message.o <= 0 || message.h <= 0 || message.l <= 0 || message.c <= 0 || message.v < 0 ||
    !Number.isFinite(now)
  ) {
    throw protocolError("Malformed Alpaca BTC/USD minute bar.");
  }
  if (message.h < Math.max(message.o, message.c) || message.l > Math.min(message.o, message.c)) {
    throw protocolError("Invalid Alpaca BTC/USD OHLC bounds.");
  }
  // Alpaca's `bars` channel is emitted after the preceding minute. Retain the
  // existing local completion guard as a fail-closed clock sanity check.
  if (timestamp + 60_000 > now) return null;
  return { t: timestamp, open: message.o, high: message.h, low: message.l, close: message.c, volume: message.v };
}

/**
 * Read-only BTC/USD crypto adapter. It owns crypto protocol parsing and its
 * connection lifecycle; no broker, worker, database, or order API is imported
 * here. A fresh socket generation invalidates all callbacks from its predecessor.
 */
export class AlpacaCryptoMarketSource implements MarketSource {
  readonly id = "alpaca:crypto:BTC/USD:1Min";
  private readonly config: AlpacaCryptoCredentials;
  private readonly createSocket: WebSocketFactory;
  private readonly now: () => number;
  private readonly reconnectDelayMs: (attempt: number) => number;
  private readonly sleep: Sleep;
  private state: CryptoMarketStreamState = "DISCONNECTED";
  private subscriptionAcknowledged = false;
  private generation = 0;
  private reconnectAttempt = 0;
  private lastError: string | null = null;
  private socket: WebSocketLike | null = null;
  private running = false;
  private consumed = false;
  private cancelBackoff: (() => void) | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private reconnectScheduled = false;
  private terminalFailure: Error | null = null;
  private queue: ClosedBar[] = [];
  private wake: (() => void) | null = null;
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(
    config: AlpacaCryptoCredentials,
    createSocket: WebSocketFactory = (url) => new WebSocket(url),
    now: () => number = Date.now,
    reconnectDelayMs: (attempt: number) => number = cryptoReconnectDelayMs,
    sleep: Sleep = defaultSleep,
  ) {
    this.config = config;
    this.createSocket = createSocket;
    this.now = now;
    this.reconnectDelayMs = reconnectDelayMs;
    this.sleep = sleep;
  }

  snapshot(): AlpacaCryptoMarketSnapshot {
    return {
      state: this.state,
      subscriptionAcknowledged: this.subscriptionAcknowledged,
      generation: this.generation,
      reconnectAttempt: this.reconnectAttempt,
      lastError: this.lastError,
    };
  }

  close(): void {
    if (!this.running && this.state === "CLOSED") return;
    this.clearHandshake();
    this.cancelBackoff?.();
    this.cancelBackoff = null;
    this.subscriptionAcknowledged = false;
    this.queue = [];
    this.closed = true;
    this.running = false;
    this.generation += 1;
    this.reconnectScheduled = false;
    this.socket?.close();
    this.socket = null;
    this.state = this.terminalFailure ? "FAILED" : "CLOSED";
    this.signal();
  }

  async *bars(): AsyncIterable<ClosedBar> {
    if (this.consumed) throw new Error("ALPACA_CRYPTO_SOURCE_ALREADY_CONSUMED");
    this.consumed = true;
    this.running = true;
    this.closed = false;
    this.terminalFailure = null;
    this.lastError = null;
    this.subscriptionAcknowledged = false;
    this.reconnectAttempt = 0;
    this.queue = [];
    this.messageQueue = Promise.resolve();
    const generation = ++this.generation;
    try {
      this.connect(generation);
    } catch (error) {
      this.failTerminal(error instanceof Error ? error : protocolError("Unable to create Alpaca crypto socket."), generation);
    }
    try {
      for (;;) {
        if (this.terminalFailure) throw this.terminalFailure;
        if (this.closed) return;
        const bar = this.queue.shift();
        if (bar) yield bar;
        else await new Promise<void>((resolve) => { this.wake = resolve; });
      }
    } finally {
      this.close();
    }
  }

  private connect(generation: number): void {
    if (!this.running || this.closed || generation !== this.generation) return;
    this.state = "CONNECTING";
    this.messageQueue = Promise.resolve();
    let authSent = false;
    let subscriptionSent = false;
    let connectionActive = true;
    const socket = this.createSocket(ALPACA_CRYPTO_STREAM_URL);
    this.socket = socket;

    const stale = () => !connectionActive || !this.running || this.closed || generation !== this.generation;
    const transportFailure = (message: string) => {
      if (stale()) return;
      connectionActive = false;
      this.clearHandshake();
      this.lastError = message;
      this.scheduleReconnect(generation);
      socket.close();
    };
    this.handshakeTimer = setTimeout(() => transportFailure("Alpaca crypto handshake timed out."), CRYPTO_HANDSHAKE_TIMEOUT_MS);
    socket.addEventListener("message", (event) => {
      if (stale()) return;
      this.messageQueue = this.messageQueue.then(async () => {
        if (stale()) return;
        try {
          const decoded = JSON.parse(await websocketPayloadToText(event.data)) as unknown;
          if (!Array.isArray(decoded)) throw protocolError("Alpaca crypto stream message must be an array.");
          for (const raw of decoded) {
            if (stale()) return;
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw protocolError("Malformed Alpaca crypto stream message.");
            const message = raw as Record<string, unknown>;
            if (message.T === "success" && message.msg === "connected") {
              if (!authSent) {
                authSent = true;
                this.state = "AUTHENTICATING";
                socket.send(JSON.stringify({ action: "auth", key: this.config.apiKeyId, secret: this.config.apiSecretKey }));
              }
              continue;
            }
            if (message.T === "success" && message.msg === "authenticated") {
              if (!authSent) throw protocolError("Alpaca crypto authenticated before authentication was sent.");
              if (!subscriptionSent) {
                subscriptionSent = true;
                this.state = "SUBSCRIBING";
                socket.send(JSON.stringify({ action: "subscribe", bars: [BTC_USD_SPEC.symbol] }));
              }
              continue;
            }
            if (message.T === "subscription") {
              const bars = message.bars;
              if (!subscriptionSent || !Array.isArray(bars) || bars.length !== 1 || bars[0] !== BTC_USD_SPEC.symbol) {
                throw new AlpacaTransportError("SUBSCRIPTION_FAILURE", "Alpaca BTC/USD bars subscription was not acknowledged exactly.");
              }
              this.clearHandshake();
              this.subscriptionAcknowledged = true;
              this.state = "SUBSCRIBED";
              continue;
            }
            if (message.T === "error") {
              const code = Number(message.code);
              const detail = `Alpaca crypto stream error code ${Number.isFinite(code) ? code : "unknown"}.`;
              if (code === 401 || code === 402 || code === 403 || code === 404 || code === 409) {
                throw new AlpacaTransportError("AUTHENTICATION_FAILURE", detail);
              }
              if (subscriptionSent && !this.subscriptionAcknowledged) {
                throw new AlpacaTransportError("SUBSCRIPTION_FAILURE", detail);
              }
              throw protocolError(detail);
            }
            if (message.T === "b") {
              if (!this.subscriptionAcknowledged) throw protocolError("Alpaca BTC/USD bar arrived before subscription acknowledgement.");
              const bar = closedBarFromAlpacaCrypto(message as unknown as AlpacaCryptoBarMessage, this.now());
              if (bar) {
                if (this.queue.length >= MAX_QUEUED_BARS) throw protocolError("Alpaca crypto consumer queue overflow.");
                this.reconnectAttempt = 0;
                this.queue.push(bar);
              }
            }
            // Trades, quotes, daily bars, updated bars, and unrelated symbols
            // never enter the normalized completed-bar pipeline.
          }
        } catch (error) {
          this.failTerminal(error instanceof Error ? error : protocolError("Invalid Alpaca crypto stream message."), generation);
        }
        this.signal();
      });
      return this.messageQueue;
    });
    socket.addEventListener("error", () => transportFailure("Alpaca crypto market-data stream disconnected."));
    socket.addEventListener("close", () => transportFailure("Alpaca crypto market-data stream closed."));
  }

  private failTerminal(error: Error, generation: number): void {
    if (this.closed || generation !== this.generation || this.terminalFailure) return;
    this.clearHandshake();
    this.cancelBackoff?.();
    this.cancelBackoff = null;
    this.subscriptionAcknowledged = false;
    this.queue = [];
    this.terminalFailure = error;
    this.lastError = error.message;
    this.state = "FAILED";
    this.generation += 1;
    this.reconnectScheduled = false;
    this.socket?.close();
    this.socket = null;
    this.signal();
  }

  private clearHandshake(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private scheduleReconnect(failedGeneration: number): void {
    if (this.closed || !this.running || failedGeneration !== this.generation || this.reconnectScheduled) return;
    if (this.reconnectAttempt >= CRYPTO_MAX_RECONNECT_ATTEMPTS) {
      this.failTerminal(new AlpacaTransportError("DISCONNECTED_STREAM", "Alpaca crypto reconnect budget exhausted."), failedGeneration);
      return;
    }
    this.queue = [];
    this.reconnectScheduled = true;
    this.state = "RECONNECTING";
    this.subscriptionAcknowledged = false;
    const generation = ++this.generation;
    const attempt = ++this.reconnectAttempt;
    const delay = Math.max(0, this.reconnectDelayMs(attempt));
    void (async () => {
      if (this.sleep === defaultSleep) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          this.cancelBackoff = () => { clearTimeout(timer); resolve(); };
        });
        this.cancelBackoff = null;
      } else await this.sleep(delay);
      // Do not overlap physical sockets even when close() completes slowly.
      const closingDeadline = Date.now() + CRYPTO_HANDSHAKE_TIMEOUT_MS;
      while (this.socket?.readyState !== undefined && this.socket.readyState !== 3) {
        if (this.closed || generation !== this.generation) return;
        if (Date.now() >= closingDeadline) throw new Error("Alpaca crypto socket close timed out.");
        await defaultSleep(25);
      }
      if (this.closed || !this.running || generation !== this.generation) return;
      this.reconnectScheduled = false;
      this.socket = null;
      this.connect(generation);
    })().catch(() => this.failTerminal(new AlpacaTransportError("DISCONNECTED_STREAM", "Alpaca crypto reconnect failed."), generation));
    this.signal();
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}
