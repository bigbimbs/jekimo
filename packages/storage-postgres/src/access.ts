import type { ProjectPermission } from "@jekimo/event-schema";
import type { ProjectAccess } from "./types/access.js";

const issued = new WeakSet<object>();

/** Never re-export from an entry point: only this package may vouch for access. */
export function mintProjectAccess(
  fields: Pick<ProjectAccess, "projectId" | "userId" | "permissions" | "viaInstanceAdmin">,
): ProjectAccess {
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
