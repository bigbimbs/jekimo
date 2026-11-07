/**
 * Server-side redaction (docs/event-format.md, "Privacy defaults"). SDKs
 * redact before sending; the server applies the default key list again, plus
 * the project's own rules, so a misconfigured SDK is not the last line of
 * defense.
 *
 * Project rules are extra key names, normalized like the default list, and
 * regular expressions matched against the raw key name, as in the Node SDK.
 */

import type { RedactOptions } from "@jekimo/event-schema";
import type { MetadataRepository, RedactionRules } from "@jekimo/storage-postgres";

/**
 * Compiles one project's rules into `redactEvent` options. Throws if a stored
 * pattern does not compile, so the job fails rather than storing a value the
 * operator asked to hide.
 */
export function redactOptions(rules: RedactionRules | null): RedactOptions {
  if (!rules) return {};
  return { extraKeys: rules.keys, patterns: rules.patterns.map((source) => new RegExp(source)) };
}

/**
 * Loads and compiles each project's rules once. The worker makes a new cache
 * for every batch, so a rule change applies from the next batch on.
 */
export class RedactorCache {
  private readonly byProject = new Map<string, Promise<RedactOptions>>();

  constructor(private readonly metadata: Pick<MetadataRepository, "getRedactionRules">) {}

  get(projectId: string): Promise<RedactOptions> {
    let options = this.byProject.get(projectId);
    if (!options) {
      options = this.metadata.getRedactionRules(projectId).then(redactOptions);
      // A failed load is not cached; the next job asks again.
      options.catch(() => this.byProject.delete(projectId));
      this.byProject.set(projectId, options);
    }
    return options;
  }
}
