-- Project-level redaction rules applied by the server on top of the default
-- key list (docs/event-format.md, "Privacy defaults"). `keys` holds
-- normalized key names; `patterns` holds regular expression sources.

ALTER TABLE projects
  ADD COLUMN redaction_rules jsonb NOT NULL DEFAULT '{"keys": [], "patterns": []}'::jsonb
    CHECK (
      jsonb_typeof(redaction_rules -> 'keys') = 'array'
      AND jsonb_typeof(redaction_rules -> 'patterns') = 'array'
    );
