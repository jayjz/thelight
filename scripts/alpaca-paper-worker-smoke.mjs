#!/usr/bin/env node

// Explicit operator smoke only. Observe-only performs broker reads and one
// market observation. A dispatch is possible only through AlpacaPaperWorker;
// this script never POSTs /v2/orders itself.
const PAPER_BASE_URL = "https://paper-api.alpaca.markets";
const DATA_BASE_URL = "https://data.alpaca.markets";
const { SPY_SPEC, alpacaEquityFeedFor } = await import("../src/lib/lightlight/assets.ts");
const key = process.env.ALPACA_API_KEY_ID?.trim();
const secret = process.env.ALPACA_API_SECRET_KEY?.trim();
const symbol = process.env.ALPACA_SYMBOL?.trim().toUpperCase() || SPY_SPEC.symbol;
const feed = (process.env.ALPACA_DATA_FEED?.trim() || alpacaEquityFeedFor(SPY_SPEC)).toLowerCase();
const dispatch = process.argv.includes("--paper-dispatch");
const observeOnly = process.argv.includes("--observe-only") || !dispatch;

function fail(message) {
  console.error(message);
  process.exitCode = 2;
}

async function observe(headers) {
  const [account, position, orders] = await Promise.all([
    fetch(`${PAPER_BASE_URL}/v2/account`, { headers }),
    fetch(`${PAPER_BASE_URL}/v2/positions/${symbol}`, { headers }),
    fetch(`${PAPER_BASE_URL}/v2/orders?status=open&symbols=${symbol}`, { headers }),
  ]);
  if (!account.ok || !(position.ok || position.status === 404) || !orders.ok) {
    console.error(JSON.stringify({ account: account.status, position: position.status, orders: orders.status }));
    process.exitCode = 3;
    return;
  }
  const accountBody = await account.json();
  const positionBody = position.status === 404 ? { qty: "0" } : await position.json();
  const ordersBody = await orders.json();
  console.log(JSON.stringify({
    mode: "ALPACA_PAPER", workerState: "RECONCILING", symbol, feed, observeOnly: true,
    accountStatus: accountBody.status, equity: accountBody.equity, brokerPosition: positionBody.qty,
    openOrderCount: ordersBody.length, submittedOrder: false,
  }, null, 2));
}

async function historicalRawBars(headers) {
  // Read actual Alpaca market history, never fabricated candles. Seven days is
  // intentionally enough to include at least one complete regular session.
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const url = new URL(`${DATA_BASE_URL}/v2/stocks/${symbol}/bars`);
  url.searchParams.set("timeframe", "1Min");
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("end", end.toISOString());
  url.searchParams.set("feed", feed);
  url.searchParams.set("limit", "10000");
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Historical market read failed: ${response.status}.`);
  const body = await response.json();
  const bars = Array.isArray(body.bars) ? body.bars : [];
  return bars.map((bar) => ({
    t: Date.parse(bar.t), open: Number(bar.o), high: Number(bar.h), low: Number(bar.l), close: Number(bar.c), volume: Number(bar.v),
  })).filter((bar) => Number.isFinite(bar.t) && [bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite));
}

async function dispatchThroughWorker(headers) {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required for durable PAPER dispatch smoke.");
  const [{ AlpacaPaperBroker, loadAlpacaConfig }, { AlpacaPaperWorker, SqlAlpacaWorkerStore }] = await Promise.all([
    import("../src/lib/lightlight/alpaca.server.ts"),
    import("../src/lib/lightlight/alpaca-worker.server.ts"),
  ]);
  const config = loadAlpacaConfig();
  const store = new SqlAlpacaWorkerStore();
  const broker = new AlpacaPaperBroker(config);
  const rawBars = await historicalRawBars(headers);
  if (rawBars.length < 15 * 22) throw new Error("Insufficient actual 1Min history for worker feature warmup.");

  // Preload durable, broker-sourced bars before authority is granted. The
  // worker then performs its own account/position/open-order reconciliation,
  // decision+intent transaction, deterministic identity, and execution path.
  for (const bar of rawBars) await store.insertClosedBar(symbol, bar);
  const latestBucketStart = Math.floor(rawBars.at(-1).t / (15 * 60_000)) * 15 * 60_000;
  const targetTimestamp = latestBucketStart - 15 * 60_000;
  const worker = new AlpacaPaperWorker({
    config,
    store,
    broker,
    // A smoke has one selected, real historical completed bucket. All other
    // evidence remains durable but is cancelled rather than stacking orders.
    isRegularSession: (timestamp) => timestamp === targetTimestamp,
  });
  await worker.start();
  const intent = (await store.listIntents(symbol)).find((row) => row.intent.createdAtTimestamp === targetTimestamp) ?? null;
  const brokerOrder = intent ? await store.latestBrokerOrder(intent.intent.intentId) : null;
  const snapshot = worker.snapshot();
  console.log(JSON.stringify({
    mode: "ALPACA_PAPER",
    decisionId: intent?.intent.decisionId ?? null,
    intentId: intent?.intent.intentId ?? null,
    clientOrderId: intent?.intent.clientOrderId ?? null,
    brokerPositionBefore: snapshot.brokerPosition,
    brokerOrderId: brokerOrder?.brokerOrderId ?? null,
    brokerStatus: brokerOrder?.status ?? intent?.intent.status ?? null,
    dispatchOccurred: ["SUBMISSION_ATTEMPTED", "ACCEPTED", "PARTIALLY_FILLED", "FILLED", "REJECTED", "UNKNOWN"].includes(intent?.intent.status ?? ""),
    persistedState: { intent, brokerOrder },
    workerState: snapshot.workerState,
    haltReason: snapshot.haltReason,
  }, null, 2));
  await worker.stop();
}

if (!key || !secret) fail("Missing ALPACA_API_KEY_ID or ALPACA_API_SECRET_KEY.");
else if (symbol !== SPY_SPEC.symbol) fail("The PAPER worker smoke supports the configured SPY asset only.");
else if ((process.env.ALPACA_PAPER_BASE_URL?.trim() || PAPER_BASE_URL) !== PAPER_BASE_URL) fail("ALPACA_PAPER_BASE_URL must remain https://paper-api.alpaca.markets.");
else if (!["iex", "sip", "delayed_sip"].includes(feed)) fail(`Unsupported Alpaca feed: ${feed}.`);
else if (dispatch && process.env.ALPACA_PAPER_WORKER_SMOKE_DISPATCH !== "YES") fail("Refusing dispatch: ALPACA_PAPER_WORKER_SMOKE_DISPATCH must equal YES.");
else {
  const headers = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };
  try {
    if (observeOnly) await observe(headers);
    else await dispatchThroughWorker(headers);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 4;
  }
}
