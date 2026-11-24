ALTER TABLE events ADD COLUMN database jsonb;
CREATE INDEX events_database_received ON events (project_id, received_at DESC, event_id DESC) WHERE database IS NOT NULL;
