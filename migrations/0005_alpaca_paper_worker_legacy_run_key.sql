-- 0002 created worker_runs for this one fixed PAPER worker before worker_key
-- existed. Backfill only that known legacy population so a new owner can
-- truthfully supersede an abandoned pre-lease run.
UPDATE worker_runs
SET worker_key = 'alpaca-paper:SPY:15Min:alpaca-paper-worker-v1'
WHERE worker_key IS NULL;
