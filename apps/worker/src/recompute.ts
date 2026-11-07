// docs/architecture.md, "Storage engines", rule 3: issue counts are derived
// from the event store and can be rebuilt from it at any time.

import type { ProcessDeps, RecomputeOptions, RecomputeResult } from "./types/index.js";

export async function recomputeIssues(deps: ProcessDeps, options: RecomputeOptions = {}): Promise<RecomputeResult> {
  const clock = options.clock ?? (() => new Date());
  const projectIds =
    options.projectId !== undefined
      ? [options.projectId]
      : (await deps.metadata.listProjectRetention()).map((p) => p.projectId);
  let fingerprints = 0;
  for (const projectId of projectIds) {
    // Read the time first: issues updated after it are left to the worker.
    const asOf = clock();
    const summaries = await deps.events.summarizeFingerprints(projectId);
    await deps.metadata.replaceIssueCounts(projectId, summaries, asOf);
    fingerprints += summaries.length;
  }
  return { projects: projectIds.length, fingerprints };
}
