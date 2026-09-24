#!/usr/bin/env node
import pg from "pg";
import { loadBtcObserverSnapshot, renderBtcObserver } from "../src/lib/lightlight/btc-observe.ts";
import { env } from "../src/lib/env.server.ts";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--once")) {
  console.error("usage: npm run btc:observe -- [--once]");
  process.exitCode = 2;
} else if (!env("DATABASE_URL")) {
  console.error("DATABASE_URL_REQUIRED");
  process.exitCode = 1;
} else {
  const client = new pg.Client({ connectionString: env("DATABASE_URL"), application_name: "lightlight-btc-observe", connectionTimeoutMillis: 10_000, query_timeout: 10_000, statement_timeout: 10_000,
    options: "-c default_transaction_read_only=on" });
  let stopped = false;
  let release: (() => void) | undefined;
  const stop = () => { stopped = true; release?.(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  client.on("error", () => { console.error("BTC_OBSERVER_DATABASE_CONNECTION_FAILED"); process.exitCode = 1; stop(); });
  try {
    await client.connect();
    do {
      await client.query("BEGIN READ ONLY");
      try {
        console.log(renderBtcObserver(await loadBtcObserverSnapshot(client)));
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
      if (args.includes("--once") || stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        release = () => { clearTimeout(timer); resolve(); };
      });
      release = undefined;
    } while (!stopped);
  } catch {
    console.error("BTC_OBSERVER_FAILED: durable database evidence unavailable; worker untouched.");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await client.end().catch(() => undefined);
  }
}
