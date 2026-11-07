-- `id` exists because fingerprints are client strings of up to 256
-- characters, unsuitable for URLs. A resolved issue reopens when it receives
-- an event received after `status_changed_at`.

ALTER TABLE issues
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN last_event_id text,
  ADD COLUMN environments text[] NOT NULL DEFAULT '{}',
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN status_changed_by uuid REFERENCES users (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX issues_id_key ON issues (id);
CREATE INDEX issues_project_status_last_seen_idx ON issues (project_id, status, last_seen DESC, id DESC);
