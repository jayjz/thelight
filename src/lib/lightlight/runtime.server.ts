import {
  ALPACA_PAPER_BASE_URL,
  AlpacaConfigurationError,
  AlpacaTransportError,
  alpacaHeaders,
  loadAlpacaConfig,
} from "./alpaca.server.ts";
import type { TradingMode } from "./types.ts";

export type LightlightRuntimeStatus = {
  mode: TradingMode;
  connectionState: "REPLAY" | "CONNECTED" | "MISSING_CREDENTIALS" | "AUTHENTICATION_FAILURE" | "UNSUPPORTED_DATA_FEED" | "DISCONNECTED_STREAM" | "ERROR";
  symbol: string;
  feed: string;
  latestClosedBarTimestamp: number | null;
  latestDecisionId: string | null;
  latestBrokerOrderState: string | null;
  currentPaperPosition: number | null;
  jevAdapter: string;
  jevModel: string;
  error: string | null;
};

export async function readLightlightRuntimeStatus(): Promise<LightlightRuntimeStatus> {
  const selected = process.env.LIGHTLIGHT_MODE?.trim();
  const mode: TradingMode = selected === "ALPACA_PAPER" ? "ALPACA_PAPER" : "PAPER_REPLAY";
  if (mode === "PAPER_REPLAY") {
    return {
      mode, connectionState: "REPLAY", symbol: "SYN.LL1", feed: "synthetic-seeded",
      latestClosedBarTimestamp: null, latestDecisionId: null, latestBrokerOrderState: null,
      currentPaperPosition: 0, jevAdapter: "mock-jev", jevModel: "mock-jev-not-typesafe", error: null,
    };
  }
  try {
    const config = loadAlpacaConfig();
    const response = await fetch(`${ALPACA_PAPER_BASE_URL}/v2/account`, {
      headers: alpacaHeaders(config), signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 401 || response.status === 403) {
      return unavailable(mode, config.symbol, config.dataFeed, "AUTHENTICATION_FAILURE", "Alpaca PAPER authentication failed.");
    }
    if (!response.ok) {
      return unavailable(mode, config.symbol, config.dataFeed, "ERROR", `Alpaca PAPER account check failed: ${response.status}.`);
    }
    return {
      mode, connectionState: "DISCONNECTED_STREAM", symbol: config.symbol, feed: config.dataFeed,
      latestClosedBarTimestamp: null, latestDecisionId: null, latestBrokerOrderState: null,
      currentPaperPosition: null, jevAdapter: "mock-jev", jevModel: "mock-jev-not-typesafe",
      error: "PAPER account authenticated; market-data worker is not connected in this request.",
    };
  } catch (error) {
    if (error instanceof AlpacaConfigurationError) {
      return unavailable(
        mode,
        "SPY",
        "iex",
        error.kind === "INVALID_PAPER_DOMAIN" ? "ERROR" : error.kind,
        error.message,
      );
    }
    if (error instanceof AlpacaTransportError) {
      return unavailable(
        mode,
        "SPY",
        "iex",
        error.kind === "HTTP_FAILURE" ? "ERROR" : error.kind,
        error.message,
      );
    }
    return unavailable(mode, "SPY", "iex", "DISCONNECTED_STREAM", error instanceof Error ? error.message : "Alpaca connection failed.");
  }
}

function unavailable(
  mode: TradingMode,
  symbol: string,
  feed: string,
  connectionState: LightlightRuntimeStatus["connectionState"],
  error: string,
): LightlightRuntimeStatus {
  return {
    mode, connectionState, symbol, feed, latestClosedBarTimestamp: null,
    latestDecisionId: null, latestBrokerOrderState: null, currentPaperPosition: null,
    jevAdapter: "mock-jev", jevModel: "mock-jev-not-typesafe", error,
  };
}
