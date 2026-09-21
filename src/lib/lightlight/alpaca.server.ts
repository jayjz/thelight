import type { ClosedBar, ExecutionIntent, ExecutionStatus } from "./types.ts";
import type { MarketSource } from "./market.ts";
import { SPY_SPEC, alpacaEquityFeedFor, isBoundedEquitySymbol, type BoundedEquitySymbol } from "./assets.ts";

export const ALPACA_PAPER_BASE_URL = "https://paper-api.alpaca.markets";
export const ALPACA_DATA_BASE_URL = "https://data.alpaca.markets";
export const ALPACA_IEX_STREAM_URL = "wss://stream.data.alpaca.markets/v2/iex";
export const ALPACA_PAPER_TRADE_STREAM_URL = "wss://paper-api.alpaca.markets/stream";
const LOCAL_RELAY_ORIGINS = new Set(["ws://127.0.0.1:8765", "ws://localhost:8765"]);

export type AlpacaConfig = {
  apiKeyId: string;
  apiSecretKey: string;
  paperBaseUrl: typeof ALPACA_PAPER_BASE_URL;
  dataBaseUrl: typeof ALPACA_DATA_BASE_URL;
  dataFeed: "iex" | "sip" | "delayed_sip";
  symbol: BoundedEquitySymbol;
};

export class AlpacaConfigurationError extends Error {
  readonly kind: "MISSING_CREDENTIALS" | "UNSUPPORTED_DATA_FEED" | "INVALID_PAPER_DOMAIN";
  constructor(
    kind: "MISSING_CREDENTIALS" | "UNSUPPORTED_DATA_FEED" | "INVALID_PAPER_DOMAIN",
    message: string,
  ) {
    super(message);
    this.kind = kind;
  }
}

export class AlpacaTransportError extends Error {
  readonly kind:
    | "AUTHENTICATION_FAILURE"
    | "UNSUPPORTED_DATA_FEED"
    | "DISCONNECTED_STREAM"
    | "HTTP_FAILURE"
    | "SUBSCRIPTION_FAILURE"
    | "PROTOCOL_FAILURE"
    | "TIMEOUT";
  constructor(
    kind:
      | "AUTHENTICATION_FAILURE"
      | "UNSUPPORTED_DATA_FEED"
      | "DISCONNECTED_STREAM"
      | "HTTP_FAILURE"
      | "SUBSCRIPTION_FAILURE"
      | "PROTOCOL_FAILURE"
      | "TIMEOUT",
    message: string,
  ) {
    super(message);
    this.kind = kind;
  }
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new AlpacaConfigurationError("MISSING_CREDENTIALS", `Missing ${key}.`);
  return value;
}

export function loadAlpacaConfig(env: NodeJS.ProcessEnv = process.env): AlpacaConfig {
  const configuredPaperUrl = env.ALPACA_PAPER_BASE_URL?.trim() || ALPACA_PAPER_BASE_URL;
  if (configuredPaperUrl !== ALPACA_PAPER_BASE_URL) {
    throw new AlpacaConfigurationError(
      "INVALID_PAPER_DOMAIN",
      "ALPACA_PAPER_BASE_URL must be the fixed Alpaca paper domain.",
    );
  }
  const configuredDataUrl = env.ALPACA_DATA_BASE_URL?.trim() || ALPACA_DATA_BASE_URL;
  if (configuredDataUrl !== ALPACA_DATA_BASE_URL) {
    throw new AlpacaConfigurationError("INVALID_PAPER_DOMAIN", "ALPACA_DATA_BASE_URL is not supported.");
  }
  const dataFeed = (env.ALPACA_DATA_FEED?.trim() || alpacaEquityFeedFor(SPY_SPEC)).toLowerCase();
  if (dataFeed !== "iex" && dataFeed !== "sip" && dataFeed !== "delayed_sip") {
    throw new AlpacaConfigurationError("UNSUPPORTED_DATA_FEED", `Unsupported Alpaca feed: ${dataFeed}.`);
  }
  const symbol = (env.ALPACA_SYMBOL?.trim().toUpperCase() || SPY_SPEC.symbol);
  if (!isBoundedEquitySymbol(symbol)) throw new AlpacaConfigurationError("INVALID_PAPER_DOMAIN", "ALPACA_SYMBOL must be in the configured bounded equity universe.");
  return {
    apiKeyId: requiredEnv(env, "ALPACA_API_KEY_ID"),
    apiSecretKey: requiredEnv(env, "ALPACA_API_SECRET_KEY"),
    paperBaseUrl: ALPACA_PAPER_BASE_URL,
    dataBaseUrl: ALPACA_DATA_BASE_URL,
    dataFeed,
    symbol,
  };
}

/**
 * Opt-in, fixed-origin local market-data transport.  It has no bearing on
 * PAPER account, order, or trade-update connections, which remain hard-bound.
 */
export function loadLocalMarketDataUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.ALPACA_LOCAL_FEED_URL?.trim();
  if (!value) return null;
  if (!LOCAL_RELAY_ORIGINS.has(value)) {
    throw new AlpacaConfigurationError(
      "INVALID_PAPER_DOMAIN",
      "ALPACA_LOCAL_FEED_URL must be the fixed localhost market-data relay.",
    );
  }
  return value;
}

export function alpacaHeaders(config: AlpacaConfig): HeadersInit {
  return {
    "APCA-API-KEY-ID": config.apiKeyId,
    "APCA-API-SECRET-KEY": config.apiSecretKey,
  };
}

export type AlpacaStockBarMessage = {
  T: "b" | "u";
  S: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: string;
};

/** Read-only, bounded historical market-data boundary. It has no broker API. */
export interface HistoricalStockBars {
  bars(request: { symbol: BoundedEquitySymbol; start: number; end: number }): Promise<ClosedBar[]>;
}

function strictHistoricalBar(value: unknown, start: number, end: number): ClosedBar {
  const bar = value as Record<string, unknown>;
  const timestamp = typeof bar.t === "string" ? Date.parse(bar.t) : Number.NaN;
  const open = Number(bar.o); const high = Number(bar.h); const low = Number(bar.l); const close = Number(bar.c); const volume = Number(bar.v);
  if (!Number.isFinite(timestamp) || timestamp % 60_000 !== 0 || timestamp < start || timestamp >= end ||
    ![open, high, low, close, volume].every(Number.isFinite) || volume < 0 || low > Math.min(open, close) || high < Math.max(open, close) || high < low) {
    throw new AlpacaTransportError("PROTOCOL_FAILURE", "Alpaca historical bars failed strict validation.");
  }
  return { t: timestamp, open, high, low, close, volume };
}

/**
 * Deliberately separate from AlpacaPaperBroker: this client can only retrieve
 * bounded configured IEX 1-minute bars for a caller-provided bounded interval.
 */
export class AlpacaHistoricalStockBars implements HistoricalStockBars {
  private readonly config: AlpacaConfig;
  private readonly request: typeof fetch;

  constructor(config: AlpacaConfig, request: typeof fetch = fetch) {
    this.config = config;
    this.request = request;
    if (config.dataBaseUrl !== ALPACA_DATA_BASE_URL || !isBoundedEquitySymbol(config.symbol)) throw new Error("ALPACA_HISTORICAL_SCOPE_FORBIDDEN");
  }

  async bars({ symbol, start, end }: { symbol: BoundedEquitySymbol; start: number; end: number }): Promise<ClosedBar[]> {
    if (!isBoundedEquitySymbol(symbol) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end || start % 60_000 !== 0 || end % 60_000 !== 0) {
      throw new Error("INVALID_HISTORICAL_BAR_RANGE");
    }
    const expected = (end - start) / 60_000;
    if (expected > 390) throw new Error("HISTORICAL_BAR_RANGE_UNBOUNDED");
    const url = new URL("/v2/stocks/bars", ALPACA_DATA_BASE_URL);
    url.searchParams.set("symbols", symbol);
    url.searchParams.set("timeframe", "1Min");
    url.searchParams.set("feed", "iex");
    url.searchParams.set("start", new Date(start).toISOString());
    url.searchParams.set("end", new Date(end).toISOString());
    url.searchParams.set("limit", String(expected));
    url.searchParams.set("sort", "asc");
    let response: Response;
    try {
      response = await this.request(url, { headers: alpacaHeaders(this.config), signal: AbortSignal.timeout(25_000) });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new AlpacaTransportError("TIMEOUT", "Alpaca historical bars request timed out.");
      }
      throw new AlpacaTransportError("HTTP_FAILURE", "Alpaca historical bars request failed.");
    }
    if (response.status === 401 || response.status === 403) throw new AlpacaTransportError("AUTHENTICATION_FAILURE", "Alpaca historical market-data authentication failed.");
    if (!response.ok) throw new AlpacaTransportError("HTTP_FAILURE", `Alpaca historical bars request failed: ${response.status}.`);
    let body: { bars?: Record<string, unknown[]> };
    try {
      body = await response.json() as { bars?: Record<string, unknown[]> };
    } catch {
      throw new AlpacaTransportError("PROTOCOL_FAILURE", "Alpaca historical bars response was malformed.");
    }
    const values = body && typeof body === "object" && !Array.isArray(body) ? body.bars?.[symbol] : undefined;
    if (!Array.isArray(values)) throw new AlpacaTransportError("PROTOCOL_FAILURE", "Alpaca historical bars response was malformed.");
    const bars = values.map((value) => strictHistoricalBar(value, start, end));
    const timestamps = new Set(bars.map((bar) => bar.t));
    if (timestamps.size !== bars.length) throw new AlpacaTransportError("PROTOCOL_FAILURE", "Alpaca historical bars response contains duplicate timestamps.");
    for (let timestamp = start; timestamp < end; timestamp += 60_000) {
      if (!timestamps.has(timestamp)) {
        throw new AlpacaTransportError("PROTOCOL_FAILURE", "Alpaca historical bars response was incomplete.");
      }
    }
    return bars.sort((left, right) => left.t - right.t);
  }
}

/** A 1Min bar may enter only after its own minute has elapsed. */
export function closedBarFromAlpaca(
  message: AlpacaStockBarMessage,
  now = Date.now(),
): ClosedBar | null {
  if (message.T !== "b" || !Number.isFinite(Date.parse(message.t))) return null;
  const timestamp = Date.parse(message.t);
  if (timestamp + 60_000 > now) return null;
  return {
    t: timestamp,
    open: message.o,
    high: message.h,
    low: message.l,
    close: message.c,
    volume: message.v,
  };
}

export type WebSocketLike = {
  send(payload: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown }) => void): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

/** Normalizes Node and browser WebSocket message payloads before JSON parsing. */
export async function websocketPayloadToText(payload: unknown): Promise<string> {
  if (typeof payload === "string") return payload;
  if (payload instanceof Blob) return payload.text();
  if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) return new TextDecoder().decode(payload);
  throw new TypeError("Unsupported WebSocket payload.");
}

/** Server-only, IEX-by-default real-time 1Min source. It has no synthetic fallback. */
export class AlpacaMarketSource implements MarketSource {
  readonly id: string;
  private readonly config: AlpacaConfig;
  private readonly createSocket: WebSocketFactory;
  private readonly now: () => number;

  constructor(
    config: AlpacaConfig,
    createSocket: WebSocketFactory = (url) => new WebSocket(url),
    now: () => number = Date.now,
    localFeedUrl: string | null = loadLocalMarketDataUrl(),
  ) {
    if (localFeedUrl && !LOCAL_RELAY_ORIGINS.has(localFeedUrl)) {
      throw new AlpacaConfigurationError(
        "INVALID_PAPER_DOMAIN",
        "Local market-data transport must be the fixed localhost relay.",
      );
    }
    this.config = config;
    this.createSocket = createSocket;
    this.now = now;
    this.id = localFeedUrl
      ? `alpaca-local-relay:${config.dataFeed}:${config.symbol}:1Min`
      : `alpaca:${config.dataFeed}:${config.symbol}:1Min`;
    this.localFeedUrl = localFeedUrl;
  }

  private readonly localFeedUrl: string | null;

  async *bars(): AsyncIterable<ClosedBar> {
    const feed = this.config.dataFeed;
    const streamUrl = this.localFeedUrl ?? `wss://stream.data.alpaca.markets/v2/${feed}`;
    const socket = this.createSocket(streamUrl);
    const queue: ClosedBar[] = [];
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    let messageQueue = Promise.resolve();
    const signal = () => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };
    socket.addEventListener("message", (event) => {
      messageQueue = messageQueue.then(async () => {
        try {
          const messages = JSON.parse(await websocketPayloadToText(event.data)) as Array<Record<string, unknown>>;
          for (const message of messages) {
            if (!this.localFeedUrl && message.T === "success" && message.msg === "connected") {
              socket.send(JSON.stringify({ action: "auth", key: this.config.apiKeyId, secret: this.config.apiSecretKey }));
            } else if (!this.localFeedUrl && message.T === "success" && message.msg === "authenticated") {
              socket.send(JSON.stringify({ action: "subscribe", bars: [this.config.symbol] }));
            } else if (this.localFeedUrl && message.T === "relay") {
              failure = new AlpacaTransportError("DISCONNECTED_STREAM", "Local market-data relay is unavailable.");
            } else if (message.T === "error") {
              failure = new AlpacaTransportError(
                Number(message.code) === 402 ? "AUTHENTICATION_FAILURE" : "UNSUPPORTED_DATA_FEED",
                String(message.msg ?? "Alpaca data-stream error."),
              );
            } else {
              // A relay may carry the bounded union; this consumer accepts only
              // its runtime asset, so one symbol can never enter another's state.
              if (String(message.S ?? "").toUpperCase() !== this.config.symbol) continue;
              const bar = closedBarFromAlpaca(message as unknown as AlpacaStockBarMessage, this.now());
              if (bar) queue.push(bar);
            }
          }
        } catch {
          failure = new AlpacaTransportError("DISCONNECTED_STREAM", "Invalid Alpaca stream message.");
        }
        signal();
      });
      return messageQueue;
    });
    socket.addEventListener("error", () => {
      failure = new AlpacaTransportError("DISCONNECTED_STREAM", "Alpaca data stream disconnected.");
      signal();
    });
    socket.addEventListener("close", () => {
      failure ??= new AlpacaTransportError("DISCONNECTED_STREAM", "Alpaca data stream closed.");
      signal();
    });
    socket.addEventListener("open", () => {
      if (this.localFeedUrl) {
        socket.send(JSON.stringify({ action: "subscribe", bars: [this.config.symbol] }));
      }
    });
    try {
      for (;;) {
        if (failure) throw failure;
        const bar = queue.shift();
        if (bar) yield bar;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      socket.close();
    }
  }
}

export type BrokerOrderState = {
  decisionId: string;
  intentId: string;
  clientOrderId: string;
  brokerOrderId: string | null;
  status: ExecutionStatus;
  updatedAt: string | null;
  rawStatus: string | null;
  /** Whether the latest broker lookup found an order for this client ID. */
  lookup: "FOUND" | "ABSENT" | "UNRESOLVED";
};

/**
 * A position read from Alpaca during reconciliation. A strategy target or a
 * replay-ledger position is deliberately not assignable to this boundary.
 */
export type BrokerPositionSnapshot = {
  symbol: string;
  quantity: number;
  reconciledAt: string;
  provenance: "ALPACA_RECONCILED";
};

/** PAPER account equity is the authoritative input to the worker risk gate. */
export type BrokerAccountSnapshot = {
  equity: number;
  reconciledAt: string;
  provenance: "ALPACA_PAPER_ACCOUNT";
};

/** Deliberate, auditable escape hatch for an UNKNOWN submission. */
export type SubmissionRecovery = "AUTHORIZE_RESUBMISSION_AFTER_ABSENT_LOOKUP";

function orderStatus(order: Record<string, unknown>): ExecutionStatus {
  switch (String(order.status)) {
    case "accepted": case "new": case "pending_new": case "accepted_for_bidding": return "ACCEPTED";
    case "partially_filled": return "PARTIALLY_FILLED";
    case "filled": return "FILLED";
    case "rejected": return "REJECTED";
    case "canceled": case "expired": case "done_for_day": return "CANCELLED";
    default: return "UNKNOWN";
  }
}

export interface ExecutionPort {
  submit(
    intent: ExecutionIntent,
    brokerPosition: BrokerPositionSnapshot,
    recovery?: SubmissionRecovery,
  ): Promise<BrokerOrderState>;
  reconcile(intent: ExecutionIntent): Promise<BrokerOrderState>;
}

/** Broker reads used by the worker before it may dispatch an intent. */
export type OpenBrokerOrder = {
  clientOrderId: string;
  brokerOrderId: string | null;
  status: ExecutionStatus;
};

/**
 * Fixed-domain paper broker authority. The worker deliberately uses this
 * separate read boundary rather than interpreting a local/replay position.
 */
export class AlpacaPaperBroker {
  private readonly execution: AlpacaPaperExecution;
  private readonly config: AlpacaConfig;
  private readonly request: typeof fetch;

  constructor(
    config: AlpacaConfig,
    request: typeof fetch = fetch,
  ) {
    this.config = config;
    this.request = request;
    if (config.paperBaseUrl !== ALPACA_PAPER_BASE_URL) throw new Error("LIVE_TRADING_FORBIDDEN");
    this.execution = new AlpacaPaperExecution(config, request);
  }

  async account(): Promise<BrokerAccountSnapshot> {
    const response = await this.request(`${ALPACA_PAPER_BASE_URL}/v2/account`, { headers: alpacaHeaders(this.config) });
    if (response.status === 401 || response.status === 403) throw new AlpacaTransportError("AUTHENTICATION_FAILURE", "Alpaca paper authentication failed.");
    if (!response.ok) throw new AlpacaTransportError("HTTP_FAILURE", `Alpaca paper account reconciliation failed: ${response.status}.`);
    const body = await response.json() as Record<string, unknown>;
    const equity = Number(body.equity);
    if (!Number.isFinite(equity) || equity <= 0) throw new AlpacaTransportError("HTTP_FAILURE", "Alpaca returned invalid paper account equity.");
    return { equity, reconciledAt: new Date().toISOString(), provenance: "ALPACA_PAPER_ACCOUNT" };
  }

  async position(): Promise<BrokerPositionSnapshot> {
    const response = await this.request(`${ALPACA_PAPER_BASE_URL}/v2/positions/${encodeURIComponent(this.config.symbol)}`, { headers: alpacaHeaders(this.config) });
    if (response.status === 404) {
      return { symbol: this.config.symbol, quantity: 0, reconciledAt: new Date().toISOString(), provenance: "ALPACA_RECONCILED" };
    }
    if (response.status === 401 || response.status === 403) throw new AlpacaTransportError("AUTHENTICATION_FAILURE", "Alpaca paper authentication failed.");
    if (!response.ok) throw new AlpacaTransportError("HTTP_FAILURE", `Alpaca paper position reconciliation failed: ${response.status}.`);
    const body = await response.json() as Record<string, unknown>;
    const quantity = Number(body.qty);
    if (!Number.isFinite(quantity) || String(body.symbol ?? "").toUpperCase() !== this.config.symbol) throw new AlpacaTransportError("HTTP_FAILURE", "Alpaca returned an invalid paper position.");
    return { symbol: this.config.symbol, quantity, reconciledAt: new Date().toISOString(), provenance: "ALPACA_RECONCILED" };
  }

  async openOrders(): Promise<OpenBrokerOrder[]> {
    const response = await this.request(`${ALPACA_PAPER_BASE_URL}/v2/orders?status=open&symbols=${encodeURIComponent(this.config.symbol)}&direction=asc`, { headers: alpacaHeaders(this.config) });
    if (response.status === 401 || response.status === 403) throw new AlpacaTransportError("AUTHENTICATION_FAILURE", "Alpaca paper authentication failed.");
    if (!response.ok) throw new AlpacaTransportError("HTTP_FAILURE", `Alpaca paper open-order reconciliation failed: ${response.status}.`);
    const orders = await response.json() as Array<Record<string, unknown>>;
    if (!Array.isArray(orders)) throw new AlpacaTransportError("HTTP_FAILURE", "Alpaca returned invalid open orders.");
    return orders.map((order) => ({
      clientOrderId: String(order.client_order_id ?? ""),
      brokerOrderId: String(order.id ?? "") || null,
      status: orderStatus(order),
    }));
  }

  reconcile(intent: ExecutionIntent): Promise<BrokerOrderState> { return this.execution.reconcile(intent); }
  submit(intent: ExecutionIntent, position: BrokerPositionSnapshot, recovery?: SubmissionRecovery): Promise<BrokerOrderState> {
    return this.execution.submit(intent, position, recovery);
  }
}

/** Maps a broker-originated trade update without changing decision evidence. */
export function brokerStateFromTradeUpdate(
  update: Record<string, unknown>,
  intent: ExecutionIntent,
): BrokerOrderState | null {
  if (update.stream !== "trade_updates") return null;
  const data = update.data as Record<string, unknown> | undefined;
  const order = data?.order as Record<string, unknown> | undefined;
  if (!order) return null;
  const clientOrderId = String(order.client_order_id ?? "");
  if (clientOrderId !== (intent.clientOrderId ?? intent.intentId)) return null;
  return {
    decisionId: intent.decisionId,
    intentId: intent.intentId,
    clientOrderId,
    brokerOrderId: String(order.id ?? "") || null,
    status: orderStatus(order),
    updatedAt: String(order.updated_at ?? "") || null,
    rawStatus: String(order.status ?? data?.event ?? "") || null,
    lookup: "FOUND",
  };
}

/** Server-only listener for broker-authoritative paper order updates. */
export class AlpacaPaperTradeUpdates {
  private readonly config: AlpacaConfig;
  private readonly createSocket: WebSocketFactory;

  constructor(
    config: AlpacaConfig,
    createSocket: WebSocketFactory = (url) => new WebSocket(url),
  ) {
    this.config = config;
    this.createSocket = createSocket;
  }

  /**
   * `onReady` is intentionally delayed until Alpaca's `listening` acknowledgement
   * includes `trade_updates`; an open socket or an authorized session alone is
   * not a subscribed trade-update stream.
   */
  connect(
    onUpdate: (update: Record<string, unknown>) => void,
    onError: (error: Error) => void,
    onReady: () => void,
  ): () => void {
    const socket = this.createSocket(ALPACA_PAPER_TRADE_STREAM_URL);
    let authSent = false;
    let authorized = false;
    let listenSent = false;
    let ready = false;
    let failed = false;
    let messageQueue = Promise.resolve();
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      onError(error);
    };
    socket.addEventListener("message", (event) => {
      messageQueue = messageQueue.then(async () => {
        try {
          const update = JSON.parse(await websocketPayloadToText(event.data)) as Record<string, unknown>;
          if (update.stream === "authorization") {
            const data = update.data as Record<string, unknown> | undefined;
            if (data?.status === "unauthorized") {
              fail(new AlpacaTransportError("AUTHENTICATION_FAILURE", "Alpaca paper trade stream authentication failed."));
            } else if (data?.status === "authorized") {
              authorized = true;
              if (!listenSent) {
                listenSent = true;
                socket.send(JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } }));
              }
            }
          } else if (update.stream === "listening") {
            const streams = (update.data as Record<string, unknown> | undefined)?.streams;
            if (!authorized || !listenSent || !Array.isArray(streams) || !streams.includes("trade_updates")) {
              fail(new AlpacaTransportError("DISCONNECTED_STREAM", "Alpaca paper trade_updates subscription was not acknowledged."));
            } else if (!ready) {
              ready = true;
              onReady();
            }
          } else if (update.stream === "trade_updates") {
            if (!ready) {
              fail(new AlpacaTransportError("DISCONNECTED_STREAM", "Alpaca paper trade update arrived before subscription readiness."));
            } else {
              onUpdate(update);
            }
          }
        } catch {
          fail(new AlpacaTransportError("DISCONNECTED_STREAM", "Invalid Alpaca paper trade update."));
        }
      });
      return messageQueue;
    });
    socket.addEventListener("error", () => fail(new AlpacaTransportError("DISCONNECTED_STREAM", "Alpaca paper trade stream disconnected.")));
    socket.addEventListener("close", () => fail(new AlpacaTransportError("DISCONNECTED_STREAM", "Alpaca paper trade stream closed.")));
    socket.addEventListener("open", () => {
      if (authSent) return;
      authSent = true;
      socket.send(JSON.stringify({
        action: "auth",
        key: this.config.apiKeyId,
        secret: this.config.apiSecretKey,
      }));
    });
    return () => socket.close();
  }
}

/**
 * Fixed-domain Alpaca PAPER port. Unknown submission is intentionally not
 * retried: callers must reconcile the deterministic client order ID first.
 */
export class AlpacaPaperExecution implements ExecutionPort {
  private readonly config: AlpacaConfig;
  private readonly request: typeof fetch;
  /**
   * Process-local guard for callers that have not yet persisted the returned
   * UNKNOWN state. Durable callers must also persist intent.status.
   */
  private readonly uncertainClientOrderIds = new Set<string>();
  constructor(
    config: AlpacaConfig,
    request: typeof fetch = fetch,
  ) {
    this.config = config;
    this.request = request;
    if (config.paperBaseUrl !== ALPACA_PAPER_BASE_URL) throw new Error("LIVE_TRADING_FORBIDDEN");
  }

  async reconcile(intent: ExecutionIntent): Promise<BrokerOrderState> {
    const clientOrderId = intent.clientOrderId ?? intent.intentId;
    const response = await this.request(
      `${ALPACA_PAPER_BASE_URL}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
      { headers: alpacaHeaders(this.config), signal: AbortSignal.timeout(25_000) },
    );
    if (response.status === 404) {
      const uncertain = intent.status === "UNKNOWN" || this.uncertainClientOrderIds.has(clientOrderId);
      // Absence is lookup evidence, not permission to rewrite a persisted
      // lifecycle state back to PENDING. In particular UNKNOWN stays blocked.
      const status = uncertain ? "UNKNOWN" : intent.status;
      return this.state(intent, clientOrderId, status, null, null, null, "ABSENT");
    }
    if (response.status === 401 || response.status === 403) {
      throw new AlpacaTransportError("AUTHENTICATION_FAILURE", "Alpaca paper authentication failed.");
    }
    if (!response.ok) throw new AlpacaTransportError("HTTP_FAILURE", `Alpaca order lookup failed: ${response.status}.`);
    const state = this.fromOrder(intent, clientOrderId, await response.json() as Record<string, unknown>);
    this.uncertainClientOrderIds.delete(clientOrderId);
    return state;
  }

  async submit(
    intent: ExecutionIntent,
    brokerPosition: BrokerPositionSnapshot,
    recovery?: SubmissionRecovery,
  ): Promise<BrokerOrderState> {
    const clientOrderId = intent.clientOrderId ?? intent.intentId;
    const existing = await this.reconcile(intent);
    if (existing.lookup === "FOUND") return existing;
    const uncertain = existing.status === "UNKNOWN" || this.uncertainClientOrderIds.has(clientOrderId);
    if (uncertain && recovery !== "AUTHORIZE_RESUBMISSION_AFTER_ABSENT_LOOKUP") return existing;
    if (existing.status !== "PENDING" && !uncertain) return existing;
    if (brokerPosition.provenance !== "ALPACA_RECONCILED" || brokerPosition.symbol !== this.config.symbol) {
      throw new Error("BROKER_POSITION_RECONCILIATION_REQUIRED");
    }
    if (!Number.isFinite(brokerPosition.quantity)) throw new Error("INVALID_BROKER_POSITION");
    const delta = intent.desiredPosition - brokerPosition.quantity;
    if (delta === 0) return this.state(intent, clientOrderId, "CANCELLED", null, null, null, "ABSENT");
    try {
      const response = await this.request(`${ALPACA_PAPER_BASE_URL}/v2/orders`, {
        method: "POST",
        headers: { ...alpacaHeaders(this.config), "content-type": "application/json" },
        signal: AbortSignal.timeout(25_000),
        body: JSON.stringify({
          symbol: this.config.symbol,
          qty: String(Math.abs(delta)),
          side: delta > 0 ? "buy" : "sell",
          type: "market",
          time_in_force: "day",
          client_order_id: clientOrderId,
        }),
      });
      if (response.status === 401 || response.status === 403) {
        throw new AlpacaTransportError("AUTHENTICATION_FAILURE", "Alpaca paper authentication failed.");
      }
      if (!response.ok) return this.state(intent, clientOrderId, "REJECTED", null, null, null, "UNRESOLVED");
      const state = this.fromOrder(intent, clientOrderId, await response.json() as Record<string, unknown>);
      this.uncertainClientOrderIds.delete(clientOrderId);
      return state;
    } catch (error) {
      if (error instanceof AlpacaTransportError) throw error;
      this.uncertainClientOrderIds.add(clientOrderId);
      return this.state(intent, clientOrderId, "UNKNOWN", null, null, null, "UNRESOLVED");
    }
  }

  private fromOrder(intent: ExecutionIntent, clientOrderId: string, order: Record<string, unknown>): BrokerOrderState {
    return this.state(intent, clientOrderId, orderStatus(order), String(order.id ?? "") || null, String(order.updated_at ?? "") || null, String(order.status ?? "") || null, "FOUND");
  }

  private state(intent: ExecutionIntent, clientOrderId: string, status: ExecutionStatus, brokerOrderId: string | null, updatedAt: string | null, rawStatus: string | null, lookup: BrokerOrderState["lookup"]): BrokerOrderState {
    return { decisionId: intent.decisionId, intentId: intent.intentId, clientOrderId, brokerOrderId, status, updatedAt, rawStatus, lookup };
  }
}
