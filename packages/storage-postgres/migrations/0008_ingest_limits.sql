-- Per-project ingestion limits (docs/ingestion-protocol.md, "Rate limits and
-- quotas"; docs/retention.md, "Quotas"). NULL inherits the instance-wide
-- default the API reads from its environment.

ALTER TABLE projects
  ADD COLUMN rate_limit_per_minute integer CHECK (rate_limit_per_minute BETWEEN 100 AND 1000000),
  ADD COLUMN events_per_day bigint CHECK (events_per_day BETWEEN 1 AND 1000000000000);

-- One row per project: events admitted in the current UTC minute and the
-- current UTC day. Every API process reads and updates the same row under a
-- row lock, so limits hold across processes and survive restarts. A row from
-- an earlier minute or day counts as zero and is overwritten on the next
-- request, so nothing needs pruning.
CREATE TABLE project_ingest_usage (
  project_id text PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  minute_start timestamptz NOT NULL,
  minute_events bigint NOT NULL DEFAULT 0 CHECK (minute_events >= 0),
  day date NOT NULL,
  day_events bigint NOT NULL DEFAULT 0 CHECK (day_events >= 0)
);
