import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateSyntheticCandles } from "./candles.ts";
import { computeFeatures } from "./features.ts";
import { emaTrendSignal, rsiMeanReversionSignal } from "./policy.ts";

describe("deterministic signals", () => {
  it("are functions of features only", () => {
    const f = computeFeatures(generateSyntheticCandles(9, 80))[50]!;
    assert.deepEqual(emaTrendSignal(f), emaTrendSignal(f));
    assert.deepEqual(rsiMeanReversionSignal(f), rsiMeanReversionSignal(f));
  });

  it("stay flat during warmup", () => {
    const f = computeFeatures(generateSyntheticCandles(9, 10))[5]!;
    assert.equal(f.warmupComplete, false);
    assert.equal(emaTrendSignal(f).desired, "FLAT");
    assert.equal(rsiMeanReversionSignal(f).desired, "FLAT");
  });
});
