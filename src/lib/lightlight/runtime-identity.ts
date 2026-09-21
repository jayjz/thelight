import { BTC_USD_SPEC, SPY_SPEC, type AssetSpec } from "./assets.ts";

/** The durable identity format is a compatibility contract, not display text. */
export const ALPACA_PAPER_DECISION_TIMEFRAME = "15Min" as const;
export const ALPACA_PAPER_WORKER_VERSION = "alpaca-paper-worker-v1" as const;
export const EMA_RSI_V1_DECISION_TIMEFRAME = "1Min" as const;
export const EMA_RSI_V1_WORKER_VERSION = "ema-rsi-v1-paper-worker-v1" as const;

export type PaperWorkerArm = "ema_trend_arm_c" | "ema_rsi_v1";

export type ReadOnlyDurableCapability = {
  kind: "READ_ONLY_DURABLE";
  reason: "MARKET_EVIDENCE_ONLY";
};

export type DispatchCapableCapability = {
  kind: "DISPATCH_CAPABLE";
  brokerBoundary: "ALPACA_PAPER_EQUITY";
};

export type WorkerRuntimeCapability = ReadOnlyDurableCapability | DispatchCapableCapability;

export type WorkerRuntimeIdentity = {
  asset: AssetSpec;
  executionMode: "ALPACA_PAPER";
  decisionTimeframe: typeof ALPACA_PAPER_DECISION_TIMEFRAME | typeof EMA_RSI_V1_DECISION_TIMEFRAME;
  workerVersion: typeof ALPACA_PAPER_WORKER_VERSION | typeof EMA_RSI_V1_WORKER_VERSION;
  workerKey: string;
  capability: WorkerRuntimeCapability;
};

function sameAsset(left: AssetSpec, right: AssetSpec): boolean {
  return left.symbol === right.symbol &&
    left.assetClass === right.assetClass &&
    left.marketDataKind === right.marketDataKind &&
    left.session === right.session &&
    left.quantityMode === right.quantityMode &&
    left.directionMode === right.directionMode;
}

/**
 * The sole B3 authority switch. A runtime identity can be durable without
 * receiving the type/capability needed to reach a broker mutation boundary.
 */
export function runtimeCapabilityForAsset(asset: AssetSpec): WorkerRuntimeCapability {
  if (sameAsset(asset, SPY_SPEC)) {
    return { kind: "DISPATCH_CAPABLE", brokerBoundary: "ALPACA_PAPER_EQUITY" };
  }
  return { kind: "READ_ONLY_DURABLE", reason: "MARKET_EVIDENCE_ONLY" };
}

/**
 * Pure, deterministic durable identity derived from the explicit asset
 * contract. SPY's resulting worker key is intentionally byte-for-byte legacy.
 */
export function workerRuntimeIdentityFor(asset: AssetSpec, arm: PaperWorkerArm = "ema_trend_arm_c"): WorkerRuntimeIdentity {
  const emaRsi = arm === "ema_rsi_v1";
  const decisionTimeframe = emaRsi ? EMA_RSI_V1_DECISION_TIMEFRAME : ALPACA_PAPER_DECISION_TIMEFRAME;
  const workerVersion = emaRsi ? EMA_RSI_V1_WORKER_VERSION : ALPACA_PAPER_WORKER_VERSION;
  return {
    asset,
    executionMode: "ALPACA_PAPER",
    decisionTimeframe,
    workerVersion,
    workerKey: `alpaca-paper:${asset.symbol}:${decisionTimeframe}:${workerVersion}`,
    capability: runtimeCapabilityForAsset(asset),
  };
}

export const SPY_RUNTIME_IDENTITY = workerRuntimeIdentityFor(SPY_SPEC);
export const SPY_EMA_RSI_V1_RUNTIME_IDENTITY = workerRuntimeIdentityFor(SPY_SPEC, "ema_rsi_v1");
export const BTC_USD_RUNTIME_IDENTITY = workerRuntimeIdentityFor(BTC_USD_SPEC);

export function assertDispatchCapable(
  identity: WorkerRuntimeIdentity,
): asserts identity is WorkerRuntimeIdentity & { capability: DispatchCapableCapability } {
  if (identity.capability.kind !== "DISPATCH_CAPABLE") {
    throw new Error("RUNTIME_DISPATCH_CAPABILITY_REQUIRED");
  }
}

export function assertReadOnlyDurable(
  identity: WorkerRuntimeIdentity,
): asserts identity is WorkerRuntimeIdentity & { capability: ReadOnlyDurableCapability } {
  if (identity.capability.kind !== "READ_ONLY_DURABLE") {
    throw new Error("READ_ONLY_DURABLE_RUNTIME_REQUIRED");
  }
}
