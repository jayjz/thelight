import { createServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import type { LightlightRuntimeStatus } from "./runtime.server.ts";

export const getLightlightRuntimeStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<LightlightRuntimeStatus> => {
    const { readLightlightRuntimeStatus } = await import("./runtime.server.ts");
    return readLightlightRuntimeStatus();
  },
);

const replayStatus: LightlightRuntimeStatus = {
  mode: "PAPER_REPLAY", connectionState: "REPLAY", workerState: null, symbol: "SYN.LL1", workerKey: null, runtimeCapability: null, feed: "synthetic-seeded", decisionTimeframe: "1D", latestRawBarTimestamp: null,
  latestClosedBarTimestamp: null, latestDecisionId: null, latestBrokerOrderState: null,
  currentPaperPosition: 0, openOrderSummary: { count: 0, clientOrderIds: [] }, riskState: null, lastTradeUpdateTimestamp: null,
  lastReconciliationTimestamp: null, streamState: "REPLAY", haltReason: null, jevAdapter: "mock-jev", jevModel: "mock-jev-not-typesafe", error: null,
};

/** The UI observes a server-owned runtime snapshot; it never owns broker logic. */
export function useLightlightRuntimeStatus(): LightlightRuntimeStatus {
  const [status, setStatus] = useState<LightlightRuntimeStatus>(replayStatus);
  useEffect(() => {
    let cancelled = false;
    void getLightlightRuntimeStatus().then((next) => {
      if (!cancelled) setStatus(next);
    }).catch(() => {
      // Keep a truthful replay default if the status endpoint is unavailable.
    });
    return () => { cancelled = true; };
  }, []);
  return status;
}
