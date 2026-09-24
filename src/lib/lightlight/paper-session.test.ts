import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import {
  exportPaperSession,
  dateInterval,
  validateSelection,
  type PaperSession,
  type Selection,
} from "./paper-session-store.ts";
import {
  analyzePaperSession,
  signalParity,
  extractFills,
  roundTrips,
  compareStrategies,
  digest,
  continuousPrefix,
} from "./paper-session.ts";
import type { ObserverQuery } from "./alpaca-observe.ts";
const selection: Selection = {
  workerKey: "alpaca-paper:SPY:1Min:ema-rsi-v1-paper-worker-v1",
  symbol: "SPY",
  strategy: "ema_rsi_v1",
  ...dateInterval("2026-09-22"),
  runId: null,
};
const frozen = (): PaperSession =>
  JSON.parse(
    gunzipSync(
      readFileSync(new URL("./fixtures/paper-sessions/2026-09-22.json.gz", import.meta.url)),
    ).toString(),
  );
test("date boundaries are ET, including DST; selection is bounded", () => {
  assert.equal(new Date(selection.start).toISOString(), "2026-09-22T04:00:00.000Z");
  assert.equal(dateInterval("2026-03-08").end - dateInterval("2026-03-08").start, 23 * 3600000);
  assert.throws(() => validateSelection({ ...selection, end: Infinity }));
  assert.throws(() => validateSelection({ ...selection, workerKey: "btc" }));
});
test("export uses only read-only transaction and bounded selects; run scoped decisions", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db: ObserverQuery = {
    query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [] as T[] };
    },
  };
  await exportPaperSession(db, { ...selection, runId: "chosen-run" });
  assert.equal(calls[0]!.sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(calls.at(-1)!.sql, "COMMIT");
  assert.ok(calls.every((c) => /^(SELECT|SET LOCAL|BEGIN|COMMIT)/.test(c.sql)));
  assert.ok(calls[2]!.sql.includes("decision_timestamp_ms >= $3"));
  assert.ok(calls[2]!.params.includes("chosen-run"));
  const source = readFileSync(new URL("./paper-session-store.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ['"].*(alpaca\.server|worker\.server|db\.ts)/);
});
test("read failure rolls back", async () => {
  const calls: string[] = [];
  await assert.rejects(
    exportPaperSession(
      {
        query: async (sql) => {
          calls.push(sql);
          if (sql.startsWith("SELECT")) throw new Error("fail");
          return { rows: [] };
        },
      },
      selection,
    ),
  );
  assert.equal(calls.at(-1), "ROLLBACK");
});
test("frozen live features and chained targets match; mutations remain visible", () => {
  const s = frozen();
  s.decisions = s.decisions.slice(0, 26);
  assert.ok(signalParity(s).every((p) => p.status === "PASS"));
  const e = JSON.parse(String(s.decisions[25]!.evidence_json));
  e.strategyDecision.features.ema9 += 1;
  e.strategyDecision.proposedTarget = 1;
  s.decisions[25]!.evidence_json = JSON.stringify(e);
  const mismatch = signalParity(s).at(-1)!;
  assert.equal(mismatch.status, "FAIL");
  assert.ok(mismatch.issues.includes("ema9 differs"));
  assert.ok(mismatch.issues.includes("Strategy target differs"));
});
test("late/missing bars fail parity and future bars are not used", () => {
  const s = frozen();
  s.decisions = s.decisions.slice(0, 26);
  const first = signalParity(s);
  const future = s.bars.find(
    (r) => Number(r.timestamp_ms) > Number(s.decisions.at(-1)!.decision_timestamp_ms),
  )!;
  future.bar_json = JSON.stringify({ ...JSON.parse(String(future.bar_json)), close: 9000 });
  assert.deepEqual(signalParity(s), first);
  s.bars[24]!.received_at = "2030-01-01T00:00:00Z";
  assert.ok(signalParity(s).some((p) => p.status === "FAIL"));
});
test("fills deduplicate; exact round trips, no invented closing fill", () => {
  const s = frozen();
  s.updates.push(...structuredClone(s.updates));
  const { fills, unavailable } = extractFills(s);
  assert.equal(fills.length, 36);
  assert.equal(unavailable.length, 0);
  const trips = roundTrips(fills, []);
  assert.equal(trips.length, 18);
  assert.ok(Math.abs(trips.reduce((v, t) => v + t.pnl, 0) + 1.33) < 1e-8);
  assert.equal(roundTrips(fills.slice(0, -1), []).length, 17);
  assert.equal(roundTrips(fills.slice(1), []).length, 17);
  assert.equal(roundTrips(fills.slice(0, 1), []).length, 0);
});
test("same frozen bars and cost-once canonical ledger; deterministic comparison", () => {
  const s = frozen();
  s.decisions = s.decisions.slice(35, 75);
  const r = compareStrategies(s);
  assert.equal(r[0]!.barsHash, r[1]!.barsHash);
  assert.equal(digest(r), digest(compareStrategies(s)));
  for (const arm of r) {
    const gross = arm.scenarios[0]!;
    for (const result of arm.scenarios) {
      assert.equal(
        result.turnover,
        result.ledger.transitions.reduce((s, t) => s + t.turnover, 0),
      );
      assert.ok(
        Math.abs(
          Math.log(1 + result.netReturn) -
            Math.log(1 + gross.netReturn) +
            (result.turnover * (result.cost.transactionCostBps + result.cost.slippageBps)) / 10000,
        ) < 1e-12,
      );
    }
  }
});
test("continuity restarts after missing minute", () => {
  const b = JSON.parse(String(frozen().bars[20]!.bar_json));
  assert.equal(continuousPrefix([b, { ...b, t: b.t + 120000 }], b.t + 120000).length, 1);
});

test("Date hashes equal offline JSON and availability preserves milliseconds", () => {
  const s = frozen();
  s.decisions = s.decisions.slice(0, 26);
  const offlineHash = digest(s);
  for (const b of s.bars) b.received_at = new Date(String(b.received_at));
  assert.equal(digest(s), offlineHash);
  assert.deepEqual(signalParity(s), signalParity(JSON.parse(JSON.stringify(s))));
  const d = JSON.parse(String(s.decisions[25]!.evidence_json));
  const b = s.bars.find((b) => Number(b.timestamp_ms) === d.timestamp)!;
  b.received_at = new Date(d.strategyDecision.decisionTimestamp + 1);
  assert.equal(signalParity(s).at(-1)!.status, "FAIL");
  assert.notEqual(digest(s), offlineHash);
});

test("mid-session export carries both full 23-bar confirmation windows", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db: ObserverQuery = {
    query: async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [] as T[] };
    },
  };
  const start = Date.parse("2026-09-22T16:00:00Z");
  await exportPaperSession(db, { ...selection, start });
  const bars = calls.find((c) => c.sql.includes("FROM closed_bars"))!;
  assert.equal(bars.params[1], start - 23 * 60000);
});

test("complete development fixtures reproduce targets and exact observed transitions", () => {
  for (const [day, decisions, transitions, trips] of [
    ["22", 390, 36, 18],
    ["23", 365, 28, 14],
  ] as const) {
    const session: PaperSession = JSON.parse(
      gunzipSync(
        readFileSync(new URL(`./fixtures/paper-sessions/2026-09-${day}.json.gz`, import.meta.url)),
      ).toString(),
    );
    const result = analyzePaperSession(session);
    assert.equal(result.parity.status, "PASS");
    assert.equal(result.parity.count, decisions);
    assert.equal(result.paper.observedTransitions.length, transitions);
    assert.equal(result.paper.roundTrips.length, trips);
    assert.ok(result.paper.observedTransitions.every((t) => t.before !== t.after));
    assert.equal(result.manifest.evidenceHash, digest(session));
  }
});

test("partial fills preserve nanoseconds and true ties use position evidence", () => {
  const s = frozen();
  const first = s.updates.find((r) => JSON.parse(String(r.update_json)).data.event === "fill")!;
  const make = (id: string, timestamp: string, side: string, quantity: number, after: number) => {
    const row = structuredClone(first);
    const d = JSON.parse(String(row.update_json));
    Object.assign(d.data, {
      execution_id: id,
      event: "partial_fill",
      timestamp,
      qty: String(quantity),
      position_qty: String(after),
      price: "100",
    });
    d.data.order.side = side;
    row.update_json = JSON.stringify(d);
    return row;
  };
  s.orders = [];
  for (const tied of [false, true]) {
    s.updates = [
      make("a", "2026-09-22T14:13:02.123456900Z", "buy", 1, 2),
      make(
        "z",
        tied ? "2026-09-22T14:13:02.123456900Z" : "2026-09-22T14:13:02.123456100Z",
        "buy",
        1,
        1,
      ),
      make("x", "2026-09-22T14:14:02.123456900Z", "sell", 2, 0),
    ];
    const { fills } = extractFills(s);
    assert.deepEqual(
      fills.map((f) => f.id),
      ["z", "a", "x"],
    );
    assert.equal(roundTrips(fills, []).length, 1);
  }
  s.updates = [
    make("a", "2026-09-22T14:13:02Z", "buy", 1, 1),
    make("z", "2026-09-22T14:13:02Z", "buy", 2, 2),
  ];
  assert.throws(() => extractFills(s), /Ambiguous simultaneous/);
});
