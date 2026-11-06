-- Durable queue between the ingestion API and the worker. A 202 from the
-- ingest endpoint means the request's accepted events are a committed row
-- here (docs/ingestion-protocol.md, "Design goals").
--
-- status:
--   pending  waiting for run_at
--   running  claimed by a worker until locked_until (the visibility timeout)
--   dead     exhausted max_attempts; kept for inspection, never retried
-- Completed jobs are deleted.

CREATE TABLE queue_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  lease_id uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX queue_jobs_ready_idx ON queue_jobs (queue, run_at, id) WHERE status = 'pending';
CREATE INDEX queue_jobs_running_idx ON queue_jobs (queue, locked_until) WHERE status = 'running';
