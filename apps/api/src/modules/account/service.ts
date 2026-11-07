import type { SessionRecord } from "@jekimo/storage-postgres";
import { hashAccountToken, readAccountToken } from "../../account-links.js";
import { ApiError } from "../../errors.js";
import type { AccountServiceDeps } from "../../types/index.js";

const invalidToken = () =>
  new ApiError(400, "invalid_token", "this link is not valid, has expired, or was already used");

export class AccountService {
  constructor(private readonly deps: AccountServiceDeps) {}

  /** Signs out the user's other sessions; the current one stays. */
  async changePassword(
    session: SessionRecord,
    currentPassword: string,
    newPassword: string,
    sourceIp: string,
  ): Promise<void> {
    const found = await this.deps.metadata.findUserForLogin(session.user.email);
    if (!found || !(await this.deps.hasher.verify(found.passwordHash, currentPassword))) {
      throw new ApiError(403, "invalid_credentials", "the current password is incorrect");
    }
    await this.deps.metadata.changePassword(session.user.id, await this.deps.hasher.hash(newPassword), {
      now: this.deps.clock(),
      keepSessionId: session.sessionId,
      sourceIp,
    });
  }

  listSessions(userId: string) {
    return this.deps.metadata.listSessions(userId, this.deps.clock());
  }

  async revokeOwnSession(userId: string, sessionId: string, sourceIp: string): Promise<void> {
    const revoked = await this.deps.metadata.revokeOwnSession(userId, sessionId, {
      now: this.deps.clock(),
      sourceIp,
    });
    if (!revoked) throw new ApiError(404, "not_found", "session not found");
  }

  /** The token from an invitation or reset link; a malformed one answers like an expired one. */
  readToken(value: unknown): string {
    const token = readAccountToken(value);
    if (token === null) throw invalidToken();
    return token;
  }

  async acceptInvitation(token: string, password: string, sourceIp: string) {
    const result = await this.deps.metadata.acceptInvitation(
      hashAccountToken(token),
      await this.deps.hasher.hash(password),
      { now: this.deps.clock(), sourceIp },
    );
    if (!result.ok) {
      if (result.reason === "email_taken")
        throw new ApiError(409, "email_taken", "an account with this email already exists");
      throw invalidToken();
    }
    return result.user;
  }

  async resetPassword(token: string, password: string, sourceIp: string) {
    const result = await this.deps.metadata.resetPassword(
      hashAccountToken(token),
      await this.deps.hasher.hash(password),
      { now: this.deps.clock(), sourceIp },
    );
    if (!result.ok) throw invalidToken();
    return result.user;
  }
}
