/**
 * Turns application input into event envelopes that fit the v1 limits.
 *
 * Everything here runs synchronously on the caller's stack, so it is bounded:
 * strings are truncated, containers are capped, and nesting stops at the
 * attribute depth limit. Redaction happens while copying, so the original
 * values never reach the serialised event. The key test is the shared one
 * from `@jekimo/event-schema` (`createKeyRedactor`), the same rules the
 * worker applies with `redactEvent`.
 */

import { type KeyRedactor, LIMITS, REDACTED_VALUE } from "@jekimo/event-schema";
import type { AttributeValue, EventEnvelope, ExceptionInfo } from "./index.js";

const ELLIPSIS = "…";
/** Replaces containers nested deeper than the attribute depth limit. */
export const TRUNCATED_VALUE = "[Truncated]";
/** Replaces a reference back to an enclosing object. */
export const CIRCULAR_VALUE = "[Circular]";
/** How many `cause` links are followed into the stacktrace text. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Shortens `value` to at most `max` UTF-16 code units, ending with `…` when it
 * was cut, without splitting a surrogate pair.
 */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 0) return "";
  let end = max - 1;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end) + ELLIPSIS;
}

/** Returns a non-empty string truncated to `max`, or undefined. */
export function shortString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return truncate(value, max);
}

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Copies a context object: string keys of valid length, string values (numbers
 * and booleans are converted, anything else is dropped), at most 32 entries,
 * with redaction.
 */
export function normalizeContext(
  input: Record<string, unknown> | undefined,
  redact: KeyRedactor,
): Record<string, string> | undefined {
  if (!isRecord(input)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const key of Object.keys(input)) {
    if (count >= LIMITS.MAX_CONTEXT_KEYS) break;
    if (key.length === 0 || key.length > LIMITS.MAX_CONTEXT_KEY_CHARS) continue;
    const raw = input[key];
    let value: string;
    if (redact(key)) value = REDACTED_VALUE;
    else if (typeof raw === "string") value = raw;
    else if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint") value = String(raw);
    else continue;
    out[key] = truncate(value, LIMITS.MAX_CONTEXT_VALUE_CHARS);
    count++;
  }
  return count > 0 ? out : undefined;
}

/**
 * Converts any value into an attribute value within the limits. Returns
 * undefined for values JSON would omit (undefined, functions, symbols).
 * `depth` is the depth of the container this value would become.
 */
function normalizeValue(
  value: unknown,
  depth: number,
  redact: KeyRedactor,
  ancestors: object[],
): AttributeValue | undefined {
  switch (typeof value) {
    case "string":
      return truncate(value, LIMITS.MAX_ATTRIBUTE_STRING_CHARS);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return truncate(value.toString(), LIMITS.MAX_ATTRIBUTE_STRING_CHARS);
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  if (value === null) return null;
  const obj = value as object;
  if (obj instanceof Date) {
    return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
  }
  if (obj instanceof Error) {
    return truncate(`${obj.name}: ${obj.message}`, LIMITS.MAX_ATTRIBUTE_STRING_CHARS);
  }
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
    return `[Binary ${(obj as ArrayBufferView | ArrayBuffer).byteLength} bytes]`;
  }
  if (ancestors.includes(obj)) return CIRCULAR_VALUE;
  if (depth > LIMITS.MAX_ATTRIBUTE_DEPTH) return TRUNCATED_VALUE;

  if (typeof (obj as { toJSON?: unknown }).toJSON === "function" && !Array.isArray(obj)) {
    let json: unknown;
    try {
      json = (obj as { toJSON(): unknown }).toJSON();
    } catch {
      return TRUNCATED_VALUE;
    }
    if (json !== obj) return normalizeValue(json, depth, redact, ancestors);
  }

  ancestors.push(obj);
  try {
    if (Array.isArray(obj) || obj instanceof Set) {
      const items = Array.isArray(obj)
        ? obj.slice(0, LIMITS.MAX_ATTRIBUTE_ARRAY_ITEMS)
        : take(obj, LIMITS.MAX_ATTRIBUTE_ARRAY_ITEMS);
      return items.map((item) => normalizeValue(item, depth + 1, redact, ancestors) ?? null);
    }
    const source =
      obj instanceof Map
        ? Object.fromEntries(take(obj, LIMITS.MAX_ATTRIBUTE_KEYS).map(([k, v]) => [safeString(k), v]))
        : (obj as Record<string, unknown>);
    return normalizeObject(source, depth, redact, ancestors);
  } finally {
    ancestors.pop();
  }
}

/** The first `n` items of an iterable, without materialising the rest. */
function take<T>(iterable: Iterable<T>, n: number): T[] {
  const out: T[] = [];
  if (n <= 0) return out;
  for (const item of iterable) {
    out.push(item);
    if (out.length >= n) break;
  }
  return out;
}

function normalizeObject(
  source: Record<string, unknown>,
  depth: number,
  redact: KeyRedactor,
  ancestors: object[],
): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  let count = 0;
  for (const key of Object.keys(source)) {
    if (count >= LIMITS.MAX_ATTRIBUTE_KEYS) break;
    if (key.length === 0 || key.length > LIMITS.MAX_ATTRIBUTE_KEY_CHARS) continue;
    if (redact(key)) {
      out[key] = REDACTED_VALUE;
      count++;
      continue;
    }
    let raw: unknown;
    try {
      raw = source[key];
    } catch {
      continue;
    }
    const value = normalizeValue(raw, depth + 1, redact, ancestors);
    if (value === undefined) continue;
    out[key] = value;
    count++;
  }
  return out;
}

/** Copies an attributes object within the limits, redacting by key at every depth. */
export function normalizeAttributes(
  input: Record<string, unknown> | undefined,
  redact: KeyRedactor,
): Record<string, AttributeValue> | undefined {
  if (!isRecord(input) || Array.isArray(input)) return undefined;
  const out = normalizeObject(input, 1, redact, [input]);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Name of an error: its `name`, else its constructor's name, else "Error". */
function errorType(error: object): string {
  const name = (error as { name?: unknown }).name;
  if (typeof name === "string" && name.length > 0) return name;
  const ctor = (error as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof ctor === "string" && ctor.length > 0 ? ctor : "Error";
}

function stackOf(error: object): string {
  const stack = (error as { stack?: unknown }).stack;
  if (typeof stack === "string" && stack.length > 0) return stack;
  const message = (error as { message?: unknown }).message;
  return `${errorType(error)}: ${typeof message === "string" ? message : ""}`;
}

/**
 * Builds stacktrace text for an error, appending its `cause` chain and the
 * members of an AggregateError the way Node prints them.
 */
function fullStack(error: object): string {
  let text = stackOf(error);
  const seen = new Set<unknown>([error]);
  if (error instanceof AggregateError) {
    error.errors.slice(0, 16).forEach((inner, i) => {
      text += `\n[errors][${i}]: ${isRecord(inner) ? stackOf(inner) : safeString(inner)}`;
    });
  }
  let cause = (error as { cause?: unknown }).cause;
  for (let depth = 0; cause !== undefined && depth < MAX_CAUSE_DEPTH; depth++) {
    if (seen.has(cause)) {
      text += "\nCaused by: [Circular]";
      break;
    }
    seen.add(cause);
    text += `\nCaused by: ${isRecord(cause) ? stackOf(cause) : safeString(cause)}`;
    cause = isRecord(cause) ? (cause as { cause?: unknown }).cause : undefined;
    if (text.length > LIMITS.MAX_STACKTRACE_CHARS) break;
  }
  return text;
}

/** Extracts exception info and a default message from any thrown value. */
export function exceptionFrom(error: unknown): { exception: ExceptionInfo; message: string } {
  if (isRecord(error) && (error instanceof Error || "stack" in error || "message" in error)) {
    const type = truncate(errorType(error), LIMITS.MAX_EXCEPTION_TYPE_CHARS);
    const rawMessage = (error as { message?: unknown }).message;
    const value = typeof rawMessage === "string" ? rawMessage : rawMessage === undefined ? "" : safeString(rawMessage);
    const exception: ExceptionInfo = {
      type,
      value: truncate(value, LIMITS.MAX_EXCEPTION_VALUE_CHARS),
      stacktrace: truncate(fullStack(error), LIMITS.MAX_STACKTRACE_CHARS),
    };
    return { exception, message: value.length > 0 ? value : type };
  }
  // A thrown string, number, or other non-error value.
  const text = typeof error === "string" ? error : safeJson(error);
  return {
    exception: { type: "NonError", value: truncate(text, LIMITS.MAX_EXCEPTION_VALUE_CHARS) },
    message: text.length > 0 ? text : "Non-error value thrown",
  };
}

function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // fall through
  }
  return safeString(value);
}

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Shrinks an event until it serialises within LIMITS.MAX_EVENT_BYTES: first
 * by dropping the largest top-level attributes, then by halving the
 * stacktrace, then by dropping context, then by halving the exception value
 * and the message. Returns the serialised form. Mutates `event`.
 */
export function fitEvent(event: EventEnvelope, maxBytes: number = LIMITS.MAX_EVENT_BYTES): string {
  let json = JSON.stringify(event);
  if (byteLength(json) <= maxBytes) return json;

  if (event.attributes) {
    const sizes = Object.entries(event.attributes)
      .map(([key, value]) => [key, byteLength(JSON.stringify(value))] as const)
      .sort((a, b) => b[1] - a[1]);
    for (const [key] of sizes) {
      delete event.attributes[key];
      json = JSON.stringify(event);
      if (byteLength(json) <= maxBytes) break;
    }
    if (Object.keys(event.attributes).length === 0) delete event.attributes;
    if (byteLength(json) <= maxBytes) return JSON.stringify(event);
  }

  const shrink = (get: () => string | undefined, set: (value: string) => void, min: number): boolean => {
    for (let value = get(); value !== undefined && value.length > min; value = get()) {
      set(truncate(value, Math.max(min, Math.floor(value.length / 2))));
      json = JSON.stringify(event);
      if (byteLength(json) <= maxBytes) return true;
    }
    return false;
  };

  const ex = event.exception;
  if (
    ex?.stacktrace !== undefined &&
    shrink(
      () => ex.stacktrace,
      (v) => (ex.stacktrace = v),
      0,
    )
  )
    return json;
  if (ex?.stacktrace === "") delete ex.stacktrace;
  if (event.context) {
    delete event.context;
    json = JSON.stringify(event);
    if (byteLength(json) <= maxBytes) return json;
  }
  if (
    ex?.value !== undefined &&
    shrink(
      () => ex.value,
      (v) => (ex.value = v),
      0,
    )
  )
    return json;
  shrink(
    () => event.message,
    (v) => (event.message = v),
    1,
  );
  return JSON.stringify(event);
}
