CREATE TABLE notification_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  encrypted text NOT NULL
);
CREATE TABLE notification_channels (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('email', 'slack', 'webhook')),
  enabled boolean NOT NULL DEFAULT true,
  encrypted text NOT NULL,
  UNIQUE (project_id, id)
);
CREATE TABLE notification_rules (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL,
  name text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('new_issue', 'regression')),
  cooldown_minutes integer NOT NULL CHECK (cooldown_minutes BETWEEN 1 AND 1440),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, channel_id) REFERENCES notification_channels(project_id, id)
);
CREATE TABLE notification_signals (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL,
  trigger text NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification_cooldowns (
  rule_id uuid NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL,
  last_sent_at timestamptz NOT NULL,
  PRIMARY KEY (rule_id, issue_id)
);
CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES notification_channels(id),
  channel_name text NOT NULL,
  kind text NOT NULL,
  encrypted text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'retrying', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  error text
);
CREATE INDEX notification_deliveries_due ON notification_deliveries(available_at) WHERE status IN ('queued','retrying','sending');
CREATE INDEX notification_deliveries_project ON notification_deliveries(project_id, created_at DESC);
CREATE INDEX notification_signals_created ON notification_signals(created_at);

-- Persist the signal in the issue transaction; event storage remains separate.
CREATE FUNCTION capture_notification_signal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reason text;
BEGIN
  IF NEW.kind <> 'exception' AND NEW.last_severity NOT IN ('error','fatal') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN reason := 'new_issue';
  ELSIF OLD.status = 'resolved' AND NEW.status = 'unresolved' AND NEW.status_changed_by IS NULL THEN reason := 'regression';
  ELSE RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM notification_rules WHERE project_id = NEW.project_id AND enabled AND trigger = reason) THEN
    INSERT INTO notification_signals(project_id, issue_id, trigger, title) VALUES (NEW.project_id, NEW.id, reason, NEW.title);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER issue_notification_signal AFTER INSERT OR UPDATE OF status ON issues
  FOR EACH ROW EXECUTE FUNCTION capture_notification_signal();
