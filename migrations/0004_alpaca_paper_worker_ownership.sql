-- Durable, fenced dispatch ownership for the single Alpaca PAPER worker.
-- A worker holds authority only while worker_leases identifies its run and
-- fencing token and the lease remains unexpired according to PostgreSQL time.

ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS worker_key TEXT;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS fencing_token BIGINT;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS superseded_by_run_id TEXT;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
ALTER TABLE worker_runs ADD COLUMN IF NOT EXISTS supersede_reason TEXT;

CREATE TABLE IF NOT EXISTS worker_leases (
  worker_key TEXT PRIMARY KEY,
  owner_run_id TEXT NOT NULL REFERENCES worker_runs(run_id),
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  renewed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS worker_runs_active_worker_key_idx
  ON worker_runs (worker_key)
  WHERE stopped_at IS NULL AND state NOT IN ('STOPPED', 'HALTED', 'SUPERSEDED');

COMMENT ON TABLE worker_leases IS
  'One durable dispatch lease per worker key. A lease is authoritative only for its exact owner_run_id, fencing_token, and unexpired PostgreSQL-time expiry.';
