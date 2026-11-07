import type { Actor, InstanceRole } from "@jekimo/storage-postgres";
import { accountLink, newAccountToken } from "../../account-links.js";
import { DAY_MS } from "../../constants/index.js";
import { ApiError } from "../../errors.js";
import type { AuditFilter, UserChange, UserServiceDeps } from "../../types/index.js";

const userNotFound = () => new ApiError(404, "user_not_found", "user not found");

export class UserService {
  constructor(private readonly deps: UserServiceDeps) {}

  private linkExpiry(): Date {
    return new Date(this.deps.clock().getTime() + this.deps.inviteExpiryDays * DAY_MS);
  }

  listUsers(actor: Actor) {
    return this.deps.metadata.listUsers(actor);
  }

  async updateUser(actor: Actor, userId: string, change: UserChange, sourceIp: string) {
    const result = await this.deps.metadata.updateUser(actor, userId, change, {
      now: this.deps.clock(),
      sourceIp,
    });
    if (!result.ok) {
      if (result.reason === "last_admin")
        throw new ApiError(409, "last_admin", "an instance must keep at least one active admin");
      throw userNotFound();
    }
    return result.user;
  }

  revokeSessions(actor: Actor, userId: string, sourceIp: string): Promise<number> {
    return this.deps.metadata.revokeUserSessions(actor, userId, { now: this.deps.clock(), sourceIp });
  }

  /** The token is returned once, inside the link; only its hash is stored. */
  async createPasswordReset(actor: Actor, userId: string, sourceIp: string) {
    const { token, tokenHash } = newAccountToken();
    const result = await this.deps.metadata.createPasswordReset(actor, {
      userId,
      tokenHash,
      expiresAt: this.linkExpiry(),
      sourceIp,
    });
    if (!result.ok) throw userNotFound();
    return { reset: result.reset, token, link: accountLink(this.deps.publicUrl, "reset-password", token) };
  }

  /** The token is returned once, inside the link; only its hash is stored. */
  async invite(actor: Actor, email: string, instanceRole: InstanceRole, sourceIp: string) {
    const { token, tokenHash } = newAccountToken();
    const result = await this.deps.metadata.createInvitation(actor, {
      email,
      instanceRole,
      tokenHash,
      expiresAt: this.linkExpiry(),
      sourceIp,
    });
    if (!result.ok) throw new ApiError(409, "email_taken", "an account with this email already exists");
    return { invitation: result.invitation, token, link: accountLink(this.deps.publicUrl, "invite", token) };
  }

  listInvitations(actor: Actor) {
    return this.deps.metadata.listInvitations(actor, this.deps.clock());
  }

  async revokeInvitation(actor: Actor, invitationId: string, sourceIp: string): Promise<void> {
    const revoked = await this.deps.metadata.revokeInvitation(actor, invitationId, {
      now: this.deps.clock(),
      sourceIp,
    });
    if (!revoked) throw new ApiError(404, "not_found", "invitation not found");
  }

  /** `nextCursor` is set when more entries match. */
  async auditPage(actor: Actor, filter: AuditFilter, limit: number) {
    const entries = await this.deps.metadata.listAudit(actor, { ...filter, limit: limit + 1 });
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return { entries: page, nextCursor: entries.length > limit && last ? last.id : undefined };
  }
}
