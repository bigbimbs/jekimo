/**
 * Server-side redaction of the default key list (docs/event-format.md,
 * "Privacy defaults"). SDKs redact before sending; the server applies the
 * same list again so a misconfigured SDK is not the last line of defense.
 * Project-level rules configured by operators are not implemented yet.
 */

import { isRedactedKey, REDACTED_VALUE, type AttributeValue, type EventEnvelope } from "@jekimo/event-schema";

function redactValue(value: AttributeValue): AttributeValue {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isRedactedKey(k) ? REDACTED_VALUE : redactValue(v)]));
  }
  return value;
}

export function redactEvent<E extends EventEnvelope>(event: E): E {
  const out = { ...event };
  if (event.context) {
    out.context = Object.fromEntries(Object.entries(event.context).map(([k, v]) => [k, isRedactedKey(k) ? REDACTED_VALUE : v]));
  }
  if (event.attributes) out.attributes = redactValue(event.attributes) as Record<string, AttributeValue>;
  return out;
}
