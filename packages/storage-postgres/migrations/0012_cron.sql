CREATE TABLE cron_monitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  expression text NOT NULL,
  timezone text NOT NULL,
  grace_seconds integer NOT NULL CHECK (grace_seconds BETWEEN 0 AND 86400),
  max_runtime_seconds integer NOT NULL CHECK (max_runtime_seconds BETWEEN 1 AND 604800),
  failure_threshold integer NOT NULL CHECK (failure_threshold BETWEEN 1 AND 100),
  recovery_threshold integer NOT NULL CHECK (recovery_threshold BETWEEN 1 AND 100),
  channel_id uuid,
  enabled boolean NOT NULL DEFAULT true,
  health text NOT NULL DEFAULT 'pending' CHECK (health IN ('pending','healthy','failing')),
  next_expected_at timestamptz NOT NULL,
  last_success_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  consecutive_successes integer NOT NULL DEFAULT 0,
  incident_open boolean NOT NULL DEFAULT false,
  minute_start timestamptz,
  minute_count integer NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id,channel_id) REFERENCES notification_channels(project_id,id),
  UNIQUE (project_id,id)
);
CREATE TABLE cron_runs (
  monitor_id uuid NOT NULL REFERENCES cron_monitors(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('started','ok','error','timeout','missed','cancelled')),
  started_at timestamptz,
  finished_at timestamptz,
  expected_at timestamptz,
  deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (monitor_id,id)
);
CREATE INDEX cron_runs_history ON cron_runs(monitor_id,created_at DESC);
CREATE INDEX cron_runs_deadlines ON cron_runs(monitor_id,deadline_at) WHERE status = 'started';
CREATE INDEX cron_monitors_due ON cron_monitors(next_expected_at) WHERE enabled;
