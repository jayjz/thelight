-- Append-only provenance for every market-data acquisition used by the PAPER
-- worker. closed_bars remains the canonical, conflict-protected bar series.
CREATE TABLE IF NOT EXISTS market_bar_observations (
  observation_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  timestamp_ms BIGINT NOT NULL,
  provider_event_timestamp_ms BIGINT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('LIVE_WS', 'REST_BACKFILL')),
  recovery_attempt_id TEXT NOT NULL DEFAULT '',
  verification_result TEXT NOT NULL CHECK (verification_result IN ('ACCEPTED', 'IDENTICAL', 'CONFLICT')),
  bar_json TEXT NOT NULL,
  UNIQUE (symbol, timestamp_ms, origin, recovery_attempt_id)
);

CREATE TABLE IF NOT EXISTS market_gap_recovery_attempts (
  recovery_attempt_id TEXT PRIMARY KEY,
  worker_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  missing_start_ms BIGINT NOT NULL,
  missing_end_ms BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('GAP_DETECTED', 'BACKFILLING', 'VERIFYING', 'HEALTHY', 'REBUILDING')),
  detected_at TIMESTAMPTZ NOT NULL,
  requested_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  returned_bar_count INTEGER NOT NULL DEFAULT 0,
  verified_bar_count INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  reason TEXT,
  CHECK (missing_start_ms < missing_end_ms),
  CHECK (missing_start_ms % 60000 = 0 AND missing_end_ms % 60000 = 0)
);

CREATE INDEX IF NOT EXISTS market_gap_recovery_attempts_worker_detected_idx
  ON market_gap_recovery_attempts (worker_key, detected_at DESC);
