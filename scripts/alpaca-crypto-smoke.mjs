#!/usr/bin/env node

// Read-only B2 verification. This script opens only Alpaca's crypto market-data
// WebSocket; it does not import the PAPER worker, database, broker, or fetch.
const requestedTimeoutMs = Number(process.env.ALPACA_CRYPTO_SMOKE_TIMEOUT_MS ?? "75000");
const timeoutMs = Number.isFinite(requestedTimeoutMs)
  ? Math.min(120_000, Math.max(1_000, Math.floor(requestedTimeoutMs)))
  : 75_000;
const { loadAlpacaCryptoCredentials, AlpacaCryptoMarketSource } = await import("../src/lib/lightlight/alpaca-crypto.server.ts");

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const config = loadAlpacaCryptoCredentials();
  const source = new AlpacaCryptoMarketSource(config);
  const iterator = source.bars()[Symbol.asyncIterator]();
  const nextBar = iterator.next();
  void nextBar.catch(() => undefined); // Attach before polling startup state.
  const deadline = Date.now() + timeoutMs;

  try {
    while (!source.snapshot().subscriptionAcknowledged && Date.now() < deadline) {
      if (source.snapshot().state === "FAILED") {
        throw new Error(source.snapshot().lastError ?? "Alpaca crypto stream failed before subscription acknowledgement.");
      }
      await pause(100);
    }
    const subscribed = source.snapshot().subscriptionAcknowledged;
    if (!subscribed) throw new Error("Timed out waiting for Alpaca BTC/USD bars subscription acknowledgement.");

    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      nextBar.then((entry) => ({ kind: "bar", entry })),
      pause(remaining).then(() => ({ kind: "timeout" })),
    ]);
    if (result.kind !== "bar" || result.entry.done || !result.entry.value) {
      throw new Error("Timed out waiting for a completed Alpaca BTC/USD minute bar.");
    }
    const bar = result.entry.value;
    console.log(JSON.stringify({
      mode: "ALPACA_CRYPTO_MARKET_DATA_READ_ONLY",
      symbol: "BTC/USD",
      subscriptionAcknowledged: true,
      completedBarObserved: true,
      barTimestamp: new Date(bar.t).toISOString(),
      streamState: source.snapshot().state,
      brokerMutation: false,
    }, null, 2));
  } finally {
    source.close();
    await nextBar.catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  // Never print a URL with credentials, headers, or process environment.
  console.error(error instanceof Error ? error.message : "Alpaca crypto smoke failed.");
  process.exitCode = 1;
}
