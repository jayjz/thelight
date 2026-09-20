import assert from "node:assert/strict";
import test from "node:test";
import {
  getAlpacaPaperWorker,
  readAlpacaPaperWorkerSnapshot,
} from "./alpaca-worker.server.ts";
import { readLightlightRuntimeStatus } from "./runtime.server.ts";

type WorkerGlobal = typeof globalThis & {
  __alpacaPaperWorker__?: Promise<unknown>;
};

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("Vercel cannot initialize the session-owned Alpaca worker", async () => {
  const priorVercel = process.env.VERCEL;
  const runtime = globalThis as WorkerGlobal;
  const priorWorker = runtime.__alpacaPaperWorker__;
  delete runtime.__alpacaPaperWorker__;
  process.env.VERCEL = "1";

  try {
    assert.throws(() => getAlpacaPaperWorker(), /ALPACA_WORKER_FORBIDDEN_ON_VERCEL/);
    assert.equal(await readAlpacaPaperWorkerSnapshot(), null);
    assert.equal(runtime.__alpacaPaperWorker__, undefined);
  } finally {
    restoreEnv("VERCEL", priorVercel);
    if (priorWorker) runtime.__alpacaPaperWorker__ = priorWorker;
    else delete runtime.__alpacaPaperWorker__;
  }
});

test("runtime status is read-only and never creates a worker", async () => {
  const priorMode = process.env.LIGHTLIGHT_MODE;
  const runtime = globalThis as WorkerGlobal;
  const priorWorker = runtime.__alpacaPaperWorker__;
  delete runtime.__alpacaPaperWorker__;
  process.env.LIGHTLIGHT_MODE = "ALPACA_PAPER";

  try {
    const status = await readLightlightRuntimeStatus();
    assert.equal(status.mode, "ALPACA_PAPER");
    assert.equal(status.workerState, "HALTED");
    assert.match(status.error ?? "", /not been explicitly started/i);
    assert.equal(runtime.__alpacaPaperWorker__, undefined);
  } finally {
    restoreEnv("LIGHTLIGHT_MODE", priorMode);
    if (priorWorker) runtime.__alpacaPaperWorker__ = priorWorker;
    else delete runtime.__alpacaPaperWorker__;
  }
});
