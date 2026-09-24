#!/usr/bin/env node
// MANUAL ONLY: fixed small completed interval, market-data GETs, no database.
import { AlpacaCryptoHistoricalBarsClient } from "../src/lib/lightlight/alpaca-crypto-historical.server.ts";
import { loadAlpacaCryptoCredentials } from "../src/lib/lightlight/alpaca-crypto.server.ts";

const endMs = Math.floor(Date.now() / 60_000) * 60_000 - 120_000;
try {
  const bars = await new AlpacaCryptoHistoricalBarsClient(loadAlpacaCryptoCredentials()).fetchCompletedBars({ symbol: "BTC/USD", startMs: endMs - 120_000, endMs });
  console.log(JSON.stringify({ count: bars.length, timestamps: bars.map(bar => new Date(bar.t).toISOString()) }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "HISTORICAL_SMOKE_FAILED");
  process.exitCode = 1;
}
