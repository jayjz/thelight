#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AlpacaCryptoHistoricalBarsClient } from "../src/lib/lightlight/alpaca-crypto-historical.server.ts";
import { loadAlpacaCryptoCredentials } from "../src/lib/lightlight/alpaca-crypto.server.ts";
import { SqlAlpacaWorkerStore } from "../src/lib/lightlight/alpaca-worker-store.server.ts";
import { assertConsecutiveBtcBars, compactBtcResearchResult, runBtcShortHorizonResearch, type BtcResearchResult } from "../src/lib/lightlight/btc-research.ts";
import { BTC_USD_RUNTIME_IDENTITY } from "../src/lib/lightlight/runtime-identity.ts";
import type { ClosedBar } from "../src/lib/lightlight/types.ts";

const DAY_MS = 24 * 60 * 60_000;
const MAX_HISTORICAL_RESEARCH_MS = 7 * DAY_MS;
type Args = { source: "durable" | "historical"; from: number | null; through: number | null; output: string | null };

function parseTimestamp(value: string | undefined, name: string): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp % 60_000 !== 0) throw new Error(`${name}_MUST_BE_AN_RFC3339_MINUTE`);
  return timestamp;
}
function parseArgs(argv: string[]): Args {
  const get = (name: string) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
  const source = get("--source") ?? "durable";
  if (source !== "durable" && source !== "historical") throw new Error("SOURCE_MUST_BE_DURABLE_OR_HISTORICAL");
  return { source, from: parseTimestamp(get("--from"), "FROM"), through: parseTimestamp(get("--through"), "THROUGH"), output: get("--output") ?? null };
}

/** Reads only the continuity-certified suffix. It does not mutate the checkpoint or bars. */
export async function readVerifiedDurableBtcBars(args: Pick<Args, "from" | "through">): Promise<ClosedBar[]> {
  const store = new SqlAlpacaWorkerStore();
  const checkpoint = await store.readCheckpoint(BTC_USD_RUNTIME_IDENTITY.workerKey);
  const evidence = checkpoint?.marketEvidence;
  if (evidence?.continuity !== "VERIFIED" || !Number.isSafeInteger(evidence.verifiedStartMs) || !Number.isSafeInteger(evidence.verifiedThroughMs)) {
    throw new Error("BTC_DURABLE_RESEARCH_REQUIRES_VERIFIED_CONTINUITY");
  }
  const from = Math.max(args.from ?? evidence.verifiedStartMs, evidence.verifiedStartMs);
  const through = Math.min(args.through ?? evidence.verifiedThroughMs, evidence.verifiedThroughMs);
  if (from > through) throw new Error("BTC_DURABLE_RESEARCH_RANGE_OUTSIDE_VERIFIED_CONTINUITY");
  const bars = await store.listClosedBars("BTC/USD", from, through);
  assertConsecutiveBtcBars(bars);
  return bars;
}

/** Explicit, bounded GET-only fallback. It writes neither bars nor runtime evidence. */
export async function readHistoricalBtcBars(args: Required<Pick<Args, "from" | "through">>): Promise<ClosedBar[]> {
  if (args.from > args.through || args.through - args.from + 60_000 > MAX_HISTORICAL_RESEARCH_MS) throw new Error("BTC_HISTORICAL_RESEARCH_RANGE_MUST_BE_POSITIVE_AND_AT_MOST_7_DAYS");
  const client = new AlpacaCryptoHistoricalBarsClient(loadAlpacaCryptoCredentials());
  const bars: ClosedBar[] = [];
  for (let startMs = args.from; startMs <= args.through; startMs += DAY_MS) {
    const endMs = Math.min(args.through, startMs + DAY_MS - 60_000);
    bars.push(...await client.fetchCompletedBars({ symbol: "BTC/USD", startMs, endMs }));
  }
  assertConsecutiveBtcBars(bars);
  return bars;
}
function report(result: BtcResearchResult): Record<string, unknown> {
  const combined = result.strategies.btc_momentum_v1.find((run) => run.costScenario.id === "combined")!;
  const development = result.partitionResults.development.btc_momentum_v1.find((run) => run.costScenario.id === "combined")!;
  const validation = result.partitionResults.validation?.btc_momentum_v1.find((run) => run.costScenario.id === "combined") ?? null;
  return {
    experimentId: result.experimentId, source: result.data.source,
    period: { start: new Date(result.data.startMs).toISOString(), end: new Date(result.data.endMs).toISOString(), bars: result.data.barCount },
    candidateCombined: combined.metrics,
    chronologicalPartitions: { developmentCombined: development.metrics, validationCombined: validation?.metrics ?? null },
    interpretation: combined.metrics.netPnl > 0 && (combined.metrics.profitFactor ?? 0) > 1
      ? "Positive under the frozen combined-cost scenario; still insufficient for PAPER activation without broader chronological evidence and execution-parity work."
      : "Failed under the frozen combined-cost scenario; high activity is not useful frequency and does not support PAPER activation.",
  };
}
const args = parseArgs(process.argv.slice(2));
if (args.source === "historical" && (args.from === null || args.through === null)) throw new Error("HISTORICAL_SOURCE_REQUIRES_FROM_AND_THROUGH");
const bars = args.source === "durable" ? await readVerifiedDurableBtcBars(args) : await readHistoricalBtcBars({ from: args.from!, through: args.through! });
const result = runBtcShortHorizonResearch(bars, args.source === "durable" ? "DURABLE_VERIFIED" : "HISTORICAL_READ_ONLY");
const json = `${JSON.stringify(compactBtcResearchResult(result), null, 2)}\n`;
if (args.output) { mkdirSync(dirname(args.output), { recursive: true }); writeFileSync(args.output, json, "utf8"); }
console.log(JSON.stringify(report(result), null, 2));
