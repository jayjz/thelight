import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALPACA_DATA_BASE_URL,
  ALPACA_PAPER_BASE_URL,
  AlpacaPaperExecution,
  brokerStateFromTradeUpdate,
  closedBarFromAlpaca,
  loadAlpacaConfig,
} from "./alpaca.server.ts";
import type { ExecutionIntent } from "./types.ts";

const reconciledFlatPosition = {
  symbol: "SPY",
  quantity: 0,
  reconciledAt: "2026-09-19T00:00:00.000Z",
  provenance: "ALPACA_RECONCILED" as const,
};

const env = {
  ALPACA_API_KEY_ID: "key",
  ALPACA_API_SECRET_KEY: "secret",
  ALPACA_SYMBOL: "SPY",
} as NodeJS.ProcessEnv;

const intent: ExecutionIntent = {
  intentId: "LL-SPY-0001:intent",
  decisionId: "LL-SPY-0001",
  createdAtBar: 1,
  createdAtTimestamp: 1,
  desiredAction: "LONG",
  desiredPosition: 1,
  status: "PENDING",
  executionModel: "ALPACA_PAPER",
};

describe("Alpaca paper boundaries", () => {
  it("requires credentials and fixes paper/data domains", () => {
    assert.throws(() => loadAlpacaConfig({}), /Missing ALPACA_API_KEY_ID/);
    const config = loadAlpacaConfig(env);
    assert.equal(config.paperBaseUrl, ALPACA_PAPER_BASE_URL);
    assert.equal(config.dataBaseUrl, ALPACA_DATA_BASE_URL);
    assert.throws(() => loadAlpacaConfig({ ...env, ALPACA_PAPER_BASE_URL: "https://example.invalid" }), /fixed Alpaca paper domain/);
    assert.throws(() => loadAlpacaConfig({ ...env, ALPACA_PAPER_BASE_URL: "https://api.alpaca.markets" }), /fixed Alpaca paper domain/);
  });

  it("accepts only a completed 1Min market-data bar", () => {
    const message = { T: "b" as const, S: "SPY", o: 1, h: 2, l: 0.5, c: 1.5, v: 10, t: "2026-01-01T00:00:00Z" };
    assert.equal(closedBarFromAlpaca(message, Date.parse("2026-01-01T00:00:30Z")), null);
    assert.equal(closedBarFromAlpaca(message, Date.parse("2026-01-01T00:01:00Z"))?.close, 1.5);
  });

  it("reconciles before submitting and posts only to the fixed paper orders endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (String(url).includes("by_client_order_id")) return new Response("", { status: 404 });
      return Response.json({ id: "broker-1", status: "accepted", client_order_id: intent.intentId });
    };
    const execution = new AlpacaPaperExecution(loadAlpacaConfig(env), request as typeof fetch);
    const state = await execution.submit(intent, reconciledFlatPosition);
    assert.equal(state.status, "ACCEPTED");
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.url, `${ALPACA_PAPER_BASE_URL}/v2/orders`);
    assert.equal(calls[1]!.init?.method, "POST");
    assert.match(String(calls[1]!.init?.body), /client_order_id/);
  });

  it("halts normal dispatch after an unknown POST even when later lookup remains absent", async () => {
    let lookups = 0;
    let posts = 0;
    const request = async (url: string | URL | Request): Promise<Response> => {
      if (String(url).includes("by_client_order_id")) {
        lookups += 1;
        return new Response("", { status: 404 });
      }
      posts += 1;
      throw new Error("transport result lost after broker may have accepted order");
    };
    const execution = new AlpacaPaperExecution(loadAlpacaConfig(env), request as typeof fetch);
    const first = await execution.submit(intent, reconciledFlatPosition);
    assert.equal(first.status, "UNKNOWN");
    assert.equal(first.lookup, "UNRESOLVED");
    assert.equal(posts, 1);

    const unknownIntent = { ...intent, status: first.status };
    const absent = await execution.reconcile(unknownIntent);
    assert.equal(absent.lookup, "ABSENT");
    assert.equal(absent.status, "UNKNOWN");

    const normalDispatch = await execution.submit(unknownIntent, reconciledFlatPosition);
    assert.equal(normalDispatch.lookup, "ABSENT");
    assert.equal(normalDispatch.status, "UNKNOWN");
    assert.equal(posts, 1, "normal dispatch must not issue a second POST after UNKNOWN");
    assert.equal(lookups, 3);
  });

  it("calculates order quantity from the reconciled broker position, not caller-local state", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      if (String(url).includes("by_client_order_id")) return new Response("", { status: 404 });
      return Response.json({ id: "broker-2", status: "accepted", client_order_id: intent.intentId });
    };
    const execution = new AlpacaPaperExecution(loadAlpacaConfig(env), request as typeof fetch);
    const state = await execution.submit(intent, { ...reconciledFlatPosition, quantity: -1 });
    assert.equal(state.status, "ACCEPTED");
    const body = JSON.parse(String(calls[1]!.init?.body)) as { qty: string; side: string };
    assert.equal(body.qty, "2");
    assert.equal(body.side, "buy");
  });

  it("models trade updates separately and references the originating intent", () => {
    const state = brokerStateFromTradeUpdate(
      { stream: "trade_updates", data: { event: "fill", order: { id: "broker-2", status: "filled", client_order_id: intent.intentId } } },
      intent,
    );
    assert.equal(state?.decisionId, intent.decisionId);
    assert.equal(state?.status, "FILLED");
  });
});
