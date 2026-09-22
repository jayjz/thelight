import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  ObserverChangeDetector,
  classifyContinuity,
  classifyRecovery,
  classifyLease,
  classifyStream,
  formatEt,
  loadObserverSnapshot,
  renderCurrentState,
  renderEvent,
  type ObserverDecision,
  type ObserverSnapshot,
} from "./alpaca-observe.ts";

const decisionTime = Date.parse("2026-09-21T15:45:00.000Z");

function decision(overrides: Partial<ObserverDecision> = {}): ObserverDecision {
  return {
    decisionId: "LLP-decision-0000000000000000",
    timestamp: decisionTime,
    createdAt: "2026-09-21T15:45:01.000Z",
    strategySignal: "FLAT",
    strategyReason: "EMA_TREND_FLAT",
    policyDesired: "FLAT",
    policyReason: "DETERMINISTIC_REGIME_GATE",
    action: "FLAT",
    targetPosition: 0,
    riskReasons: [],
    intent: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ObserverSnapshot> = {}): ObserverSnapshot {
  return {
    workerKey: "alpaca-paper:SPY:15Min:alpaca-paper-worker-v1",
    symbol: "SPY",
    checkpoint: {
      marketStreamState: "CONNECTED",
      tradeUpdateStreamState: "CONNECTED",
      featureContinuity: "HEALTHY",
      recoveryState: "HEALTHY",
      latestRawBarTimestamp: decisionTime,
      latestClosedDecisionBarTimestamp: decisionTime,
      latestDecisionId: "LLP-decision-0000000000000000",
      lastReconciliationTimestamp: "2026-09-21T15:45:01.000Z",
      paperEquity: 5000,
      haltReason: null,
      updatedAt: "2026-09-21T15:45:01.000Z",
    },
    lease: { runId: "run-1", fencingToken: 5, expiresAt: "2026-09-21T15:45:30.000Z", renewedAt: "2026-09-21T15:45:00.000Z", live: true },
    run: { runId: "run-1", state: "READY", haltReason: null, startedAt: "2026-09-21T14:00:00.000Z" },
    latestRawBarTimestamp: decisionTime,
    latestTradeUpdateAt: "2026-09-21T15:45:02.000Z",
    paperPosition: { quantity: 0, reconciledAt: "2026-09-21T15:45:01.000Z" },
    decisions: [decision()],
    brokerOrders: [],
    tradeUpdates: [],
    recovery: null,
    ...overrides,
  };
}

describe("Alpaca PAPER terminal observer", () => {
  it("renders CONNECTED streams as healthy", () => {
    assert.deepEqual(classifyStream("CONNECTED"), { icon: "🟢", label: "connected" });
    const output = renderCurrentState(snapshot(), { now: new Date("2026-09-21T15:45:02.000Z") });
    assert.match(output, /🟢 MARKET\s+connected/);
    assert.match(output, /🟢 TRADE FEED\s+connected/);
  });

  it("renders REBUILDING as a safe waiting gate, not healthy", () => {
    assert.deepEqual(classifyContinuity("REBUILDING"), { icon: "🟡", label: "rebuilding (safe gate)" });
    const output = renderCurrentState(snapshot({ checkpoint: { ...snapshot().checkpoint!, featureContinuity: "REBUILDING" } }));
    assert.match(output, /🟡 CONTINUITY\s+rebuilding \(safe gate\)/);
    assert.doesNotMatch(output, /🟢 CONTINUITY/);
  });

  it("renders the ema_rsi_v1 decision fields without changing the observer layout", () => {
    const output = renderCurrentState(snapshot({ decisions: [decision({
      strategyId: "ema_rsi_v1", strategyVersion: "v1", ema9: 600.125, ema21: 599.875, rsi14: 57.4,
      finalRiskApprovedTarget: 1, blockReason: "LATEST_LIVE_BAR_STALE",
    })] }));
    assert.match(output, /ema_rsi_v1/);
    assert.match(output, /EMA9=600\.125\s+EMA21=599\.875\s+RSI14=57\.4/);
    assert.match(output, /LONG → target 1/);
    assert.match(output, /blocked: LATEST_LIVE_BAR_STALE/);
  });

  it("renders every durable market-recovery state without exposing provider payloads", () => {
    assert.equal(classifyRecovery("GAP_DETECTED").label, "gap detected (safe gate)");
    assert.equal(classifyRecovery("BACKFILLING").label, "backfilling (safe gate)");
    assert.equal(classifyRecovery("VERIFYING").label, "verifying (safe gate)");
    assert.equal(classifyRecovery("REBUILDING").label, "rebuilding (safe gate)");
    const recovery = { recoveryAttemptId: "attempt-1", state: "HEALTHY", missingStartMs: decisionTime, missingEndMs: decisionTime + 60_000, detectedAt: "2026-09-21T15:45:01.000Z", requestedAt: "2026-09-21T15:45:02.000Z", verifiedAt: "2026-09-21T15:45:03.000Z", completedAt: "2026-09-21T15:45:03.000Z", returnedBarCount: 1, verifiedBarCount: 1, result: "VERIFIED", reason: null };
    assert.match(renderEvent({ kind: "recovery", recovery }), /✅ backfill verified 1 bar; 🧠 continuity restored/);
  });

  it("renders a durable halt reason prominently", () => {
    const output = renderCurrentState(snapshot({ checkpoint: { ...snapshot().checkpoint!, haltReason: "PAPER_EQUITY_UNAVAILABLE" } }));
    assert.match(output, /🔴 SAFETY\s+HALTED — PAPER_EQUITY_UNAVAILABLE/);
  });

  it("distinguishes a live lease from an expired lease", () => {
    assert.deepEqual(classifyLease(snapshot().lease), { icon: "🟢", label: "lease live" });
    assert.deepEqual(classifyLease({ ...snapshot().lease!, live: false }), { icon: "🔴", label: "lease expired" });
  });

  it("emits a new decision once and does not duplicate it on the next poll", () => {
    const detector = new ObserverChangeDetector();
    detector.observe(snapshot({ decisions: [] }));
    const first = detector.observe(snapshot({ decisions: [decision()] }));
    assert.deepEqual(first.map((event) => event.kind), ["decision"]);
    assert.deepEqual(detector.observe(snapshot({ decisions: [decision()] })), []);
  });

  it("emits a new intent state after its decision", () => {
    const detector = new ObserverChangeDetector();
    detector.observe(snapshot({ decisions: [] }));
    detector.observe(snapshot({ decisions: [decision()] }));
    const withIntent = decision({ intent: {
      intentId: "LLP-decision-0000000000000000:intent", decisionId: "LLP-decision-0000000000000000", status: "CANCELLED",
      desiredAction: "FLAT", desiredPosition: 0, dispatchBlockReason: "FEATURE_CONTINUITY_REBUILDING", updatedAt: "2026-09-21T15:45:02.000Z",
    } });
    const events = detector.observe(snapshot({ decisions: [withIntent] }));
    assert.deepEqual(events.map((event) => event.kind), ["intent"]);
    assert.match(renderEvent(events[0]!), /🎯 intent CANCELLED — FEATURE_CONTINUITY_REBUILDING/);
  });

  it("sanitizes broker-order output and excludes raw provider payloads", () => {
    const output = renderEvent({
      kind: "broker",
      order: { eventId: "event-1", intentId: "intent-1", brokerOrderId: "broker-order-id-very-long-and-private", status: "ACCEPTED", lookup: "FOUND", observedAt: "2026-09-21T15:45:02.000Z" },
    });
    assert.match(output, /✅ broker ACCEPTED id=broker-order…/);
    assert.doesNotMatch(output, /very-long-and-private|raw_status|provider message/i);
  });

  it("never prints database URLs or credential-shaped halt text", () => {
    const output = renderCurrentState(snapshot({ checkpoint: {
      ...snapshot().checkpoint!, haltReason: "postgres://user:password@example.test/db secret=abc123",
    } }));
    assert.doesNotMatch(output, /postgres:\/\/|abc123|password@example/i);
    assert.match(output, /database-url-redacted/);
  });

  it("uses only SELECT statements when loading durable observer state", async () => {
    const statements: string[] = [];
    const query = {
      query: async <T extends Record<string, unknown>>(text: string) => {
        statements.push(text);
        return { rows: [] as T[] };
      },
    };
    const empty = await loadObserverSnapshot(query);
    assert.equal(empty.decisions.length, 0);
    assert.ok(statements.length >= 9);
    assert.ok(statements.every((statement) => /^\s*select\b/i.test(statement)));
    assert.ok(statements.every((statement) => !/\b(insert|update|delete)\b/i.test(statement)));
  });

  it("has no execution-authority or order-submission import path", async () => {
    const source = await readFile(new URL("../../../scripts/alpaca-paper-observe.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /alpaca-worker|alpaca\.server|AlpacaPaperExecution|\.submit\(/);
  });

  it("formats presentation timestamps in America/New_York with an ET suffix", () => {
    assert.equal(formatEt("2026-07-01T16:05:00.000Z"), "12:05 ET");
    assert.equal(formatEt("2026-01-01T14:05:06.000Z", true), "09:05:06 ET");
  });

  it("handles an empty durable database without fabricating state", () => {
    const output = renderCurrentState(snapshot({ checkpoint: null, lease: null, run: null, latestRawBarTimestamp: null, latestTradeUpdateAt: null, paperPosition: null, decisions: [] }));
    assert.match(output, /waiting for first decision/);
    assert.match(output, /no durable lease/);
    assert.doesNotMatch(output, /LLP-/);
  });

  it("keeps Ctrl+C handling observational in the CLI implementation", async () => {
    const source = await readFile(new URL("../../../scripts/alpaca-paper-observe.ts", import.meta.url), "utf8");
    assert.match(source, /process\.once\("SIGINT", requestStop\)/);
    assert.match(source, /client\.end\(\)/);
    assert.doesNotMatch(source, /\b(insert|update|delete|fetch|AlpacaPaperBroker)\b/i);
  });
});
