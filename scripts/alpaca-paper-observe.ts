#!/usr/bin/env node
/**
 * Native, read-only terminal observer for durable Alpaca PAPER evidence.
 * It deliberately does not load worker, broker, or Alpaca credential code.
 */
import pg from "pg";
import {
  DEFAULT_ALPACA_PAPER_WORKER_KEY,
  EMA_RSI_V1_ALPACA_PAPER_WORKER_KEY,
  DEFAULT_OBSERVER_SYMBOL,
  observerWorkerKeyFor,
  ObserverChangeDetector,
  formatEt,
  loadObserverSnapshot,
  renderCurrentState,
  renderEvent,
  sanitizeTerminalText,
  type ObserverQuery,
} from "../src/lib/lightlight/alpaca-observe.ts";

type Options = { once: boolean; intervalMs: number; verbose: boolean; workerKey: string; symbol: string; all: boolean };

function usage(): string {
  return [
    "usage: npm run alpaca:observe [-- --once] [--interval seconds] [--verbose] [--arm ema_rsi_v1] [--symbol SPY] [--all]",
    "",
    "Reads durable PAPER evidence only. It does not need Alpaca credentials.",
  ].join("\n");
}

function parseOptions(args: string[]): Options | null {
  let once = false;
  let verbose = false;
  let workerKey = DEFAULT_ALPACA_PAPER_WORKER_KEY;
  let symbol = DEFAULT_OBSERVER_SYMBOL;
  let arm: "ema_trend_arm_c" | "ema_rsi_v1" = "ema_trend_arm_c";
  let all = false;
  let intervalMs = 1_500;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--once") once = true;
    else if (arg === "--verbose") verbose = true;
    else if (arg === "--arm" && args[index + 1] === "ema_rsi_v1") {
      workerKey = EMA_RSI_V1_ALPACA_PAPER_WORKER_KEY;
      arm = "ema_rsi_v1";
      index += 1;
    } else if (arg === "--symbol") {
      const requested = args[index + 1]?.toUpperCase();
      if (!requested) return null;
      try { workerKey = observerWorkerKeyFor(requested, arm); symbol = requested; } catch { return null; }
      index += 1;
    } else if (arg === "--all" && arm === "ema_rsi_v1") all = true;
    else if (arg === "--interval") {
      const seconds = Number(args[index + 1]);
      if (!Number.isFinite(seconds) || seconds < 0.5 || seconds > 60) return null;
      intervalMs = Math.round(seconds * 1_000);
      index += 1;
    } else if (arg === "--help" || arg === "-h") return null;
    else return null;
  }
  return { once, intervalMs, verbose, workerKey, symbol, all };
}

async function snapshotInReadOnlyTransaction(client: InstanceType<typeof pg.Client>, workerKey: string, symbol = DEFAULT_OBSERVER_SYMBOL) {
  await client.query("BEGIN READ ONLY");
  let committed = false;
  try {
    const query: ObserverQuery = {
      query: async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => {
        const result = await client.query(text, values);
        return { rows: result.rows as T[] };
      },
    };
    const snapshot = await loadObserverSnapshot(query, workerKey, symbol);
    await client.query("COMMIT");
    committed = true;
    return snapshot;
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
  }
}

function waitForInterval(milliseconds: number, onStop: (stop: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    onStop(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("alpaca observer requires DATABASE_URL; no worker state was changed.");
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString: databaseUrl, application_name: "lightlight-alpaca-observe" });
  const detector = new ObserverChangeDetector();
  let stopping = false;
  let releaseWait: (() => void) | null = null;
  const requestStop = () => {
    stopping = true;
    releaseWait?.();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  try {
    await client.connect();
    if (options.all) {
      const symbols = ["SPY", "QQQ", "IWM", "AAPL", "MSFT"];
      const snapshots = [];
      for (const candidate of symbols) snapshots.push(await snapshotInReadOnlyTransaction(client, observerWorkerKeyFor(candidate, "ema_rsi_v1"), candidate));
      console.log("SYMBOL  STATE       BAR       TARGET   EMA9     EMA21    RSI     AUTHORITY");
      for (const item of snapshots) {
        const decision = item.decisions[0];
        const state = item.checkpoint?.recoveryState === "HEALTHY" ? "healthy" : item.checkpoint?.recoveryState ?? "unknown";
        const bar = item.latestRawBarTimestamp ? formatEt(item.latestRawBarTimestamp, false) : "--";
        console.log(`${item.symbol.padEnd(7)} ${state.padEnd(11)} ${bar.padEnd(9)} ${String(decision?.action ?? "--").padEnd(8)} ${String(decision?.ema9 ?? "--").padEnd(8)} ${String(decision?.ema21 ?? "--").padEnd(8)} ${String(decision?.rsi14 ?? "--").padEnd(7)} ${item.symbol === "SPY" ? "PAPER" : "READ_ONLY"}`);
      }
      return;
    }
    let snapshot = await snapshotInReadOnlyTransaction(client, options.workerKey, options.symbol);
    detector.observe(snapshot); // Show current durable state, not a synthetic replay.
    console.log(renderCurrentState(snapshot, { verbose: options.verbose }));
    if (options.once) return;

    let lastHeaderAt = Date.now();
    while (!stopping) {
      await waitForInterval(options.intervalMs, (release) => { releaseWait = release; });
      releaseWait = null;
      if (stopping) break;
      snapshot = await snapshotInReadOnlyTransaction(client, options.workerKey, options.symbol);
      for (const event of detector.observe(snapshot)) console.log(renderEvent(event));
      if (Date.now() - lastHeaderAt >= 10_000) {
        console.log(`\n${renderCurrentState(snapshot, { verbose: options.verbose })}`);
        lastHeaderAt = Date.now();
      }
    }
    console.log(`${formatEt(new Date().toISOString(), true)} observer stopped (worker untouched)`);
  } catch (error) {
    const message = error instanceof Error ? sanitizeTerminalText(error.message) : "unknown database error";
    console.error(`alpaca observer failed: ${message || "database access unavailable"}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

await main();
