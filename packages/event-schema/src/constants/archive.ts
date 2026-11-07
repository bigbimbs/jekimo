/** Normative text: docs/object-storage.md. */
export const ARCHIVE_LAYOUT_VERSION = 1 as const;

/** Archive part formats recorded in a day manifest. */
export const ARCHIVE_FORMATS = ["ndjson.zst"] as const;
export type ArchiveFormat = (typeof ARCHIVE_FORMATS)[number];

/** Internal project identifiers must be safe to embed in object keys. */
export const SAFE_PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Calendar day in UTC as YYYY-MM-DD. */
export const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const HOT_DAYS = {
  /** Hot period for new projects when an object store is configured. */
  DEFAULT_WITH_OBJECT_STORE: 14,
  /** Total retention for new projects when an object store is configured. */
  RETENTION_DEFAULT_WITH_OBJECT_STORE: 90,
  MAX: 365,
} as const;
