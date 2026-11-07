import type { ProjectPermission } from "../constants/permissions.js";

export interface ProjectRole {
  name: string;
  permissions: ReadonlySet<ProjectPermission>;
  /** True for admin, member, and viewer; they cannot be edited or deleted. */
  builtIn: boolean;
}

export type RoleIssueCode =
  | "name_empty"
  | "name_too_long"
  | "name_reserved"
  | "unknown_permission"
  | "missing_required_permission"
  | "escalation";

export interface RoleIssue {
  code: RoleIssueCode;
  message: string;
  /** The permission concerned, for permission-related codes. */
  permission?: string;
}

export type RoleValidation = { ok: true; role: ProjectRole } | { ok: false; issues: RoleIssue[] };
