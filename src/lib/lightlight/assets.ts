import type { Action } from "./types.ts";

/** Broker/runtime capabilities. Strategy and risk parameters do not belong here. */
export type AssetClass = "US_EQUITY" | "CRYPTO";
export type MarketDataKind = "ALPACA_IEX" | "ALPACA_CRYPTO";
export type MarketSession = "US_REGULAR" | "ALWAYS_OPEN";
export type QuantityMode = "WHOLE" | "FRACTIONAL";
export type DirectionMode = "LONG_SHORT" | "LONG_ONLY";

export type AssetSpec = {
  symbol: string;
  assetClass: AssetClass;
  marketDataKind: MarketDataKind;
  session: MarketSession;
  quantityMode: QuantityMode;
  directionMode: DirectionMode;
};

/** The sole PAPER asset wired into the runtime in B0/B1. */
export const SPY_SPEC = {
  symbol: "SPY",
  assetClass: "US_EQUITY",
  marketDataKind: "ALPACA_IEX",
  session: "US_REGULAR",
  quantityMode: "WHOLE",
  directionMode: "LONG_ONLY",
} as const satisfies AssetSpec;

/** The complete, deliberately small IEX equity universe for ema_rsi_v1. */
export const US_EQUITY_UNIVERSE = ["SPY", "QQQ", "IWM", "AAPL", "MSFT"] as const;
export type BoundedEquitySymbol = typeof US_EQUITY_UNIVERSE[number];

const equitySpec = (symbol: BoundedEquitySymbol) => ({
  symbol, assetClass: "US_EQUITY", marketDataKind: "ALPACA_IEX",
  session: "US_REGULAR", quantityMode: "WHOLE", directionMode: "LONG_ONLY",
} as const satisfies AssetSpec);

export const QQQ_SPEC = equitySpec("QQQ");
export const IWM_SPEC = equitySpec("IWM");
export const AAPL_SPEC = equitySpec("AAPL");
export const MSFT_SPEC = equitySpec("MSFT");
export const BOUNDED_US_EQUITY_ASSETS = [SPY_SPEC, QQQ_SPEC, IWM_SPEC, AAPL_SPEC, MSFT_SPEC] as const;

export function boundedEquityAsset(symbol: string): (typeof BOUNDED_US_EQUITY_ASSETS)[number] {
  const asset = BOUNDED_US_EQUITY_ASSETS.find((candidate) => candidate.symbol === symbol.toUpperCase());
  if (!asset) throw new Error("UNCONFIGURED_US_EQUITY_SYMBOL");
  return asset;
}

export function isBoundedEquitySymbol(symbol: string): symbol is BoundedEquitySymbol {
  return (US_EQUITY_UNIVERSE as readonly string[]).includes(symbol);
}

/**
 * Read-only crypto market-data identity for B2. This capability contract does
 * not wire BTC into the durable PAPER worker or grant broker authority.
 */
export const BTC_USD_SPEC = {
  symbol: "BTC/USD",
  assetClass: "CRYPTO",
  marketDataKind: "ALPACA_CRYPTO",
  session: "ALWAYS_OPEN",
  quantityMode: "FRACTIONAL",
  directionMode: "LONG_ONLY",
} as const satisfies AssetSpec;

/**
 * Preserve the existing NYSE weekday/time heuristic. This deliberately is not
 * an exchange calendar and therefore does not model holidays or closures.
 */
function isUsRegularSession(timestamp: number): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = value("weekday");
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minuteOfDay = Number(value("hour")) * 60 + Number(value("minute"));
  return minuteOfDay >= 9 * 60 + 30 && minuteOfDay < 16 * 60;
}

/** Determines whether an asset may form a decision bucket at this timestamp. */
export function isMarketSessionOpen(asset: AssetSpec, timestamp: number): boolean {
  if (asset.session === "US_REGULAR") return isUsRegularSession(timestamp);
  // Pure capability branch only. No ALWAYS_OPEN asset is wired into a runtime yet.
  return true;
}

/**
 * Applies the broker/runtime directional capability after strategy policy.
 * A long-only asset can exit/reduce a long on a negative signal but can never
 * request a broker short.
 */
export function applyDirectionalCapability(asset: AssetSpec, action: Action): Action {
  if (asset.directionMode === "LONG_ONLY" && action === "SHORT") return "FLAT";
  return action;
}

/** Stock-feed selection remains separate from the dedicated crypto adapter. */
export function alpacaEquityFeedFor(asset: AssetSpec): "iex" {
  if (asset.marketDataKind !== "ALPACA_IEX") {
    throw new Error(`ALPACA_EQUITY_FEED_UNSUPPORTED_FOR_${asset.marketDataKind}`);
  }
  return "iex";
}
