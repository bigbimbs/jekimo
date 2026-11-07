-- Project daily counters (docs/retention.md, "What is retained"): events
-- accepted, rejected, dropped, and sampled per project per UTC day. Kept for
-- 13 months.

CREATE TABLE project_daily_counters (
  project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  day date NOT NULL,
  accepted bigint NOT NULL DEFAULT 0 CHECK (accepted >= 0),
  rejected bigint NOT NULL DEFAULT 0 CHECK (rejected >= 0),
  dropped bigint NOT NULL DEFAULT 0 CHECK (dropped >= 0),
  sampled bigint NOT NULL DEFAULT 0 CHECK (sampled >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, day)
);

-- Increments that carried an idempotency key, so a retried caller (a
-- redelivered queue job) does not count twice. Pruned after a few days.
CREATE TABLE project_counter_increments (
  project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  increment_key text NOT NULL CHECK (length(increment_key) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, increment_key)
);

CREATE INDEX project_counter_increments_created_at_idx ON project_counter_increments (created_at);
