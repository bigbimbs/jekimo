import type { EventEnvelope } from "./envelope.js";

/**
 * "ingest" validates what an SDK sends: `project_id` is forbidden because the
 * server assigns it from the ingestion key. "stored" validates the canonical
 * form held in storage and exports, where `project_id` is required.
 */
export type ValidationMode = "ingest" | "stored";

export type IssueCode =
  | "required"
  | "forbidden"
  | "type"
  | "enum"
  | "min_length"
  | "max_length"
  | "pattern"
  | "max_keys"
  | "max_items"
  | "max_depth"
  | "invalid_number"
  | "invalid_timestamp"
  | "future_timestamp"
  | "max_size"
  | "unknown_field";

export interface ValidationIssue {
  /** JSON-pointer-like path, for example "/exception/type". "" is the root. */
  path: string;
  code: IssueCode;
  message: string;
}

export interface ValidateOptions {
  mode?: ValidationMode;
  /** Reference time for the future-timestamp check. Defaults to the current time. */
  now?: Date;
  /** Defaults to LIMITS.MAX_FUTURE_SKEW_MS. */
  maxFutureSkewMs?: number;
}

export type ValidationResult =
  | { ok: true; event: EventEnvelope; warnings: ValidationIssue[] }
  | { ok: false; errors: ValidationIssue[]; warnings: ValidationIssue[] };
