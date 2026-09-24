import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { emaRsiV2Strategy as strategy } from "./ema-rsi-v2.ts";
const bars = (closes: number[]) =>
  closes.map((close, i) => ({
    t: Date.parse("2026-09-22T13:30:00Z") + i * 60000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
const evaluate = (closes: number[], priorTarget: 0 | 1 = 0) =>
  strategy.evaluate({ completedBars: bars(closes), priorTarget });
test("V1 control blob unchanged", () => {
  const source = readFileSync(new URL("./ema-rsi-v1.ts", import.meta.url));
  assert.equal(
    createHash("sha1").update(`blob ${source.length}\0`).update(source).digest("hex"),
    "091f2e4d136d76c75310bb722e38275c13f55e4a",
  );
});
test("warmup, two closed bars and persistent strong entry", () => {
  const rising = Array.from({ length: 22 }, (_, i) => 100 + i);
  assert.equal(evaluate(rising.slice(0, 21)).targetPosition, 0);
  assert.equal(evaluate(rising).targetPosition, 1);
  assert.equal(strategy.warmupBars, 22);
});
test("one-bar microscopic or strong false crossover cannot enter", () => {
  for (const jump of [0.000001, 10]) {
    const r = evaluate([...Array(21).fill(100), 100 + jump]);
    assert.equal(r.targetPosition, 0);
    assert.equal(r.features.previousEntryCandidate, false);
  }
});
test("neutral jitter retains long; deterministic exit; long/flat", () => {
  assert.equal(evaluate(Array(24).fill(100), 1).targetPosition, 1);
  const fall = Array.from({ length: 24 }, (_, i) => 150 - i);
  assert.equal(evaluate(fall, 1).targetPosition, 0);
  assert.deepEqual(evaluate(fall, 1), evaluate(fall, 1));
  for (let i = 1; i <= 24; i++)
    assert.ok([0, 1].includes(evaluate(fall.slice(0, i)).targetPosition));
});
test("future mutation cannot change prefix decision; noncausal ordering rejected", () => {
  const prefix = bars(Array.from({ length: 25 }, (_, i) => 100 + i));
  const expected = strategy.evaluate({ completedBars: prefix, priorTarget: 0 });
  const future = [...prefix, { ...prefix.at(-1)!, t: prefix.at(-1)!.t + 60000, close: 1 }];
  assert.deepEqual(
    strategy.evaluate({ completedBars: future.slice(0, prefix.length), priorTarget: 0 }),
    expected,
  );
  assert.throws(
    () => strategy.evaluate({ completedBars: [prefix[1]!, prefix[0]!], priorTarget: 0 }),
    /ordered/,
  );
});

test("positive crossover with RSI above 50 still fails the normalized strength floor", () => {
  const r = evaluate([
    ...Array.from({ length: 22 }, (_, i) => (i % 2 ? 100.6 : 100.4)),
    100.6,
    100.61,
  ]);
  assert.ok(Number(r.features.emaSpread) > 0);
  assert.ok(Number(r.features.rsi14) > 50);
  assert.ok(Number(r.features.signedStrength) < 0.5);
  assert.equal(r.features.entryCandidate, false);
  assert.equal(r.targetPosition, 0);
});
test("microscopic negative crossing retains long inside hysteresis", () => {
  const r = evaluate(
    [...Array.from({ length: 22 }, (_, i) => (i % 2 ? 100.6 : 100.4)), 100.51, 100.52],
    1,
  );
  assert.ok(Number(r.features.emaSpread) < 0);
  assert.ok(Number(r.features.signedStrength) > -0.25);
  assert.ok(Number(r.features.rsi14) >= 45);
  assert.equal(r.targetPosition, 1);
});
