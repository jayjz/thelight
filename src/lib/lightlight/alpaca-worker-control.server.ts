import { getAlpacaPaperWorker, readAlpacaPaperWorkerSnapshot, type AlpacaWorkerSnapshot } from "./alpaca-worker.server.ts";

/** Explicit server-side operator controls. They are intentionally not exported to React/UI routes. */
export async function startAlpacaPaperWorker(): Promise<AlpacaWorkerSnapshot> {
  const worker = await getAlpacaPaperWorker();
  await worker.start();
  return worker.snapshot();
}

export async function stopAlpacaPaperWorker(): Promise<AlpacaWorkerSnapshot | null> {
  const snapshot = await readAlpacaPaperWorkerSnapshot();
  if (!snapshot) return null;
  const worker = await getAlpacaPaperWorker();
  await worker.stop();
  return worker.snapshot();
}

export function alpacaPaperWorkerStatus(): Promise<AlpacaWorkerSnapshot | null> {
  return readAlpacaPaperWorkerSnapshot();
}

export async function reconcileAlpacaPaperWorker(): Promise<AlpacaWorkerSnapshot> {
  const worker = await getAlpacaPaperWorker();
  await worker.reconcile();
  return worker.snapshot();
}
