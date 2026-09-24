#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import pg from "pg";
import {
  exportPaperSession,
  dateInterval,
  type PaperSession,
  type Selection,
} from "../src/lib/lightlight/paper-session-store.ts";
import { analyzePaperSession, digest } from "../src/lib/lightlight/paper-session.ts";
import { SPY_EMA_RSI_V1_RUNTIME_IDENTITY } from "../src/lib/lightlight/runtime-identity.ts";
const args = process.argv.slice(2),
  opts: Record<string, string> = {};
const allowed = [
  "strategy",
  "symbol",
  "date",
  "start",
  "end",
  "worker-key",
  "run-id",
  "input",
  "output",
  "export",
  "database-env-file",
];
try {
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, "");
    if (!name || !allowed.includes(name) || !args[i + 1] || opts[name])
      throw new Error("Expected unique --option value pairs");
    opts[name] = args[i + 1]!;
  }
  let session: PaperSession;
  if (opts.input) {
    if (
      [
        "date",
        "start",
        "end",
        "worker-key",
        "run-id",
        "database-env-file",
        "symbol",
        "strategy",
      ].some((k) => opts[k])
    )
      throw new Error("--input cannot be combined with database selection options");
    const input = readFileSync(opts.input);
    session = JSON.parse(
      (opts.input.endsWith(".gz") ? gunzipSync(input) : input).toString(),
    ) as PaperSession;
  } else {
    if (opts.date && (opts.start || opts.end)) throw new Error("Use date OR explicit interval");
    const selection: Selection = {
      workerKey: opts["worker-key"] ?? SPY_EMA_RSI_V1_RUNTIME_IDENTITY.workerKey,
      symbol: (opts.symbol ?? "SPY") as "SPY",
      strategy: (opts.strategy ?? "ema_rsi_v1") as "ema_rsi_v1",
      ...(opts.date
        ? dateInterval(opts.date)
        : { start: Date.parse(opts.start ?? ""), end: Date.parse(opts.end ?? "") }),
      runId: opts["run-id"] ?? null,
    };
    // Read DATABASE_URL only. Never load any Alpaca credentials into process.env.
    const databaseUrl =
      process.env.DATABASE_URL ??
      (opts["database-env-file"]
        ? parseEnv(readFileSync(opts["database-env-file"], "utf8")).DATABASE_URL
        : undefined);
    if (!databaseUrl)
      throw new Error(
        "DATABASE_URL required, or supply --database-env-file; offline --input needs no database",
      );
    const client = new pg.Client({
      connectionString: databaseUrl,
      options: "-c default_transaction_read_only=on",
      application_name: "lightlight-paper-research-readonly",
      connectionTimeoutMillis: 10000,
    });
    try {
      await client.connect();
      session = await exportPaperSession(client, selection);
    } finally {
      await client.end();
    }
  }
  const report = analyzePaperSession(session);
  const code = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
    sourceHash: digest(
      [
        "src/lib/lightlight/paper-session.ts",
        "src/lib/lightlight/paper-session-store.ts",
        "src/lib/lightlight/ema-rsi-v1.ts",
        "src/lib/lightlight/ema-rsi-v2.ts",
        "src/lib/lightlight/features.ts",
        "src/lib/lightlight/policy.ts",
        "src/lib/lightlight/thresholds.ts",
        "src/lib/lightlight/execution.ts",
        "src/lib/lightlight/assets.ts",
        "src/lib/lightlight/runtime-identity.ts",
        "scripts/research-paper-session.ts",
        "docs/experiments/EMA_RSI_V2.md",
      ].map((p) => ({ path: p, source: readFileSync(p, "utf8") })),
    ),
  };
  if (opts.export)
    writeFileSync(opts.export, JSON.stringify(session, null, 2) + "\n", { flag: "wx" });
  const output = JSON.stringify({ ...report, analysisCode: code }, null, 2) + "\n";
  if (opts.output) writeFileSync(opts.output, output, { flag: "wx" });
  else process.stdout.write(output);
  if (report.parity.status === "FAIL") process.exitCode = 2;
} catch (e) {
  console.error(`PAPER research failed: ${e instanceof Error ? e.message : "unknown error"}`);
  process.exitCode = 1;
}
