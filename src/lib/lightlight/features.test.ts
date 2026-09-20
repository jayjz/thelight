import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  grebenkovReturnSignal,
  logReturn,
  mean,
  recursiveEma,
  rsiSma,
  sampleStd,
} from "./features.ts";

describe("recursiveEma", () => {
  it("matches Grebenkov recurrent form on a constant series", () => {
    const x = [10, 10, 10, 10];
    assert.deepEqual(recursiveEma(x, 0.5), [10, 10, 10, 10]);
  });

  it("applies tilde_x_t = (1-λ) tilde_x_{t-1} + λ x_t", () => {
    const x = [1, 3];
    const ema = recursiveEma(x, 0.5);
    assert.equal(ema[0], 1);
    assert.equal(ema[1], 0.5 * 1 + 0.5 * 3);
  });

  it("rejects invalid lambda", () => {
    assert.throws(() => recursiveEma([1], 0));
  });
});

describe("grebenkovReturnSignal", () => {
  it("is zero at the first bar (no past returns)", () => {
    const s = grebenkovReturnSignal([0.1, 0.2, 0.3], 0.5);
    assert.equal(s[0], 0);
  });

  it("uses only past returns: s_t = γ u_t with u_t = r_{t-1} + (1-η) u_{t-1}", () => {
    const r = [0.1, 0.2, 0.3];
    const eta = 0.5;
    const gamma = Math.sqrt(eta * (2 - eta));
    const s = grebenkovReturnSignal(r, eta);
    const u2 = r[0]!;
    const u3 = r[1]! + (1 - eta) * u2;
    assert.ok(Math.abs(s[1]! - gamma * u2) < 1e-12);
    assert.ok(Math.abs(s[2]! - gamma * u3) < 1e-12);
  });

  it("does not include contemporaneous return in s_t", () => {
    const a = grebenkovReturnSignal([0.1, 0.2], 0.4);
    const b = grebenkovReturnSignal([0.1, 99], 0.4);
    assert.equal(a[1], b[1]);
  });
});

describe("rsiSma", () => {
  it("is NaN until 14 closed changes exist", () => {
    const closes = Array.from({ length: 14 }, (_, i) => 100 + i);
    const rsi = rsiSma(closes, 14);
    assert.ok(Number.isNaN(rsi[13]));
  });

  it("matches Khaidem's RSI = 100 - 100/(1+RS) on a known series", () => {
    const closes = [100, 101, 102, 101, 103];
    const rsi = rsiSma(closes, 2);
    // period 2 ending at index 3: changes +1, -1 → avgGain=0.5 avgLoss=0.5 RS=1 RSI=50
    assert.equal(rsi[3], 50);
    // ending at index 4: changes -1, +2 → avgGain=1 avgLoss=0.5 RS=2 RSI=100-100/3
    assert.ok(Math.abs(rsi[4]! - (100 - 100 / 3)) < 1e-12);
  });

  it("is 100 when there are no losses", () => {
    const closes = [1, 2, 3, 4];
    const rsi = rsiSma(closes, 3);
    assert.equal(rsi[3], 100);
  });

  it("is 0 when there are no gains", () => {
    const closes = [4, 3, 2, 1];
    const rsi = rsiSma(closes, 3);
    assert.equal(rsi[3], 0);
  });
});

describe("logReturn and std", () => {
  it("logReturn is ln(c/p)", () => {
    assert.ok(Math.abs(logReturn(100, 110) - Math.log(1.1)) < 1e-12);
  });

  it("sampleStd matches the unbiased estimator", () => {
    const xs = [1, 2, 3];
    assert.ok(Math.abs(sampleStd(xs) - 1) < 1e-12);
    assert.equal(mean(xs), 2);
  });
});
