#!/usr/bin/env node
import { startAlpacaPaperWorker, stopAlpacaPaperWorker } from "../src/lib/lightlight/alpaca-worker-control.server.ts";

const command = process.argv[2] ?? "start";

if (command !== "start") {
  console.error("usage: npm run alpaca:worker -- start");
  process.exitCode = 2;
} else {
  const snapshot = await startAlpacaPaperWorker();
  console.log(JSON.stringify(snapshot, null, 2));
  if (snapshot.workerState !== "READY") process.exitCode = 1;
  else {
    const stop = async () => {
      const final = await stopAlpacaPaperWorker();
      console.log(JSON.stringify(final, null, 2));
      process.exit(0);
    };
    process.once("SIGINT", () => { void stop(); });
    process.once("SIGTERM", () => { void stop(); });
    await new Promise<void>(() => {});
  }
}
