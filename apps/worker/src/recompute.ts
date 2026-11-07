/**
 * Issue recompute (docs/architecture.md, "Storage engines", rule 3): issue
 * counts are derived from the event store and can be rebuilt from it at any
 * time. For each project, every issue's count and first and last seen are
 * set from the events that remain, and issues with no events left are
 * deleted. Status, title, and environments are kept.
 */

import type { ProcessDeps } from "./process.js";

export interface RecomputeResult {
  projects: number;
  fingerprints: number;
}

/** Recomputes one project's issues, or every project's when projectId is omitted. */
export async function recomputeIssues(
  deps: ProcessDeps,
  options: { projectId?: string; clock?: () => Date } = {},
): Promise<RecomputeResult> {
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
