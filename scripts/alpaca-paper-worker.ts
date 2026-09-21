#!/usr/bin/env node
import {
  startAlpacaPaperWorker,
  stopAlpacaPaperWorker,
} from "../src/lib/lightlight/alpaca-worker-control.server.ts";

const command = process.argv[2] ?? "start";
const args = process.argv.slice(3);
const valueAfter = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const requestedArm = valueAfter("--arm");
const requestedSymbol = valueAfter("--symbol");
const arm = requestedArm === "ema_rsi_v1" ? "ema_rsi_v1" : requestedArm === undefined ? "ema_trend_arm_c" : null;
const symbol = requestedSymbol?.toUpperCase() ?? "SPY";

if (command !== "start" || arm === null) {
  console.error("usage: npm run alpaca:worker -- start [--arm ema_rsi_v1] [--symbol SPY|QQQ|IWM|AAPL|MSFT]");
  process.exitCode = 2;
} else {
  const snapshot = await startAlpacaPaperWorker(arm, symbol);
  console.log(JSON.stringify(snapshot, null, 2));

  if (snapshot.workerState !== "READY") {
    process.exitCode = 1;
  } else {
    let stopping = false;

    await new Promise<void>((resolve) => {
      const stop = async () => {
        if (stopping) return;
        stopping = true;

        try {
          const final = await stopAlpacaPaperWorker(arm, symbol);
          console.log(JSON.stringify(final, null, 2));
        } finally {
          resolve();
        }
      };

      process.once("SIGINT", () => {
        void stop();
      });

      process.once("SIGTERM", () => {
        void stop();
      });
    });
  }
}
