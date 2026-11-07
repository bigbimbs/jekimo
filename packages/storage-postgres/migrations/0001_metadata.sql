-- Metadata: users, sessions, projects, roles, memberships, ingestion keys,
-- issues, and the audit log. See docs/access-model.md and the "Storage
-- engines" section of docs/architecture.md. Metadata always lives in
-- PostgreSQL; event rows live in the event store (0002).

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  instance_role text NOT NULL CHECK (instance_role IN ('admin', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- Server-side sessions. Only a SHA-256 hash of the cookie token is stored.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  source_ip text,
  user_agent text
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE projects (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 3650),
  sample_rate double precision NOT NULL DEFAULT 1 CHECK (sample_rate >= 0 AND sample_rate <= 1),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Built-in roles (admin, member, viewer) are created with every project.
CREATE TABLE project_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  description text,
  permissions text[] NOT NULL CHECK ('project.read' = ANY (permissions)),
  built_in boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX project_roles_name_key ON project_roles (project_id, lower(name));

CREATE TABLE project_members (
  project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES project_roles (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX project_members_user_id_idx ON project_members (user_id);

-- key_id is public; key_hash is SHA-256 of the full key string. The secret
-- is never stored.
CREATE TABLE ingestion_keys (
  key_id text PRIMARY KEY CHECK (key_id ~ '^[0-9A-HJKMNP-TV-Z]{12}$'),
  project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  key_hash bytea NOT NULL CHECK (length(key_hash) = 32),
  name text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX ingestion_keys_project_id_idx ON ingestion_keys (project_id);

-- Issue summaries grouped by fingerprint. Counts are derived from the event
-- store and can be recomputed at any time; they are never the source of truth.
CREATE TABLE issues (
  project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  title text NOT NULL,
  kind text NOT NULL,
  last_severity text NOT NULL,
  status text NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved', 'resolved', 'ignored')),
  event_count bigint NOT NULL DEFAULT 0,
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, fingerprint)
);

CREATE INDEX issues_project_last_seen_idx ON issues (project_id, last_seen DESC);

-- Append-only. Entries never contain passwords, keys, session tokens, or
-- event payloads.
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  project_id text,
  source_ip text,
  via_instance_admin boolean NOT NULL DEFAULT false,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_log_occurred_at_idx ON audit_log (occurred_at);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id, occurred_at);
