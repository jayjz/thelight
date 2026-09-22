import { AlpacaConfigurationError } from "./alpaca.server.ts";
import { readAlpacaPaperWorkerSnapshot, type AlpacaWorkerSnapshot } from "./alpaca-worker.server.ts";
import { SPY_SPEC, alpacaEquityFeedFor } from "./assets.ts";
import { SPY_RUNTIME_IDENTITY, type WorkerRuntimeCapability } from "./runtime-identity.ts";
import type { TradingMode } from "./types.ts";

export type LightlightRuntimeStatus = {
  mode: TradingMode;
  connectionState: "REPLAY" | "CONNECTED" | "MISSING_CREDENTIALS" | "AUTHENTICATION_FAILURE" | "UNSUPPORTED_DATA_FEED" | "DISCONNECTED_STREAM" | "ERROR";
  workerState: "STOPPED" | "STARTING" | "RECONCILING" | "READY" | "HALTED" | null;
  symbol: string;
  workerKey: string | null;
  runtimeCapability: WorkerRuntimeCapability["kind"] | null;
  feed: string;
  decisionTimeframe: string;
  latestRawBarTimestamp: number | null;
  latestClosedBarTimestamp: number | null;
  latestDecisionId: string | null;
  latestBrokerOrderState: string | null;
  currentPaperPosition: number | null;
  openOrderSummary: { count: number; clientOrderIds: string[] };
  riskState: string | null;
  lastTradeUpdateTimestamp: string | null;
  lastReconciliationTimestamp: string | null;
  streamState: string;
  haltReason: string | null;
  jevAdapter: string;
  jevModel: string;
  error: string | null;
};

export async function readLightlightRuntimeStatus(): Promise<LightlightRuntimeStatus> {
  const selected = process.env.LIGHTLIGHT_MODE?.trim();
  const mode: TradingMode = selected === "ALPACA_PAPER" ? "ALPACA_PAPER" : "PAPER_REPLAY";
  if (mode === "PAPER_REPLAY") {
    return {
      mode, connectionState: "REPLAY", workerState: null, symbol: "SYN.LL1", workerKey: null, runtimeCapability: null, feed: "synthetic-seeded", decisionTimeframe: "1D", latestRawBarTimestamp: null,
      latestClosedBarTimestamp: null, latestDecisionId: null, latestBrokerOrderState: null,
      currentPaperPosition: 0, openOrderSummary: { count: 0, clientOrderIds: [] }, riskState: null, lastTradeUpdateTimestamp: null,
      lastReconciliationTimestamp: null, streamState: "REPLAY", haltReason: null, jevAdapter: "mock-jev", jevModel: "mock-jev-not-typesafe", error: null,
    };
  }
  try {
    const snapshot = await readAlpacaPaperWorkerSnapshot();
    return snapshot
      ? fromWorker(snapshot)
      : unavailable(mode, SPY_SPEC.symbol, alpacaEquityFeedFor(SPY_SPEC), "DISCONNECTED_STREAM", "PAPER worker has not been explicitly started by the server operator.");
  } catch (error) {
    if (error instanceof AlpacaConfigurationError) {
      return unavailable(
        mode,
        SPY_SPEC.symbol,
        alpacaEquityFeedFor(SPY_SPEC),
        error.kind === "INVALID_PAPER_DOMAIN" ? "ERROR" : error.kind,
        error.message,
      );
    }
    return unavailable(mode, SPY_SPEC.symbol, alpacaEquityFeedFor(SPY_SPEC), "DISCONNECTED_STREAM", error instanceof Error ? error.message : "Alpaca connection failed.");
  }
}

function fromWorker(snapshot: AlpacaWorkerSnapshot): LightlightRuntimeStatus {
  return {
    mode: "ALPACA_PAPER", connectionState: snapshot.streamState === "CONNECTED" ? "CONNECTED" : "DISCONNECTED_STREAM",
    workerState: snapshot.workerState, symbol: snapshot.symbol, workerKey: snapshot.workerKey, runtimeCapability: snapshot.runtimeCapability, feed: snapshot.feed, decisionTimeframe: snapshot.decisionTimeframe,
    latestRawBarTimestamp: snapshot.latestRawBarTimestamp, latestClosedBarTimestamp: snapshot.latestClosedDecisionBarTimestamp,
    latestDecisionId: snapshot.latestDecisionId, latestBrokerOrderState: snapshot.latestBrokerOrderState,
    currentPaperPosition: snapshot.brokerPosition, openOrderSummary: snapshot.openOrderSummary, riskState: snapshot.riskState,
    lastTradeUpdateTimestamp: snapshot.lastTradeUpdateTimestamp, lastReconciliationTimestamp: snapshot.lastReconciliationTimestamp,
    streamState: snapshot.streamState, haltReason: snapshot.haltReason, jevAdapter: "mock-jev", jevModel: "mock-jev-not-typesafe",
    error: snapshot.haltReason,
  };
}

function unavailable(
  mode: TradingMode,
  symbol: string,
  feed: string,
  connectionState: LightlightRuntimeStatus["connectionState"],
  error: string,
): LightlightRuntimeStatus {
  return {
    mode, connectionState, workerState: "HALTED", symbol, workerKey: SPY_RUNTIME_IDENTITY.workerKey, runtimeCapability: SPY_RUNTIME_IDENTITY.capability.kind, feed, decisionTimeframe: "15Min", latestRawBarTimestamp: null, latestClosedBarTimestamp: null,
    latestDecisionId: null, latestBrokerOrderState: null, currentPaperPosition: null,
    openOrderSummary: { count: 0, clientOrderIds: [] }, riskState: null, lastTradeUpdateTimestamp: null, lastReconciliationTimestamp: null,
    streamState: "DISCONNECTED", haltReason: error, jevAdapter: "mock-jev", jevModel: "mock-jev-not-typesafe", error,
  };
}
