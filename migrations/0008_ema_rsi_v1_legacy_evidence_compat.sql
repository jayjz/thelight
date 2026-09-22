-- Keep the ownership test harness and pre-worker-key evidence import path
-- readable. Production workers always write a concrete worker_key; NULL is
-- accepted only as legacy evidence and is never selected by a scoped worker.
ALTER TABLE decisions ALTER COLUMN worker_key DROP NOT NULL;
ALTER TABLE decisions ALTER COLUMN worker_key DROP DEFAULT;
