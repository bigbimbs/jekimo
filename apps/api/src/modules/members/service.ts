// The no-escalation and last-admin rules (docs/access-model.md, "Membership
// rules") are enforced by the storage layer in the same transaction as the
// change, not here, so concurrent requests cannot both pass them.

import type { ProjectAccess } from "@jekimo/storage-postgres";
import { ApiError } from "../../errors.js";
import type { MemberServiceDeps, MemberTarget } from "../../types/index.js";

const ERRORS = {
  user_not_found: () => new ApiError(404, "user_not_found", "no user with that email or id"),
  already_member: () => new ApiError(409, "already_member", "the user is already a member of this project"),
  unknown_role: () => new ApiError(400, "unknown_role", "no role with that name in this project"),
  escalation: () =>
    new ApiError(403, "role_escalation", "you can only assign or change roles whose permissions you hold yourself"),
  not_member: () => new ApiError(404, "member_not_found", "the user is not a member of this project"),
  last_admin: () =>
    new ApiError(
      409,
      "last_admin",
      "a project must keep at least one admin; an instance admin can override this with force=true",
    ),
} as const;

export class MemberService {
  constructor(private readonly deps: MemberServiceDeps) {}

  listRoles(access: ProjectAccess) {
    return this.deps.metadata.listRoles(access);
  }

  listMembers(access: ProjectAccess) {
    return this.deps.metadata.listMembers(access);
  }

  async add(access: ProjectAccess, target: MemberTarget, role: string, sourceIp: string) {
    let userId: string;
    if ("userId" in target) {
      userId = target.userId;
    } else {
      const user = await this.deps.metadata.findUserByEmail(target.email);
      if (!user) throw ERRORS.user_not_found();
      userId = user.id;
    }
    const result = await this.deps.metadata.addMember(access, { userId, role, sourceIp });
    if (!result.ok) throw ERRORS[result.reason]();
    return result.member;
  }

  async changeRole(access: ProjectAccess, userId: string, role: string, force: boolean, sourceIp: string) {
    const result = await this.deps.metadata.changeMemberRole(access, { userId, role, force, sourceIp });
    if (!result.ok) throw ERRORS[result.reason]();
    return result.member;
  }

  async remove(access: ProjectAccess, userId: string, force: boolean, sourceIp: string): Promise<void> {
    const result = await this.deps.metadata.removeMember(access, { userId, force, sourceIp });
    if (!result.ok) throw ERRORS[result.reason]();
  }
}
