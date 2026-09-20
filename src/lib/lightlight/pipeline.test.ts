import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateSyntheticCandles } from "./candles.ts";
import { computeFeatures } from "./features.ts";
import { createMockJevAdapter, createTypeSafeJevAdapter } from "./jev.ts";
import { runSession } from "./pipeline.ts";
import { TRADING_MODE } from "./types.ts";

describe("synthetic candles", () => {
  it("are deterministic for a fixed seed", () => {
    const a = generateSyntheticCandles(1, 40);
    const b = generateSyntheticCandles(1, 40);
    assert.equal(a.length, 40);
    assert.deepEqual(a, b);
  });

  it("differ when the seed differs", () => {
    const a = generateSyntheticCandles(1, 20);
    const b = generateSyntheticCandles(2, 20);
    assert.notEqual(a[19]!.close, b[19]!.close);
  });
});

describe("mock Jev adapter", () => {
  it("is deterministic for the same features", () => {
    const candles = generateSyntheticCandles(7, 80);
    const f = computeFeatures(candles)[60]!;
    const adapter = createMockJevAdapter();
    const x = adapter.classify(f);
    const y = adapter.classify(f);
    assert.deepEqual(x, y);
    assert.equal(x.model, "mock-jev-not-typesafe");
    const ps = Object.values(x.answers.REGIME.probabilities);
    const sum = ps.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
    assert.ok(x.answers.LONG_SETUP.noul >= 0 && x.answers.LONG_SETUP.noul <= 1);
  });

  it("never emits BUY/SELL prose fields", () => {
    const candles = generateSyntheticCandles(7, 80);
    const f = computeFeatures(candles)[60]!;
    const r = createMockJevAdapter().classify(f);
    const blob = JSON.stringify(r);
    assert.equal(/BUY|SELL/i.test(blob), false);
  });
});

describe("live TypeSafe adapter", () => {
  it("refuses to classify in sprint 0", () => {
    assert.throws(
      () => createTypeSafeJevAdapter().classify(computeFeatures(generateSyntheticCandles(1, 40))[30]!),
      /LIVE_JEV_DISABLED/,
    );
  });
});

describe("pipeline", () => {
  it("emits inspectable evidence for every bar", () => {
    const session = runSession({
      arm: "D",
      strategyId: "ema_trend",
      candles: generateSyntheticCandles(3, 90),
    });
    assert.equal(session.evidences.length, 90);
    const e = session.evidences[50]!;
    assert.equal(e.tradingMode, TRADING_MODE);
    assert.ok(e.jevRequest.state.ema_return_signal !== undefined);
    assert.ok(e.jevRequest.questions.REGIME);
    assert.ok(e.jevResponse.answers.REGIME.choice);
    assert.ok(e.policy.arm === "D");
    assert.ok(e.risk.version);
    assert.match(e.id, /^LL-SYN\.LL1-1D-/);
  });

  it("does not look ahead: fill is next bar", () => {
    const session = runSession({
      arm: "B",
      strategyId: "ema_trend",
      candles: generateSyntheticCandles(3, 90),
    });
    for (const fill of session.fills) {
      const intent = session.ledger.intents.find((candidate) => candidate.intentId === fill.intentId);
      assert.ok(intent);
      assert.equal(fill.fillBarIndex, intent.createdAtBar + 1);
    }
  });

  it("keeps Jev out of P&L and sizing", () => {
    const session = runSession({
      arm: "D",
      strategyId: "rsi_mean_reversion",
      candles: generateSyntheticCandles(4, 80),
    });
    const e = session.evidences[40]!;
    const stateKeys = Object.keys(e.jevRequest.state);
    assert.equal(stateKeys.includes("pnl"), false);
    assert.equal(stateKeys.includes("position_size"), false);
    assert.equal(e.risk.maxPosition, 1);
  });

  it("arm A is always long after warmup risk checks", () => {
    const session = runSession({
      arm: "A",
      strategyId: "ema_trend",
      candles: generateSyntheticCandles(5, 60),
    });
    const live = session.evidences.filter((e) => e.features.warmupComplete);
    assert.ok(live.length > 0);
    for (const e of live) {
      assert.equal(e.policy.desired, "LONG");
    }
  });
});
