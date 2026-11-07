/**
 * Server-side redaction (docs/event-format.md, "Privacy defaults"). SDKs
 * redact before sending; the server applies the default key list again, plus
 * the project's own rules, so a misconfigured SDK is not the last line of
 * defense.
 *
 * Project rules are extra key names, normalized like the default list, and
 * regular expressions matched against the raw key name, as in the Node SDK.
 */

import {
  type AttributeValue,
  type EventEnvelope,
  isRedactedKey,
  normalizeKey,
  REDACTED_VALUE,
} from "@jekimo/event-schema";
import type { MetadataRepository, RedactionRules } from "@jekimo/storage-postgres";

/** True when the value under this key must be replaced. */
export type KeyRedactor = (key: string) => boolean;

/**
 * Builds the key test for one project. Throws if a stored pattern does not
 * compile, so the job fails rather than storing a value the operator asked to
 * hide.
 */
export function createRedactor(rules: RedactionRules | null): KeyRedactor {
  if (!rules || (rules.keys.length === 0 && rules.patterns.length === 0)) return isRedactedKey;
  const keys = new Set(rules.keys.map(normalizeKey));
  const patterns = rules.patterns.map((source) => new RegExp(source));
  return (key) => isRedactedKey(key) || keys.has(normalizeKey(key)) || patterns.some((p) => p.test(key));
}

/**
 * Loads and compiles each project's rules once. The worker makes a new cache
 * for every batch, so a rule change applies from the next batch on.
 */
export class RedactorCache {
  private readonly byProject = new Map<string, Promise<KeyRedactor>>();

  constructor(private readonly metadata: Pick<MetadataRepository, "getRedactionRules">) {}

  get(projectId: string): Promise<KeyRedactor> {
    let redactor = this.byProject.get(projectId);
    if (!redactor) {
      redactor = this.metadata.getRedactionRules(projectId).then(createRedactor);
      // A failed load is not cached; the next job asks again.
      redactor.catch(() => this.byProject.delete(projectId));
      this.byProject.set(projectId, redactor);
    }
    return redactor;
  }
}

function redactValue(value: AttributeValue, redact: KeyRedactor): AttributeValue {
  if (Array.isArray(value)) return value.map((v) => redactValue(v, redact));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redact(k) ? REDACTED_VALUE : redactValue(v, redact)]),
    );
  }
  return value;
}

export function redactEvent<E extends EventEnvelope>(event: E, redact: KeyRedactor = isRedactedKey): E {
  const out = { ...event };
  if (event.context) {
    out.context = Object.fromEntries(
      Object.entries(event.context).map(([k, v]) => [k, redact(k) ? REDACTED_VALUE : v]),
    );
  }
  if (event.attributes) out.attributes = redactValue(event.attributes, redact) as Record<string, AttributeValue>;
  return out;
}
