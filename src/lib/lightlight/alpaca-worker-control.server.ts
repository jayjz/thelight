import { getAlpacaPaperWorker, readAlpacaPaperWorkerSnapshot, type AlpacaWorkerSnapshot } from "./alpaca-worker.server.ts";
import type { PaperWorkerArm } from "./runtime-identity.ts";

/** Explicit server-side operator controls. They are intentionally not exported to React/UI routes. */
export async function startAlpacaPaperWorker(arm: PaperWorkerArm = "ema_trend_arm_c", symbol = "SPY"): Promise<AlpacaWorkerSnapshot> {
  const worker = await getAlpacaPaperWorker(arm, symbol);
  await worker.start();
  return worker.snapshot();
}

export async function stopAlpacaPaperWorker(arm: PaperWorkerArm = "ema_trend_arm_c", symbol = "SPY"): Promise<AlpacaWorkerSnapshot | null> {
  const snapshot = await readAlpacaPaperWorkerSnapshot(arm, symbol);
  if (!snapshot) return null;
  const worker = await getAlpacaPaperWorker(arm, symbol);
  await worker.stop();
  return worker.snapshot();
}

export function alpacaPaperWorkerStatus(arm: PaperWorkerArm = "ema_trend_arm_c"): Promise<AlpacaWorkerSnapshot | null> {
  return readAlpacaPaperWorkerSnapshot(arm);
}

export async function reconcileAlpacaPaperWorker(arm: PaperWorkerArm = "ema_trend_arm_c"): Promise<AlpacaWorkerSnapshot> {
  const worker = await getAlpacaPaperWorker(arm);
  await worker.reconcile();
  return worker.snapshot();
}
