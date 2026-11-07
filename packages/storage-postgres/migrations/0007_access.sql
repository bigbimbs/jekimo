-- Invitations and password reset links (docs/access-model.md, "Invitations
-- and recovery without email"), and indexes for the audit log listing.

-- Single-use account links. Only a SHA-256 hash of the token is stored.
-- An invitation names an email and an instance role; a reset names a user.
CREATE TABLE account_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL CHECK (purpose IN ('invitation', 'password_reset')),
  token_hash bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  email text,
  instance_role text CHECK (instance_role IN ('admin', 'member')),
  user_id uuid REFERENCES users (id) ON DELETE CASCADE,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  CHECK (
    (purpose = 'invitation' AND email IS NOT NULL AND instance_role IS NOT NULL AND user_id IS NULL)
    OR (purpose = 'password_reset' AND user_id IS NOT NULL)
  )
);

CREATE INDEX account_tokens_email_idx ON account_tokens (lower(email)) WHERE purpose = 'invitation';
CREATE INDEX account_tokens_user_id_idx ON account_tokens (user_id) WHERE purpose = 'password_reset';

-- The audit log is kept after a project is deleted, so it has no foreign
-- key to projects (docs/retention.md, "Deletion").
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, id);
CREATE INDEX audit_log_action_idx ON audit_log (action, id);
