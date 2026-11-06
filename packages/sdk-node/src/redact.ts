import { isRedactedKey, normalizeKey } from "@jekimo/event-schema";

export type KeyRedactor = (key: string) => boolean;

/**
 * Builds the redaction test for `context` and `attributes` keys: the default
 * list from the event format, the operator's extra keys (normalised the same
 * way), and the operator's regular expressions matched against the raw key.
 */
export function createRedactor(extraKeys: readonly string[] = [], patterns: readonly RegExp[] = []): KeyRedactor {
  const extra = new Set(extraKeys.map(normalizeKey));
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
