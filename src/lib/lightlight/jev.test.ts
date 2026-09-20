import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateSyntheticCandles } from "./candles.ts";
import { computeFeatures } from "./features.ts";
import { buildJevRequest, JEV_QUESTIONS, JEV_MODEL_MOCK } from "./jev.ts";

describe("Jev contract", () => {
  it("asks the six atomic questions independently", () => {
    assert.deepEqual(Object.keys(JEV_QUESTIONS).sort(), [
      "LONG_SETUP",
      "MARKET_QUALITY",
      "MEAN_REVERSION",
      "REGIME",
      "SHORT_SETUP",
      "TREND",
    ]);
    assert.equal(JEV_QUESTIONS.REGIME?.type, "choice");
    assert.equal(JEV_QUESTIONS.LONG_SETUP?.type, "noul");
    assert.equal(JEV_QUESTIONS.SHORT_SETUP?.type, "noul");
    assert.equal(JEV_QUESTIONS.MEAN_REVERSION?.type, "noul");
    assert.equal(JEV_QUESTIONS.TREND?.type, "noul");
    assert.equal(JEV_QUESTIONS.MARKET_QUALITY?.type, "score");
  });

  it("sends compact already-computed numerics, not raw candles", () => {
    const f = computeFeatures(generateSyntheticCandles(1, 50))[40]!;
    const req = buildJevRequest(f, JEV_MODEL_MOCK);
    assert.equal("candles" in req.state, false);
    assert.equal(typeof req.state.ema_return_signal, "number");
    assert.equal(typeof req.state.rsi_14, "number");
    for (const q of Object.values(req.questions)) {
      if ("instructions" in q) {
        assert.equal(/buy|sell/i.test(q.instructions), false);
      }
    }
  });
});
