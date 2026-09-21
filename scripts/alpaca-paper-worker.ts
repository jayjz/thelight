#!/usr/bin/env node
import {
  startAlpacaPaperWorker,
  stopAlpacaPaperWorker,
} from "../src/lib/lightlight/alpaca-worker-control.server.ts";

const command = process.argv[2] ?? "start";
const requestedArm = process.argv[3] === "--arm" ? process.argv[4] : undefined;
const arm = requestedArm === "ema_rsi_v1" ? "ema_rsi_v1" : requestedArm === undefined ? "ema_trend_arm_c" : null;

if (command !== "start" || arm === null) {
  console.error("usage: npm run alpaca:worker -- start [--arm ema_rsi_v1]");
  process.exitCode = 2;
} else {
  const snapshot = await startAlpacaPaperWorker(arm);
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
          const final = await stopAlpacaPaperWorker(arm);
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
