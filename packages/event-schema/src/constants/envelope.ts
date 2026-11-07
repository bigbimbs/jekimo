/** Current envelope schema version. Incremented only on breaking changes. */
export const SCHEMA_VERSION = 1 as const;

export const EVENT_KINDS = ["exception", "log", "event"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const SEVERITIES = ["debug", "info", "warning", "error", "fatal"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Crockford base32 ULID: 26 characters, first character 0-7. */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** RFC 3339 timestamp with optional fractional seconds and a Z or numeric offset. */
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
