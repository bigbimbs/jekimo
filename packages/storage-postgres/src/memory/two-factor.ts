import { emptyTwoFactor, transitionFactor } from "../two-factor-state.js";
import type { Actor } from "../types/access.js";
import type { TwoFactorMutation, TwoFactorRepository, TwoFactorResult, TwoFactorState } from "../types/two-factor.js";
import { MemoryAccessRepository } from "./access.js";

export class MemoryTwoFactorRepository extends MemoryAccessRepository implements TwoFactorRepository {
  readonly factors = new Map<string, TwoFactorState>();
  private factorRequired = false;

  async getTwoFactor(userId: string): Promise<TwoFactorState> {
    return structuredClone(this.factors.get(userId) ?? emptyTwoFactor());
  }

  async isTwoFactorRequired(): Promise<boolean> {
    return this.factorRequired;
  }

  async mutateTwoFactor(input: TwoFactorMutation): Promise<TwoFactorResult> {
    const user = this.users.find((u) => u.id === input.userId);
    if (
      !user ||
      (input.kind !== "reset" && user.status !== "active") ||
      (input.passwordHash !== undefined && user.passwordHash !== input.passwordHash)
    )
      return { ok: false, reason: "invalid" };
    if (input.kind !== "verify" && input.kind !== "reset" && !input.sessionId) return { ok: false, reason: "invalid" };
    const session = this.sessions.find(
      (s) => s.id === input.sessionId && s.userId === input.userId && s.revokedAt === null && s.expiresAt > input.now,
    );
    if (input.sessionId && !session) return { ok: false, reason: "invalid" };
    const next = transitionFactor(this.factors.get(input.userId) ?? emptyTwoFactor(), input, this.factorRequired);
    this.factors.set(input.userId, next.state);
    if (next.result.ok && ["enable", "disable", "reset", "regenerate"].includes(input.kind)) {
      for (const s of this.sessions)
        if (s.userId === input.userId && s.id !== input.sessionId && s.revokedAt === null) s.revokedAt = input.now;
      if (session) session.twoFactorVersion = next.state.secret ? next.state.version : null;
    }
    if (next.action)
      await this.appendAudit({
        actorUserId: input.kind === "reset" ? null : input.userId,
        targetType: "user",
        targetId: input.userId,
        action: next.action,
        ...(input.sourceIp && { sourceIp: input.sourceIp }),
      });
    return next.result;
  }

  async setTwoFactorRequired(
    actor: Actor,
    required: boolean,
    sessionId: string,
    now: Date,
    sourceIp?: string,
  ): Promise<boolean> {
    if (actor.instanceRole !== "admin") throw new Error("instance admin required");
    const user = this.users.find((u) => u.id === actor.userId);
    const factor = this.factors.get(actor.userId);
    const session = this.sessions.find(
      (s) => s.id === sessionId && s.userId === actor.userId && s.revokedAt === null && s.expiresAt > now,
    );
    if (
      user?.instanceRole !== "admin" ||
      user.status !== "active" ||
      !factor?.secret ||
      session?.twoFactorVersion !== factor.version
    )
      return false;
    this.factorRequired = required;
    await this.appendAudit({
      actorUserId: actor.userId,
      targetType: "instance",
      targetId: "instance",
      action: "instance.settings_updated",
      details: { two_factor_required: required },
      ...(sourceIp && { sourceIp }),
    });
    return true;
  }
}
