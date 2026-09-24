import { BTC_USD_RUNTIME_IDENTITY } from "./runtime-identity.ts";
import { sanitizeTerminalText, type ObserverQuery } from "./alpaca-observe.ts";
import type { WorkerCheckpoint } from "./alpaca-worker-store.server.ts";

/** Operational only: age measured from provider minute START, valid 24/7. */
export const BTC_MAX_COMPLETED_BAR_AGE_MS = 180_000;
export const BTC_MAX_CHECKPOINT_AGE_MS = 30_000;

type Row = Record<string, unknown> & {
  now_ms: string; owner_run_id: string | null; fencing_token: string | null;
  lease_expires_at: Date | string | null; lease_live: boolean;
  state: string | null; run_id: string | null; halt_reason: string | null;
  checkpoint_json: string | null; updated_at: Date | string | null;
  latest_bar: string | null;
};
const timestamp = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();

export async function loadBtcObserverSnapshot(query: ObserverQuery) {
  const identity = BTC_USD_RUNTIME_IDENTITY;
  // Prefer the lease owner's run over a later rejected contender. One SELECT
  // provides a consistent statement snapshot and database-time freshness.
  const { rows } = await query.query<Row>(`
    select extract(epoch from clock_timestamp()) * 1000 as now_ms,
      l.owner_run_id, l.fencing_token, l.lease_expires_at,
      coalesce(l.lease_expires_at > clock_timestamp(), false) as lease_live,
      r.run_id, r.state, r.halt_reason, c.checkpoint_json, c.updated_at,
      (select max(timestamp_ms) from closed_bars where symbol = $2) as latest_bar
    from (select $1::text as worker_key) k
    left join worker_leases l on l.worker_key = k.worker_key
    left join runtime_checkpoint c on c.worker_key = k.worker_key
    left join lateral (
      select run_id, state, halt_reason from worker_runs where worker_key = k.worker_key
      order by (run_id = l.owner_run_id) desc nulls last, started_at desc, run_id desc limit 1
    ) r on true`, [identity.workerKey, identity.asset.symbol]);
  const row = rows[0];
  if (!row) throw new Error("BTC_OBSERVER_SNAPSHOT_UNAVAILABLE");
  const checkpoint = row.checkpoint_json ? JSON.parse(row.checkpoint_json) as WorkerCheckpoint : null;
  const evidence = checkpoint?.marketEvidence;
  const evidenceMatchesRun = evidence?.runId === row.run_id;
  const stream = evidenceMatchesRun ? evidence?.stream : null;
  const latestBar = row.latest_bar === null ? null : Number(row.latest_bar);
  const now = Number(row.now_ms);
  const lastBarAgeMs = latestBar === null ? null : now - latestBar;
  const updatedAt = timestamp(row.updated_at);
  const checkpointAgeMs = updatedAt === null ? null : now - Date.parse(updatedAt);
  const barFresh = lastBarAgeMs !== null && lastBarAgeMs >= 60_000 && lastBarAgeMs <= BTC_MAX_COMPLETED_BAR_AGE_MS;
  const checkpointFresh = checkpointAgeMs !== null && checkpointAgeMs >= 0 && checkpointAgeMs <= BTC_MAX_CHECKPOINT_AGE_MS;
  const checkpointCaughtUp = latestBar !== null && checkpoint?.latestRawBarTimestamp === latestBar;
  const reasons: string[] = [];
  if (!row.lease_live) reasons.push("LEASE_NOT_LIVE");
  if (!stream?.subscriptionAcknowledged) reasons.push("STREAM_NOT_SUBSCRIBED");
  if (!barFresh) reasons.push("BTC_BAR_STALE_OR_ABSENT");
  if (!checkpointFresh || !evidenceMatchesRun) reasons.push("CHECKPOINT_STALE_OR_WRONG_RUN");
  if (!checkpointCaughtUp) reasons.push("CHECKPOINT_BEHIND_BARS");
  if (evidence?.continuity === "GAP_DETECTED") reasons.push("CONTINUITY_GAP_DETECTED");
  // DEGRADED is an observer projection; durable worker lifecycle is unchanged.
  const health = row.state === "HALTED" || row.state === "STOPPED" ? row.state :
    row.state === "STARTING" && row.lease_live ? "STARTING" :
      row.state === "READY" && reasons.length === 0 ? "READY" : "DEGRADED";
  return {
    symbol: identity.asset.symbol, runtimeCapability: identity.capability.kind,
    capabilityReason: "MARKET_EVIDENCE_ONLY", brokerAuthority: "NONE", workerKey: identity.workerKey,
    health, healthReasons: reasons, durableWorkerState: row.state ?? "ABSENT",
    runId: row.run_id, leaseOwnerRunId: row.owner_run_id, fencingToken: row.fencing_token,
    leaseExpiresAt: timestamp(row.lease_expires_at), leaseLive: row.lease_live,
    cryptoWebSocketState: stream?.state ?? "UNKNOWN", subscriptionAcknowledged: stream?.subscriptionAcknowledged ?? false,
    lastBarTimestamp: latestBar === null ? null : new Date(latestBar).toISOString(), lastBarAgeMs,
    lastCheckpointUpdate: updatedAt, checkpointAgeMs, checkpointCaughtUp,
    lastBarPersistedAt: evidenceMatchesRun ? evidence?.lastBarPersistedAt ?? null : null,
    recoveredBarCount: evidenceMatchesRun ? evidence?.recoveredClosedBarCount ?? null : null,
    recoveryWindowMs: evidence?.recoveryWindowMs ?? null,
    continuity: evidence?.continuity ?? "UNVERIFIED", backfill: "UNSUPPORTED",
    haltReason: row.halt_reason ?? (evidenceMatchesRun ? checkpoint?.haltReason : null) ?? null,
    reconnectGeneration: stream?.generation ?? null, reconnectAttempt: stream?.reconnectAttempt ?? null,
    streamError: stream?.lastError ?? null, barFresh, checkpointFresh,
  };
}
export function renderBtcObserver(snapshot: Awaited<ReturnType<typeof loadBtcObserverSnapshot>>): string {
  return `BTC/USD 24/7 | ${snapshot.health} | ${snapshot.runtimeCapability}\nBROKER AUTHORITY: NONE\n${JSON.stringify(snapshot, (_key, value: unknown) => typeof value === "string" ? sanitizeTerminalText(value) : value, 2)}`;
}
