/** Read-only projection of existing evidence; never imports worker/broker code. */
import type { ObserverQuery } from "./alpaca-observe.ts";
import { SPY_EMA_RSI_V1_RUNTIME_IDENTITY } from "./runtime-identity.ts";
export type Selection = {
  workerKey: string;
  symbol: "SPY";
  strategy: "ema_rsi_v1";
  start: number;
  end: number;
  runId: string | null;
};
export type Row = Record<string, unknown>;
export type PaperSession = {
  schemaVersion: "paper-session-v1";
  selection: Selection;
  decisions: Row[];
  bars: Row[];
  intents: Row[];
  orders: Row[];
  positions: Row[];
  updates: Row[];
  runs: Row[];
  recoveries: Row[];
};
export function validateSelection(s: Selection): void {
  if (
    s.symbol !== "SPY" ||
    s.strategy !== "ema_rsi_v1" ||
    s.workerKey !== SPY_EMA_RSI_V1_RUNTIME_IDENTITY.workerKey
  )
    throw new Error("Only the SPY ema_rsi_v1 worker is supported");
  if (
    !Number.isFinite(s.start) ||
    !Number.isFinite(s.end) ||
    s.end <= s.start ||
    s.end - s.start > 7 * 86400000
  )
    throw new Error("Require a bounded interval of at most seven days");
}
export function dateInterval(date: string): { start: number; end: number } {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date
  )
    throw new Error("Invalid date");
  const midnight = (day: string) => {
    const utc = Date.parse(`${day}T00:00:00Z`);
    const offset = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      timeZoneName: "longOffset",
      hour: "2-digit",
    })
      .formatToParts(new Date(utc + 4 * 3600000))
      .find((p) => p.type === "timeZoneName")!.value;
    return Date.parse(`${day}T00:00:00${offset.replace("GMT", "")}`);
  };
  return {
    start: midnight(date),
    end: midnight(new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)),
  };
}
export async function exportPaperSession(
  db: ObserverQuery,
  selection: Selection,
): Promise<PaperSession> {
  validateSelection(selection);
  const { workerKey, symbol, start, end, runId } = selection;
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout = 30000");
    const read = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rows;
    const decisions = await read(
      `SELECT * FROM decisions WHERE worker_key=$1 AND symbol=$2 AND decision_timestamp_ms >= $3 AND decision_timestamp_ms < $4 AND evidence_json::jsonb->>'strategyId'='ema_rsi_v1' AND ($5::text IS NULL OR evidence_json::jsonb #>> '{strategyDecision,runtime,runId}'=$5) ORDER BY decision_timestamp_ms,decision_id`,
      [workerKey, symbol, start, end, runId],
    );
    const ids = decisions.map((r) => r.decision_id);
    const intents = await read(
      "SELECT * FROM execution_intents WHERE decision_id=ANY($1::text[]) ORDER BY intent_id",
      [ids],
    );
    const intentIds = intents.map((r) => r.intent_id),
      clientIds = intents.map((r) => r.client_order_id);
    const result: PaperSession = {
      schemaVersion: "paper-session-v1",
      selection,
      decisions,
      intents,
      bars: await read(
        "SELECT * FROM closed_bars WHERE symbol=$1 AND timestamp_ms >= $2 AND timestamp_ms < $3 ORDER BY timestamp_ms",
        [symbol, start - 23 * 60000, end],
      ),
      orders: await read(
        "SELECT * FROM broker_orders WHERE intent_id=ANY($1::text[]) AND observed_at >= $2 AND observed_at < $3 ORDER BY observed_at,event_id",
        [intentIds, new Date(start).toISOString(), new Date(end).toISOString()],
      ),
      positions: await read(
        "SELECT * FROM broker_positions WHERE symbol=$1 AND reconciled_at >= $2 AND reconciled_at < $3 ORDER BY reconciled_at,position_id",
        [symbol, new Date(start).toISOString(), new Date(end).toISOString()],
      ),
      updates: await read(
        "SELECT * FROM trade_updates WHERE client_order_id=ANY($1::text[]) AND received_at >= $2 AND received_at < $3 ORDER BY received_at,update_id",
        [clientIds, new Date(start).toISOString(), new Date(end).toISOString()],
      ),
      runs: await read(
        "SELECT * FROM worker_runs WHERE worker_key=$1 AND started_at < $2 AND (stopped_at IS NULL OR stopped_at >= $3) AND ($4::text IS NULL OR run_id=$4) ORDER BY started_at,run_id",
        [workerKey, new Date(end).toISOString(), new Date(start).toISOString(), runId],
      ),
      recoveries: await read(
        "SELECT * FROM market_gap_recovery_attempts WHERE worker_key=$1 AND detected_at >= $2 AND detected_at < $3 ORDER BY detected_at,recovery_attempt_id",
        [workerKey, new Date(start).toISOString(), new Date(end).toISOString()],
      ),
    };
    await db.query("COMMIT");
    return JSON.parse(JSON.stringify(result)) as PaperSession; // Normalize pg Date values to lossless ISO timestamps.
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
