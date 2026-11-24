export const DATABASE_SYSTEMS = ["postgresql", "mysql", "sqlite", "mongodb", "redis", "other"] as const;
export const DATABASE_OPERATIONS = ["select", "insert", "update", "delete", "other"] as const;
export const DATABASE_STATUSES = ["ok", "error"] as const;
export const MAX_QUERY_DURATION_MS = 604800000;
