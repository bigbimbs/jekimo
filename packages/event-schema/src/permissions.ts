// Normative text: docs/access-model.md. Access inside a project is
// permission-based; a role is only a named set of permissions.

import {
  BUILT_IN_ROLE_NAMES,
  type BuiltInRoleName,
  PROJECT_PERMISSIONS,
  type ProjectPermission,
  REQUIRED_PERMISSION,
  ROLE_NAME_MAX_CHARS,
} from "./constants/permissions.js";
import type { ProjectRole, RoleIssue, RoleValidation } from "./types/permissions.js";

export function isProjectPermission(value: unknown): value is ProjectPermission {
  return typeof value === "string" && (PROJECT_PERMISSIONS as readonly string[]).includes(value);
}

export function isBuiltInRoleName(name: string): name is BuiltInRoleName {
  return (BUILT_IN_ROLE_NAMES as readonly string[]).includes(name.toLowerCase());
}

export function hasPermission(role: Pick<ProjectRole, "permissions">, permission: ProjectPermission): boolean {
  return role.permissions.has(permission);
}

/**
 * Validates a custom role definition as submitted by a user holding
 * `actorPermissions`. Enforces the naming rules, that every permission exists,
 * that `project.read` is included, and the no-escalation rule: the actor may
 * only grant permissions they hold.
 */
export function validateCustomRole(
  input: { name: unknown; permissions: unknown },
  actorPermissions: ReadonlySet<ProjectPermission>,
): RoleValidation {
  const issues: RoleIssue[] = [];

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0) issues.push({ code: "name_empty", message: "role name is required" });
  else if (name.length > ROLE_NAME_MAX_CHARS)
    issues.push({ code: "name_too_long", message: `role name must be at most ${ROLE_NAME_MAX_CHARS} characters` });
  else if (isBuiltInRoleName(name))
    issues.push({ code: "name_reserved", message: `"${name}" is a built-in role name` });

  const permissions = new Set<ProjectPermission>();
  const raw = Array.isArray(input.permissions)
    ? input.permissions
    : input.permissions instanceof Set
      ? [...input.permissions]
      : null;
  if (raw === null) {
    issues.push({ code: "unknown_permission", message: "permissions must be a list" });
  } else {
    for (const p of raw) {
      if (!isProjectPermission(p)) {
        issues.push({ code: "unknown_permission", message: `unknown permission ${String(p)}`, permission: String(p) });
        continue;
      }
      permissions.add(p);
    }
  }
  if (raw !== null && !permissions.has(REQUIRED_PERMISSION)) {
    issues.push({
      code: "missing_required_permission",
      message: `every role must include ${REQUIRED_PERMISSION}`,
      permission: REQUIRED_PERMISSION,
    });
  }
  for (const p of permissions) {
    if (!actorPermissions.has(p)) {
      issues.push({ code: "escalation", message: `you cannot grant ${p} because you do not hold it`, permission: p });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, role: { name, permissions, builtIn: false } };
}

/**
 * True when `actorPermissions` may assign `role` to someone: the actor needs
 * `members.manage` and must hold every permission the role grants.
 */
export function canAssignRole(
  actorPermissions: ReadonlySet<ProjectPermission>,
  role: Pick<ProjectRole, "permissions">,
): boolean {
  if (!actorPermissions.has("members.manage")) return false;
  for (const p of role.permissions) if (!actorPermissions.has(p)) return false;
  return true;
}
