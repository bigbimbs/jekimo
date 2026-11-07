export const JSON_CONTENT_TYPE = /^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i;
export const RETRY_AFTER_SECONDS = 5;
/** A full queue drains at the worker's pace, so clients wait longer. */
export const QUEUE_FULL_RETRY_AFTER_SECONDS = 30;
/** docs/retention.md, "Disk safety". */
export const DISK_FULL_RETRY_AFTER_SECONDS = 60;
