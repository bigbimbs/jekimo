/**
 * Key-based redaction. Normative text: docs/event-format.md, "Privacy
 * defaults".
 *
 * The value of any `context` key, or `attributes` key at any depth, that is
 * on the default list, on the operator's extra list, or matches one of the
 * operator's patterns is replaced with `[REDACTED]`. SDKs apply this in the
 * application process before serialization; the worker applies it again with
 * the project's own rules.
 */

import { isRedactedKey, normalizeKey, REDACTED_VALUE } from "./limits.js";
import type { AttributeValue, EventEnvelope } from "./types.js";

export interface RedactOptions {
  /** Extra key names, compared with normalizeKey like the defaults. */
  extraKeys?: readonly string[];
  /** Regular expressions tested against the original key name. */
  patterns?: readonly RegExp[];
  /** When true, drop `context` entirely. */
  dropContext?: boolean;
}

/** True when the value under this key must be replaced. */
export type KeyRedactor = (key: string) => boolean;

/**
 * The key test for a set of options: the default list, the extra keys, then
 * the patterns. SDKs that redact while copying values use it directly.
 */
export function createKeyRedactor(options: RedactOptions = {}): KeyRedactor {
  const extra = new Set((options.extraKeys ?? []).map(normalizeKey));
  const patterns = options.patterns ?? [];
  if (extra.size === 0 && patterns.length === 0) return isRedactedKey;
  return (key) => {
    if (isRedactedKey(key) || extra.has(normalizeKey(key))) return true;
    for (const pattern of patterns) {
      // A global or sticky expression keeps state between calls; reset it.
      pattern.lastIndex = 0;
      if (pattern.test(key)) return true;
    }
    return false;
  };
}

function redactValue(value: AttributeValue, redact: KeyRedactor): AttributeValue {
  if (Array.isArray(value)) return value.map((v) => redactValue(v, redact));
  if (value !== null && typeof value === "object") return redactObject(value, redact);
  return value;
}

function redactObject(obj: { [key: string]: AttributeValue }, redact: KeyRedactor): { [key: string]: AttributeValue } {
  const out: { [key: string]: AttributeValue } = {};
  // A redacted object is replaced whole, never walked.
  for (const [k, v] of Object.entries(obj)) out[k] = redact(k) ? REDACTED_VALUE : redactValue(v, redact);
  return out;
}

/**
 * Returns a copy of the event with sensitive `context` and `attributes`
 * values replaced. No other field is changed and the input is not mutated.
 */
export function redactEvent<T extends EventEnvelope>(event: T, options: RedactOptions = {}): T {
  const redact = createKeyRedactor(options);
  const out: T = { ...event };
  if (options.dropContext) {
    delete out.context;
  } else if (event.context) {
    const context: Record<string, string> = {};
    for (const [k, v] of Object.entries(event.context)) context[k] = redact(k) ? REDACTED_VALUE : v;
    out.context = context;
  }
  if (event.attributes) out.attributes = redactObject(event.attributes, redact);
  return out;
}
