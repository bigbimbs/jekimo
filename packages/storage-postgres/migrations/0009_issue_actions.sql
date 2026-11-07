-- Issue identity, latest event, environments, and status changes
-- (docs/access-model.md, "Permission catalogue": issues.manage).
--
-- `id` is the stable handle the API and dashboard use; fingerprints can be
-- long client strings. `last_event_id` points at the newest event of the
-- issue in the event store. `environments` collects the distinct
-- environments seen, for filtering. `status_changed_at` is when a person (or
-- a regression) last changed the status: a resolved issue that receives an
-- event received after it reopens.

ALTER TABLE issues
  ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN last_event_id text,
  ADD COLUMN environments text[] NOT NULL DEFAULT '{}',
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN status_changed_by uuid REFERENCES users (id) ON DELETE SET NULL;

CREATE UNIQUE INDEX issues_id_key ON issues (id);
CREATE INDEX issues_project_status_last_seen_idx ON issues (project_id, status, last_seen DESC, id DESC);
