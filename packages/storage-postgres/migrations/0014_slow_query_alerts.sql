ALTER TABLE notification_rules DROP CONSTRAINT notification_rules_trigger_check;
ALTER TABLE notification_rules ADD CONSTRAINT notification_rules_trigger_check CHECK (trigger IN ('new_issue','regression','slow_query'));
ALTER TABLE notification_rules ADD COLUMN threshold_ms integer,
  ADD COLUMN environment text,
  ADD COLUMN query_name text,
  ADD COLUMN effective_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_query_alert_at timestamptz;
ALTER TABLE notification_rules ADD CONSTRAINT notification_rules_query_fields CHECK (
  (trigger = 'slow_query' AND threshold_ms IS NOT NULL AND threshold_ms BETWEEN 1 AND 604800000
    AND (environment IS NULL OR length(environment) BETWEEN 1 AND 128)
    AND (query_name IS NULL OR length(query_name) BETWEEN 1 AND 128))
  OR (trigger <> 'slow_query' AND threshold_ms IS NULL AND environment IS NULL AND query_name IS NULL)
);
CREATE TABLE notification_query_receipts (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (project_id,event_id)
);
CREATE INDEX notification_query_receipts_received ON notification_query_receipts(received_at);
