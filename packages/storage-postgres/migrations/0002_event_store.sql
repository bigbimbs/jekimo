-- Event store: the envelope plus server metadata, flat, append-only, and
-- partitioned by UTC day of received_at. See docs/retention.md ("Expiry
-- mechanics") and docs/architecture.md ("How the event tables must be built").
--
-- Daily partitions are created ahead of time by ensure_event_partition();
-- there is deliberately no default partition, so a missing day fails loudly
-- instead of collecting rows that would block creating the day later.

CREATE TABLE events (
  project_id text NOT NULL,
  event_id text NOT NULL,
  received_at timestamptz NOT NULL,
  key_id text NOT NULL,
  skew_ms bigint,
  schema_version smallint NOT NULL,
  "timestamp" text NOT NULL,
  kind text NOT NULL,
  severity text NOT NULL,
  message text NOT NULL,
  service text,
  environment text,
  release text,
  fingerprint text NOT NULL,
  exception_type text,
  exception_value text,
  exception_stacktrace text,
  sdk_name text,
  sdk_version text,
  context jsonb,
  attributes jsonb
) PARTITION BY RANGE (received_at);

-- A unique index on a partitioned table must contain the partition key, so
-- this one only protects a single received_at. Cross-request deduplication
-- on (project_id, event_id) is done by event_ids below.
CREATE UNIQUE INDEX events_project_event_received_key ON events (project_id, event_id, received_at);
CREATE INDEX events_received_at_brin ON events USING brin (received_at);
CREATE INDEX events_project_received_idx ON events (project_id, received_at);
CREATE INDEX events_project_fingerprint_idx ON events (project_id, fingerprint);
CREATE INDEX events_project_severity_received_idx ON events (project_id, severity, received_at);

-- Deduplication index of accepted event_ids (docs/retention.md, "What is
-- retained": 7 days). appendEvents inserts here first with ON CONFLICT DO
-- NOTHING and only writes event rows for ids that were new.
CREATE TABLE event_ids (
  project_id text NOT NULL,
  event_id text NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, event_id)
);

CREATE INDEX event_ids_received_at_idx ON event_ids (received_at);

-- Creates the partition holding one UTC day, if it does not exist yet.
CREATE FUNCTION ensure_event_partition(day date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  part text := 'events_' || to_char(day, 'YYYYMMDD');
  lower_bound timestamptz := (day::timestamp AT TIME ZONE 'UTC');
  upper_bound timestamptz := ((day + 1)::timestamp AT TIME ZONE 'UTC');
BEGIN
  -- Serialise concurrent creators of the same day.
  PERFORM pg_advisory_xact_lock(hashtext('jekimo.events.partition'), (day - date '1970-01-01'));
  IF to_regclass(part) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
      part, lower_bound, upper_bound
    );
  END IF;
  RETURN part;
END;
$$;
