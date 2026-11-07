import { randomInt } from "node:crypto";
import { normalizeRetentionDays } from "@jekimo/event-schema";
import type { Actor, ProjectAccess, ProjectSettingsChange } from "@jekimo/storage-postgres";
import { ApiError } from "../../errors.js";
import type { NewProjectInput, ProjectServiceDeps } from "../../types/index.js";

const PROJECT_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newProjectId(): string {
  let id = "prj_";
  for (let i = 0; i < 16; i++) id += PROJECT_ID_ALPHABET[randomInt(PROJECT_ID_ALPHABET.length)];
  return id;
}

export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  canCreate(actor: Actor): boolean {
    return actor.instanceRole === "admin" || this.deps.membersCanCreateProjects;
  }

  /** Throws a 400 unless `value` is a whole number of days within the instance maximum. */
  retentionDays(value: unknown): number {
    const days = normalizeRetentionDays(value, this.deps.retentionMaxDays);
    if (days === null) {
      throw new ApiError(
        400,
        "invalid_request",
        `retention_days must be a whole number from 1 to ${this.deps.retentionMaxDays}`,
      );
    }
    return days;
  }

  list(actor: Actor) {
    return this.deps.metadata.listProjects(actor);
  }

  create(actor: Actor, input: NewProjectInput) {
    const retentionDays =
      input.retentionDays === undefined ? this.deps.retentionDefaultDays : this.retentionDays(input.retentionDays);
    return this.deps.metadata.createProject(actor, {
      id: newProjectId(),
      name: input.name,
      retentionDays,
      sourceIp: input.sourceIp,
    });
  }

  get(access: ProjectAccess) {
    return this.deps.metadata.getProject(access);
  }

  update(access: ProjectAccess, change: ProjectSettingsChange, sourceIp: string) {
    return this.deps.metadata.updateProject(access, change, sourceIp);
  }
}
