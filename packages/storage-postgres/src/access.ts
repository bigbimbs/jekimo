/**
 * Proof that an actor may touch a project's data (docs/access-model.md,
 * "Authorization enforcement", rule 1). Only repositories in this package can
 * create one, after checking membership or instance-admin authority, so code
 * outside the package cannot reach project data by passing a bare project id
 * it read from a request.
 */

import type { ProjectPermission } from "@jekimo/event-schema";

declare const brand: unique symbol;

export interface ProjectAccess {
  readonly projectId: string;
  readonly userId: string;
  readonly permissions: ReadonlySet<ProjectPermission>;
  /** True when access comes from the instance admin role rather than membership. */
  readonly viaInstanceAdmin: boolean;
  readonly [brand]: true;
}

const issued = new WeakSet<object>();

/** Internal to this package. Not exported from the package entry point. */
export function mintProjectAccess(fields: Omit<ProjectAccess, typeof brand>): ProjectAccess {
  const access = Object.freeze({ ...fields, permissions: new Set(fields.permissions) }) as unknown as ProjectAccess;
  issued.add(access);
  return access;
}

/** Throws unless `access` was created by resolveProjectAccess. */
export function assertProjectAccess(access: ProjectAccess): void {
  if (!issued.has(access)) throw new TypeError("ProjectAccess was not issued by the storage layer");
}

export function hasProjectPermission(access: ProjectAccess, permission: ProjectPermission): boolean {
  return access.permissions.has(permission);
}
