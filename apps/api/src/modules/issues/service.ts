import type { IssuePage, IssueQuery, IssueStatus, ProjectAccess } from "@jekimo/storage-postgres";
import { ApiError } from "../../errors.js";
import type { IssueServiceDeps } from "../../types/index.js";

const issueNotFound = () => new ApiError(404, "not_found", "issue not found");

/** Status changes are audit-logged by the storage layer. */
export class IssueService {
  constructor(private readonly deps: IssueServiceDeps) {}

  async list(access: ProjectAccess, query: IssueQuery): Promise<IssuePage> {
    try {
      return await this.deps.metadata.listIssues(access, query);
    } catch (err) {
      if (err instanceof RangeError) throw new ApiError(400, "invalid_request", "cursor is not valid");
      throw err;
    }
  }

  /** Scoped to the access check's project, so another project's issue id is a 404. */
  async get(access: ProjectAccess, issueId: string) {
    const issue = await this.deps.metadata.getIssue(access, issueId);
    if (!issue) throw issueNotFound();
    const latest =
      issue.lastEventId === undefined ? null : await this.deps.events.getEvent(access.projectId, issue.lastEventId);
    return { issue, latest };
  }

  async setStatus(access: ProjectAccess, issueId: string, status: IssueStatus, sourceIp: string) {
    const issue = await this.deps.metadata.setIssueStatus(access, issueId, status, sourceIp);
    if (!issue) throw issueNotFound();
    return issue;
  }
}
