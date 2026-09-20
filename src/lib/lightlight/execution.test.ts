import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateSyntheticCandles } from "./candles.ts";
import { computePathMetrics } from "./evaluate.ts";
import { ReplayExecution } from "./execution.ts";
import { runSession } from "./pipeline.ts";
import { runSessionFromMarketSource } from "./pipeline.ts";
import { SyntheticMarketSource } from "./market.ts";
import type { Candle, Evidence } from "./types.ts";

function bars(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    t: 1_700_000_000_000 + i * 60_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
  }));
}

function ledgerWithLongAtZero(
  closes: number[],
  costs = { transactionCostBps: 0, slippageBps: 0 },
) {
  const source = bars(closes);
  const execution = new ReplayExecution(costs);
  for (let i = 0; i < source.length; i++) {
    execution.advanceBar(i, source[i]!, source[i - 1]);
    if (i === 0) {
      execution.createIntent({
        decisionId: "decision-0",
        createdAtBar: 0,
        createdAtTimestamp: source[0]!.t,
        action: "LONG",
      });
    }
  }
  return execution.snapshot();
}

describe("canonical replay execution ledger", () => {
  it("a decision at t cannot earn t→t+1", () => {
    const upBeforeFill = ledgerWithLongAtZero([100, 200, 200]);
    const downBeforeFill = ledgerWithLongAtZero([100, 50, 200]);
    assert.ok(Math.abs(upBeforeFill.equity[1]!.periodReturn) < 1e-12);
    assert.ok(Math.abs(downBeforeFill.equity[1]!.periodReturn) < 1e-12);
    assert.equal(upBeforeFill.equity[1]!.equity, downBeforeFill.equity[1]!.equity);
  });

  it("a fill at t+1 earns t+1→t+2", () => {
    const ledger = ledgerWithLongAtZero([100, 100, 200]);
    assert.equal(ledger.fills[0]!.fillBarIndex, 1);
    assert.ok(Math.abs(ledger.equity[2]!.periodReturn - Math.log(2)) < 1e-12);
  });

  it("reported final equity equals the execution-ledger final equity", () => {
    const session = runSession({
      arm: "B",
      strategyId: "ema_trend",
      candles: generateSyntheticCandles(7, 90),
    });
    assert.equal(session.metrics.totalReturn, session.ledger.finalEquity - 1);
  });

  it("risk-vetoed direction does not create exposure", () => {
    const source = bars([100, 100, 100]);
    const execution = new ReplayExecution({ transactionCostBps: 0, slippageBps: 0 });
    for (let i = 0; i < source.length; i++) {
      execution.advanceBar(i, source[i]!, source[i - 1]);
      if (i === 0) {
        // Risk's final target is FLAT even if policy had requested direction.
        execution.createIntent({
          decisionId: "veto",
          createdAtBar: i,
          createdAtTimestamp: source[i]!.t,
          action: "FLAT",
        });
      }
    }
    const ledger = execution.snapshot();
    assert.equal(ledger.fills.length, 0);
    assert.ok(ledger.equity.every((point) => point.positionApplied === 0));
  });

  it("a final-bar decision stays pending rather than synthesizing a fill", () => {
    const source = bars([100, 101]);
    const execution = new ReplayExecution({ transactionCostBps: 0, slippageBps: 0 });
    source.forEach((bar, i) => execution.advanceBar(i, bar, source[i - 1]));
    execution.createIntent({
      decisionId: "last",
      createdAtBar: 1,
      createdAtTimestamp: source[1]!.t,
      action: "LONG",
    });
    const ledger = execution.snapshot();
    assert.equal(ledger.fills.length, 0);
    assert.equal(ledger.intents[0]!.status, "PENDING");
  });

  it("charges transaction cost exactly once per transition", () => {
    const ledger = ledgerWithLongAtZero([100, 100, 100], {
      transactionCostBps: 10,
      slippageBps: 0,
    });
    assert.equal(ledger.totalTransactionCost, 0.001);
    assert.equal(ledger.equity[1]!.transactionCost, 0.001);
    assert.equal(ledger.equity[2]!.transactionCost, 0);
  });

  it("charges configured slippage exactly once per transition", () => {
    const ledger = ledgerWithLongAtZero([100, 100, 100], {
      transactionCostBps: 0,
      slippageBps: 10,
    });
    assert.equal(ledger.totalSlippage, 0.001);
    assert.equal(ledger.equity[1]!.slippage, 0.001);
    assert.equal(ledger.equity[2]!.slippage, 0);
  });

  it("future candles cannot alter prior decision inputs or evidence", () => {
    const source = generateSyntheticCandles(44, 90);
    const changed = source.map((bar) => ({ ...bar }));
    changed[80] = {
      ...changed[80]!,
      close: changed[80]!.close * 1.5,
      high: changed[80]!.high * 1.5,
    };
    const before = runSession({ arm: "D", strategyId: "ema_trend", candles: source });
    const after = runSession({ arm: "D", strategyId: "ema_trend", candles: changed });
    const pick = (e: Evidence) => ({
      features: e.features,
      signal: e.deterministicSignal,
      request: e.jevRequest,
      policy: e.policy,
      risk: e.risk,
    });
    assert.deepEqual(pick(before.evidences[50]!), pick(after.evidences[50]!));
  });

  it("keeps seeded synthetic replay deterministic", () => {
    const candles = generateSyntheticCandles(101, 90);
    const a = runSession({ arm: "C", strategyId: "ema_trend", candles });
    const b = runSession({ arm: "C", strategyId: "ema_trend", candles });
    assert.deepEqual(a.ledger, b.ledger);
  });

  it("evaluation consumes the supplied ledger rather than reconstructing decisions", () => {
    const ledger = ledgerWithLongAtZero([100, 100, 110]);
    const metrics = computePathMetrics(bars([100, 100, 110]), [], ledger);
    assert.equal(metrics.totalReturn, ledger.finalEquity - 1);
  });

  it("runs a MarketSource through the same canonical pipeline", async () => {
    const candles = generateSyntheticCandles(8, 50);
    const session = await runSessionFromMarketSource({
      source: new SyntheticMarketSource(candles),
      arm: "B",
      strategyId: "ema_trend",
    });
    assert.equal(session.candles.length, candles.length);
    assert.equal(session.ledger.equity.length, candles.length);
  });
});
