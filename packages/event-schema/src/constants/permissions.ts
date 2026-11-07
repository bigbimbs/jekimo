export const PROJECT_PERMISSIONS = [
  "project.read",
  "issues.manage",
  "data.export",
  "data.delete",
  "keys.manage",
  "settings.manage",
  "members.manage",
  "roles.manage",
  "project.delete",
] as const;
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number];

/** Every role must include this permission. */
export const REQUIRED_PERMISSION: ProjectPermission = "project.read";

export const BUILT_IN_ROLE_NAMES = ["admin", "member", "viewer"] as const;
export type BuiltInRoleName = (typeof BUILT_IN_ROLE_NAMES)[number];

/**
 * Permission sets of the built-in roles, matching the table in
 * docs/access-model.md. `admin` always holds every permission.
 */
export const DEFAULT_PROJECT_ROLES: Readonly<Record<BuiltInRoleName, ReadonlySet<ProjectPermission>>> = {
  admin: new Set<ProjectPermission>(PROJECT_PERMISSIONS),
  member: new Set<ProjectPermission>(["project.read", "issues.manage", "data.export"]),
  viewer: new Set<ProjectPermission>(["project.read"]),
};

export const ROLE_NAME_MAX_CHARS = 40;
