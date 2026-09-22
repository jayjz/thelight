import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BTC_USD_SPEC, BOUNDED_US_EQUITY_ASSETS, SPY_SPEC } from "./assets.ts";
import { DurableMarketWorker } from "./durable-market-worker.server.ts";
import { deterministicClientOrderId, deterministicDecisionId } from "./alpaca-worker.server.ts";
import { MemoryAlpacaWorkerStore } from "./alpaca-worker-store.server.ts";
import {
  BTC_USD_RUNTIME_IDENTITY,
  SPY_RUNTIME_IDENTITY,
  assertReadOnlyDurable,
  workerRuntimeIdentityFor,
} from "./runtime-identity.ts";

const bar = (t: number) => ({ t, open: 100, high: 101, low: 99, close: 100.5, volume: 1 });

describe("asset-scoped durable runtime identity", () => {
  it("preserves the exact legacy SPY worker key and decision identity", () => {
    assert.equal(SPY_RUNTIME_IDENTITY.workerKey, "alpaca-paper:SPY:15Min:alpaca-paper-worker-v1");
    assert.equal(deterministicDecisionId(1_726_000_000_000), "LLP-0899534782dacd0f762402220b2a6c4e");
    assert.equal(deterministicDecisionId(1_726_000_000_000, SPY_RUNTIME_IDENTITY), deterministicDecisionId(1_726_000_000_000));
  });

  it("derives deterministic, distinct BTC identity from AssetSpec", () => {
    const first = workerRuntimeIdentityFor(BTC_USD_SPEC);
    const second = workerRuntimeIdentityFor(BTC_USD_SPEC);
    assert.deepEqual(first, second);
    assert.equal(first.workerKey, "alpaca-paper:BTC/USD:15Min:alpaca-paper-worker-v1");
    assert.notEqual(first.workerKey, SPY_RUNTIME_IDENTITY.workerKey);
    assert.equal(first.asset, BTC_USD_SPEC);
    assert.equal(first.capability.kind, "READ_ONLY_DURABLE");
    assert.equal(workerRuntimeIdentityFor(SPY_SPEC).capability.kind, "DISPATCH_CAPABLE");
  });

  it("isolates every ema_rsi_v1 equity runtime and grants PAPER dispatch only to SPY", () => {
    const identities = BOUNDED_US_EQUITY_ASSETS.map((asset) => workerRuntimeIdentityFor(asset, "ema_rsi_v1"));
    assert.equal(new Set(identities.map((identity) => identity.workerKey)).size, 5);
    assert.deepEqual(identities.map((identity) => identity.capability.kind), ["DISPATCH_CAPABLE", "READ_ONLY_DURABLE", "READ_ONLY_DURABLE", "READ_ONLY_DURABLE", "READ_ONLY_DURABLE"]);
    assert.notEqual(deterministicDecisionId(1_726_000_000_000, identities[0]!), deterministicDecisionId(1_726_000_000_000, identities[1]!));
  });

  it("makes deterministic decision, intent, and client-order identities asset-safe", () => {
    const timestamp = 1_726_000_000_000;
    const spyDecision = deterministicDecisionId(timestamp, SPY_RUNTIME_IDENTITY);
    const btcDecision = deterministicDecisionId(timestamp, BTC_USD_RUNTIME_IDENTITY);
    assert.notEqual(spyDecision, btcDecision);
    assert.notEqual(`${spyDecision}:intent`, `${btcDecision}:intent`);
    assert.notEqual(deterministicClientOrderId(spyDecision), deterministicClientOrderId(btcDecision));
  });

  it("isolates SPY and BTC bar/checkpoint namespaces in the durable store contract", async () => {
    const store = new MemoryAlpacaWorkerStore();
    const timestamp = 1_726_000_000_000;
    assert.equal(await store.insertClosedBar(SPY_SPEC.symbol, bar(timestamp)), true);
    assert.equal(await store.insertClosedBar(BTC_USD_SPEC.symbol, bar(timestamp)), true);
    assert.deepEqual(await store.listClosedBars(SPY_SPEC.symbol), [bar(timestamp)]);
    assert.deepEqual(await store.listClosedBars(BTC_USD_SPEC.symbol), [bar(timestamp)]);
    await store.writeCheckpoint(SPY_RUNTIME_IDENTITY.workerKey, { latestRawBarTimestamp: 1 } as never);
    await store.writeCheckpoint(BTC_USD_RUNTIME_IDENTITY.workerKey, { latestRawBarTimestamp: 2 } as never);
    assert.equal((await store.readCheckpoint(SPY_RUNTIME_IDENTITY.workerKey))?.latestRawBarTimestamp, 1);
    assert.equal((await store.readCheckpoint(BTC_USD_RUNTIME_IDENTITY.workerKey))?.latestRawBarTimestamp, 2);
  });

  it("allows BTC durable bar recovery without exposing dispatch authority", async () => {
    const identity = BTC_USD_RUNTIME_IDENTITY;
    assertReadOnlyDurable(identity);
    const store = new MemoryAlpacaWorkerStore();
    const worker = new DurableMarketWorker({ identity, store });
    await worker.start();
    await worker.processClosedBar(bar(1_726_000_020_000));
    assert.equal(worker.snapshot().state, "READY");
    assert.equal(worker.snapshot().runtimeCapability, "READ_ONLY_DURABLE");
    assert.equal(worker.snapshot().workerKey, BTC_USD_RUNTIME_IDENTITY.workerKey);
    assert.equal("dispatch" in worker, false);
    assert.equal("reconcile" in worker, false);
    assert.equal((await store.listClosedBars(BTC_USD_SPEC.symbol)).length, 1);
    assert.equal((await store.listClosedBars(SPY_SPEC.symbol)).length, 0);
    await worker.stop();

    const recovered = new DurableMarketWorker({ identity, store });
    await recovered.start();
    assert.equal(recovered.snapshot().recoveredClosedBarCount, 1);
    await recovered.stop();
  });
});
