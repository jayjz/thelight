-- Durable, server-owned state for the single-symbol Alpaca PAPER worker.
-- Decision evidence is append-only. Execution intent state is a current
-- projection; every broker observation is retained in broker_orders.

CREATE TABLE IF NOT EXISTS worker_runs (
  run_id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  state TEXT NOT NULL,
  halt_reason TEXT
);

CREATE TABLE IF NOT EXISTS closed_bars (
  symbol TEXT NOT NULL,
  timestamp_ms BIGINT NOT NULL,
  bar_json TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (symbol, timestamp_ms)
);

CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  decision_timestamp_ms BIGINT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_intents (
  intent_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES decisions(decision_id),
  client_order_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  dispatch_block_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS broker_orders (
  event_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES execution_intents(intent_id),
  client_order_id TEXT NOT NULL,
  broker_order_id TEXT,
  status TEXT NOT NULL,
  lookup_state TEXT NOT NULL,
  raw_status TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  state_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS broker_positions (
  position_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  quantity DOUBLE PRECISION NOT NULL,
  reconciled_at TIMESTAMPTZ NOT NULL,
  position_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_updates (
  update_id TEXT PRIMARY KEY,
  client_order_id TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  update_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_checkpoint (
  worker_key TEXT PRIMARY KEY,
  checkpoint_json TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
