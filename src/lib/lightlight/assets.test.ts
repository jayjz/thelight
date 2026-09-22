import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BTC_USD_SPEC,
  BOUNDED_US_EQUITY_ASSETS,
  SPY_SPEC,
  applyDirectionalCapability,
  boundedEquityAsset,
  isMarketSessionOpen,
  type AssetSpec,
} from "./assets.ts";

describe("asset runtime contract", () => {
  it("freezes the canonical SPY PAPER semantics", () => {
    assert.deepEqual(SPY_SPEC, {
      symbol: "SPY",
      assetClass: "US_EQUITY",
      marketDataKind: "ALPACA_IEX",
      session: "US_REGULAR",
      quantityMode: "WHOLE",
      directionMode: "LONG_ONLY",
    });
    assert.equal(applyDirectionalCapability(SPY_SPEC, "LONG"), "LONG");
    assert.equal(applyDirectionalCapability(SPY_SPEC, "SHORT"), "FLAT");
    assert.equal(applyDirectionalCapability(SPY_SPEC, "FLAT"), "FLAT");
  });

  it("defines exactly the bounded five-symbol long-only IEX equity registry", () => {
    assert.deepEqual(BOUNDED_US_EQUITY_ASSETS.map((asset) => asset.symbol), ["SPY", "QQQ", "IWM", "AAPL", "MSFT"]);
    for (const asset of BOUNDED_US_EQUITY_ASSETS) {
      assert.equal(asset.assetClass, "US_EQUITY"); assert.equal(asset.marketDataKind, "ALPACA_IEX");
      assert.equal(asset.session, "US_REGULAR"); assert.equal(asset.quantityMode, "WHOLE"); assert.equal(asset.directionMode, "LONG_ONLY");
    }
    assert.equal(boundedEquityAsset("qqq").symbol, "QQQ");
    assert.throws(() => boundedEquityAsset("TSLA"), /UNCONFIGURED_US_EQUITY_SYMBOL/);
  });

  it("preserves [09:30, 16:00) America/New_York eligibility", () => {
    const at = (value: string) => Date.parse(value);
    assert.equal(isMarketSessionOpen(SPY_SPEC, at("2026-09-21T13:29:00.000Z")), false, "09:29 ET");
    assert.equal(isMarketSessionOpen(SPY_SPEC, at("2026-09-21T13:30:00.000Z")), true, "09:30 ET");
    assert.equal(isMarketSessionOpen(SPY_SPEC, at("2026-09-21T19:59:59.999Z")), true, "15:59:59.999 ET");
    assert.equal(isMarketSessionOpen(SPY_SPEC, at("2026-09-21T20:00:00.000Z")), false, "16:00 ET");
    assert.equal(isMarketSessionOpen(SPY_SPEC, at("2026-09-20T13:30:00.000Z")), false, "weekend");
  });

  it("has a pure, unused always-open capability and maps long-only shorts to flat", () => {
    const futureLongOnly: AssetSpec = {
      ...SPY_SPEC,
      symbol: "UNWIRED/LONG_ONLY",
      assetClass: "CRYPTO",
      marketDataKind: "ALPACA_CRYPTO",
      session: "ALWAYS_OPEN",
      quantityMode: "FRACTIONAL",
      directionMode: "LONG_ONLY",
    };
    assert.equal(isMarketSessionOpen(futureLongOnly, Date.parse("2026-09-20T00:00:00.000Z")), true);
    assert.equal(applyDirectionalCapability(futureLongOnly, "SHORT"), "FLAT");
  });

  it("defines the canonical BTC/USD market-data-only capability", () => {
    assert.deepEqual(BTC_USD_SPEC, {
      symbol: "BTC/USD",
      assetClass: "CRYPTO",
      marketDataKind: "ALPACA_CRYPTO",
      session: "ALWAYS_OPEN",
      quantityMode: "FRACTIONAL",
      directionMode: "LONG_ONLY",
    });
    assert.equal(isMarketSessionOpen(BTC_USD_SPEC, Date.parse("2026-09-20T00:00:00.000Z")), true);
    assert.equal(applyDirectionalCapability(BTC_USD_SPEC, "SHORT"), "FLAT");
  });
});
