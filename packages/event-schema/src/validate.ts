import { LIMITS } from "./limits.js";
import {
  EVENT_KINDS,
  SCHEMA_VERSION,
  SEVERITIES,
  TIMESTAMP_PATTERN,
  ULID_PATTERN,
  type AttributeValue,
  type EventEnvelope,
  type EventKind,
  type ExceptionInfo,
  type SdkInfo,
  type Severity,
} from "./types.js";

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

const TOP_LEVEL_FIELDS = new Set([
  "schema_version",
  "event_id",
  "project_id",
  "timestamp",
  "kind",
  "severity",
  "message",
  "service",
  "environment",
  "release",
  "fingerprint",
  "exception",
  "sdk",
  "context",
  "attributes",
]);

const EXCEPTION_FIELDS = new Set(["type", "value", "stacktrace"]);
const SDK_FIELDS = new Set(["name", "version"]);

const encoder = new TextEncoder();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Collector {
  readonly errors: ValidationIssue[] = [];
  readonly warnings: ValidationIssue[] = [];

  error(path: string, code: IssueCode, message: string): void {
    this.errors.push({ path, code, message });
  }

  warn(path: string, code: IssueCode, message: string): void {
    this.warnings.push({ path, code, message });
  }

  /**
   * Validates an optional or required string field and returns it when valid.
   * Returns undefined when absent or invalid.
   */
  string(
    path: string,
    value: unknown,
    opts: { required?: boolean; min?: number; max: number; pattern?: RegExp },
  ): string | undefined {
    if (value === undefined) {
      if (opts.required) this.error(path, "required", `${path} is required`);
      return undefined;
    }
    if (typeof value !== "string") {
      this.error(path, "type", `${path} must be a string`);
      return undefined;
    }
    const min = opts.min ?? 1;
    if (value.length < min) {
      this.error(path, "min_length", `${path} must be at least ${min} character(s)`);
      return undefined;
    }
    if (value.length > opts.max) {
      this.error(path, "max_length", `${path} must be at most ${opts.max} characters`);
      return undefined;
    }
    if (opts.pattern && !opts.pattern.test(value)) {
      this.error(path, "pattern", `${path} has an invalid format`);
      return undefined;
    }
    return value;
  }

  enumValue<T extends string>(
    path: string,
    value: unknown,
    allowed: readonly T[],
  ): T | undefined {
    if (value === undefined) {
      this.error(path, "required", `${path} is required`);
      return undefined;
    }
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      this.error(path, "enum", `${path} must be one of: ${allowed.join(", ")}`);
      return undefined;
    }
    return value as T;
  }

  unknownFields(path: string, obj: Record<string, unknown>, known: Set<string>): void {
    for (const key of Object.keys(obj)) {
      if (!known.has(key)) {
        this.warn(`${path}/${key}`, "unknown_field", `${path}/${key} is not part of schema version ${SCHEMA_VERSION} and was dropped`);
      }
    }
  }
}

function validateTimestamp(c: Collector, value: unknown, now: Date, maxFutureSkewMs: number): string | undefined {
  const s = c.string("/timestamp", value, { required: true, max: 64, pattern: TIMESTAMP_PATTERN });
  if (s === undefined) return undefined;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    c.error("/timestamp", "invalid_timestamp", "/timestamp is not a valid RFC 3339 date-time");
    return undefined;
  }
  if (ms - now.getTime() > maxFutureSkewMs) {
    c.error("/timestamp", "future_timestamp", `/timestamp is more than ${maxFutureSkewMs} ms in the future`);
    return undefined;
  }
  return s;
}

function validateException(c: Collector, value: unknown): ExceptionInfo | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    c.error("/exception", "type", "/exception must be an object");
    return undefined;
  }
  c.unknownFields("/exception", value, EXCEPTION_FIELDS);
  const type = c.string("/exception/type", value.type, { required: true, max: LIMITS.MAX_EXCEPTION_TYPE_CHARS });
  const exceptionValue = c.string("/exception/value", value.value, { min: 0, max: LIMITS.MAX_EXCEPTION_VALUE_CHARS });
  const stacktrace = c.string("/exception/stacktrace", value.stacktrace, { min: 0, max: LIMITS.MAX_STACKTRACE_CHARS });
  if (type === undefined) return undefined;
  const out: ExceptionInfo = { type };
  if (exceptionValue !== undefined) out.value = exceptionValue;
  if (stacktrace !== undefined) out.stacktrace = stacktrace;
  return out;
}

function validateSdk(c: Collector, value: unknown): SdkInfo | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    c.error("/sdk", "type", "/sdk must be an object");
    return undefined;
  }
  c.unknownFields("/sdk", value, SDK_FIELDS);
  const name = c.string("/sdk/name", value.name, { required: true, max: LIMITS.MAX_SDK_NAME_CHARS });
  const version = c.string("/sdk/version", value.version, { required: true, max: LIMITS.MAX_SDK_VERSION_CHARS });
  if (name === undefined || version === undefined) return undefined;
  return { name, version };
}

function validateContext(c: Collector, value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    c.error("/context", "type", "/context must be an object of string values");
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length > LIMITS.MAX_CONTEXT_KEYS) {
    c.error("/context", "max_keys", `/context must have at most ${LIMITS.MAX_CONTEXT_KEYS} keys`);
    return undefined;
  }
  const out: Record<string, string> = {};
  let valid = true;
  for (const key of keys) {
    const path = `/context/${key}`;
    if (key.length === 0 || key.length > LIMITS.MAX_CONTEXT_KEY_CHARS) {
      c.error(path, "max_length", `context keys must be 1 to ${LIMITS.MAX_CONTEXT_KEY_CHARS} characters`);
      valid = false;
      continue;
    }
    const v = c.string(path, value[key], { min: 0, max: LIMITS.MAX_CONTEXT_VALUE_CHARS });
    if (v === undefined) {
      valid = false;
      continue;
    }
    out[key] = v;
  }
  return valid ? out : undefined;
}

function validateAttributeValue(c: Collector, path: string, value: unknown, depth: number): value is AttributeValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "string" && value.length > LIMITS.MAX_ATTRIBUTE_STRING_CHARS) {
      c.error(path, "max_length", `${path} must be at most ${LIMITS.MAX_ATTRIBUTE_STRING_CHARS} characters`);
      return false;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      c.error(path, "invalid_number", `${path} must be a finite number`);
      return false;
    }
    return true;
  }
  if (depth > LIMITS.MAX_ATTRIBUTE_DEPTH) {
    c.error(path, "max_depth", `${path} exceeds the maximum nesting depth of ${LIMITS.MAX_ATTRIBUTE_DEPTH}`);
    return false;
  }
  if (Array.isArray(value)) {
    if (value.length > LIMITS.MAX_ATTRIBUTE_ARRAY_ITEMS) {
      c.error(path, "max_items", `${path} must have at most ${LIMITS.MAX_ATTRIBUTE_ARRAY_ITEMS} items`);
      return false;
    }
    let ok = true;
    value.forEach((item, i) => {
      if (!validateAttributeValue(c, `${path}/${i}`, item, depth + 1)) ok = false;
    });
    return ok;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > LIMITS.MAX_ATTRIBUTE_KEYS) {
      c.error(path, "max_keys", `${path} must have at most ${LIMITS.MAX_ATTRIBUTE_KEYS} keys`);
      return false;
    }
    let ok = true;
    for (const key of keys) {
      const childPath = `${path}/${key}`;
      if (key.length === 0 || key.length > LIMITS.MAX_ATTRIBUTE_KEY_CHARS) {
        c.error(childPath, "max_length", `attribute keys must be 1 to ${LIMITS.MAX_ATTRIBUTE_KEY_CHARS} characters`);
        ok = false;
        continue;
      }
      if (!validateAttributeValue(c, childPath, value[key], depth + 1)) ok = false;
    }
    return ok;
  }
  c.error(path, "type", `${path} must be a JSON value (string, number, boolean, null, array, or object)`);
  return false;
}

function validateAttributes(c: Collector, value: unknown): Record<string, AttributeValue> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    c.error("/attributes", "type", "/attributes must be an object");
    return undefined;
  }
  return validateAttributeValue(c, "/attributes", value, 1) ? (value as Record<string, AttributeValue>) : undefined;
}

/**
 * Validates an untrusted value against event envelope v1.
 *
 * On success the returned `event` contains only known fields, in canonical
 * order; unknown fields are reported as warnings and dropped. The function
 * never throws on bad input.
 */
export function validateEvent(input: unknown, options: ValidateOptions = {}): ValidationResult {
  const mode: ValidationMode = options.mode ?? "ingest";
  const now = options.now ?? new Date();
  const maxFutureSkewMs = options.maxFutureSkewMs ?? LIMITS.MAX_FUTURE_SKEW_MS;
  const c = new Collector();

  if (!isPlainObject(input)) {
    c.error("", "type", "event must be a JSON object");
    return { ok: false, errors: c.errors, warnings: c.warnings };
  }

  c.unknownFields("", input, TOP_LEVEL_FIELDS);

  if (input.schema_version !== SCHEMA_VERSION) {
    c.error("/schema_version", "enum", `/schema_version must be ${SCHEMA_VERSION}`);
  }

  const event_id = c.string("/event_id", input.event_id, { required: true, max: 26, pattern: ULID_PATTERN });

  let project_id: string | undefined;
  if (mode === "ingest") {
    if (input.project_id !== undefined) {
      c.error("/project_id", "forbidden", "/project_id is assigned by the server and must not be sent by clients");
    }
  } else {
    project_id = c.string("/project_id", input.project_id, { required: true, max: LIMITS.MAX_PROJECT_ID_CHARS });
  }

  const timestamp = validateTimestamp(c, input.timestamp, now, maxFutureSkewMs);
  const kind = c.enumValue<EventKind>("/kind", input.kind, EVENT_KINDS);
  const severity = c.enumValue<Severity>("/severity", input.severity, SEVERITIES);
  const message = c.string("/message", input.message, { required: true, max: LIMITS.MAX_MESSAGE_CHARS });
  const service = c.string("/service", input.service, { max: LIMITS.MAX_SHORT_STRING_CHARS });
  const environment = c.string("/environment", input.environment, { max: LIMITS.MAX_SHORT_STRING_CHARS });
  const release = c.string("/release", input.release, { max: LIMITS.MAX_SHORT_STRING_CHARS });
  const fingerprint = c.string("/fingerprint", input.fingerprint, { max: LIMITS.MAX_FINGERPRINT_CHARS });
  const exception = validateException(c, input.exception);
  if (kind === "exception" && input.exception === undefined) {
    c.error("/exception", "required", '/exception is required when /kind is "exception"');
  }
  const sdk = validateSdk(c, input.sdk);
  const context = validateContext(c, input.context);
  const attributes = validateAttributes(c, input.attributes);

  if (c.errors.length > 0 || event_id === undefined || timestamp === undefined || kind === undefined || severity === undefined || message === undefined) {
    return { ok: false, errors: c.errors, warnings: c.warnings };
  }

  const event: EventEnvelope = {
    schema_version: SCHEMA_VERSION,
    event_id,
    ...(project_id !== undefined ? { project_id } : {}),
    timestamp,
    kind,
    severity,
    message,
  };
  if (service !== undefined) event.service = service;
  if (environment !== undefined) event.environment = environment;
  if (release !== undefined) event.release = release;
  if (fingerprint !== undefined) event.fingerprint = fingerprint;
  if (exception !== undefined) event.exception = exception;
  if (sdk !== undefined) event.sdk = sdk;
  if (context !== undefined) event.context = context;
  if (attributes !== undefined) event.attributes = attributes;

  const bytes = encoder.encode(JSON.stringify(event)).length;
  if (bytes > LIMITS.MAX_EVENT_BYTES) {
    c.error("", "max_size", `event is ${bytes} bytes; the maximum is ${LIMITS.MAX_EVENT_BYTES}`);
    return { ok: false, errors: c.errors, warnings: c.warnings };
  }

  return { ok: true, event, warnings: c.warnings };
}
