-- Secrets in this state are AES-256-GCM ciphertext; recovery codes are SHA-256 hashes.
CREATE TABLE user_two_factor (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object')
);
CREATE TABLE instance_security (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  two_factor_required boolean NOT NULL DEFAULT false
);
INSERT INTO instance_security (id) VALUES (true);
ALTER TABLE sessions ADD COLUMN two_factor_version uuid;
