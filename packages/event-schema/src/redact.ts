// Normative text: docs/event-format.md, "Privacy defaults".

import { isRedactedKey, normalizeKey, REDACTED_VALUE } from "./limits.js";
import type { KeyRedactor, RedactOptions } from "./types/index.js";
import type { AttributeValue, EventEnvelope } from "./types.js";

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

/** Returns a copy; the input is not mutated. */
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
