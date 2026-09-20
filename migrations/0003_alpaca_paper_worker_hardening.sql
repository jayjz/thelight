-- One immutable decision owns exactly one initial execution intent.  The
-- worker writes both rows in a database transaction; this index protects that
-- cardinality independently of process state.
CREATE UNIQUE INDEX IF NOT EXISTS execution_intents_decision_id_unique
  ON execution_intents (decision_id);
