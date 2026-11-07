export const USER_COLUMNS = "u.id, u.email, u.instance_role, u.status, u.created_at";

export const PROJECT_COLUMNS = "p.id, p.name, p.retention_days, p.sample_rate, p.disabled, p.created_at";

/**
 * Must match the expression of events_message_search_idx (migration 0006)
 * exactly, or PostgreSQL will not use the index.
 */
export const MESSAGE_VECTOR =
  "to_tsvector('simple', regexp_replace(message, '[[:punct:][:space:][:cntrl:]]+', ' ', 'g'))";
