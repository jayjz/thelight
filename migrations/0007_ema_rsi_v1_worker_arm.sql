-- Strategy-arm identity is durable evidence. Legacy 15-minute Arm C evidence
-- keeps its exact established runtime key; the 1-minute ema_rsi_v1 arm gets a
-- separate key, checkpoint, lease, recovery record, and observer projection.
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS worker_key TEXT;

UPDATE decisions
SET worker_key = 'alpaca-paper:SPY:15Min:alpaca-paper-worker-v1'
WHERE worker_key IS NULL;

ALTER TABLE decisions ALTER COLUMN worker_key SET NOT NULL;

CREATE INDEX IF NOT EXISTS decisions_worker_symbol_timestamp_idx
  ON decisions (worker_key, symbol, decision_timestamp_ms DESC, created_at DESC);
