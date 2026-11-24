import { randomUUID } from "node:crypto";
import type { FactorProof, SessionRecord, TwoFactorResult, TwoFactorState } from "@jekimo/storage-postgres";
import { LOCKOUT_ATTEMPTS, LOCKOUT_WINDOW_MS } from "../../constants/index.js";
import { TWO_FACTOR } from "../../constants/two-factor.js";
import { ApiError } from "../../errors.js";
import {
  authenticatorUri,
  decryptFactor,
  encryptFactor,
  newAuthenticatorSecret,
  newRecoveryCodes,
  recoveryHash,
  verifyTotp,
} from "../../two-factor.js";
import type { TwoFactorServiceDeps } from "../../types/two-factor.js";

export class TwoFactorService {
  constructor(private readonly deps: TwoFactorServiceDeps) {}

  private key(): string {
    if (!this.deps.encryptionKey)
      throw new ApiError(503, "two_factor_unavailable", "two-factor authentication is not configured on this server");
    return this.deps.encryptionKey;
  }

  async status(userId: string) {
    const [state, required] = await Promise.all([
      this.deps.metadata.getTwoFactor(userId),
      this.deps.metadata.isTwoFactorRequired(),
    ]);
    return {
      enabled: state.secret !== null,
      required,
      configured: this.deps.encryptionKey !== null,
      recovery_codes_remaining: state.recoveryHashes.length,
    };
  }

  async password(session: SessionRecord, password: string, sourceIp: string): Promise<string> {
    const { metadata, clock } = this.deps;
    const found = await metadata.findUserForLogin(session.user.email);
    const failures = await metadata.countFailedLogins(session.user.id, new Date(clock().getTime() - LOCKOUT_WINDOW_MS));
    if (failures >= LOCKOUT_ATTEMPTS || !found || !(await this.deps.hasher.verify(found.passwordHash, password))) {
      await metadata.appendAudit({
        actorUserId: session.user.id,
        targetType: "user",
        targetId: session.user.id,
        action: "auth.login_failed",
        sourceIp,
      });
      throw new ApiError(403, "invalid_credentials", "the current password is incorrect");
    }
    return found.passwordHash;
  }

  private proof(state: TwoFactorState, code: string, userId: string, pending = false): FactorProof {
    const encrypted = pending ? state.pendingSecret : state.secret;
    let step: number | null = null;
    if (encrypted) {
      try {
        step = verifyTotp(decryptFactor(encrypted, this.key(), userId), code.trim(), this.deps.clock());
      } catch {
        throw new ApiError(
          503,
          "two_factor_unavailable",
          "the authenticator could not be read; contact the instance operator",
        );
      }
    }
    return { step, recoveryHash: pending ? null : recoveryHash(code.trim(), userId) };
  }

  private check(result: TwoFactorResult): asserts result is Extract<TwoFactorResult, { ok: true }> {
    if (result.ok) return;
    if (result.reason === "locked")
      throw new ApiError(429, "two_factor_locked", "too many attempts; try again in 15 minutes");
    if (result.reason === "required")
      throw new ApiError(
        409,
        "two_factor_required_by_admin",
        "two-factor authentication is required by the instance admin",
      );
    if (result.reason === "enabled")
      throw new ApiError(409, "two_factor_already_enabled", "two-factor authentication is already enabled");
    if (result.reason === "expired")
      throw new ApiError(400, "two_factor_setup_expired", "start authenticator setup again");
    throw new ApiError(400, "invalid_two_factor_code", "the code is invalid or has already been used");
  }

  async verifyLogin(
    userId: string,
    passwordHash: string,
    code: string | undefined,
    sourceIp: string,
  ): Promise<string | null> {
    const state = await this.deps.metadata.getTwoFactor(userId);
    if (!state.secret) return null;
    this.key();
    if (!code) throw new ApiError(401, "two_factor_required", "enter your authenticator or recovery code");
    const result = await this.deps.metadata.mutateTwoFactor({
      kind: "verify",
      userId,
      passwordHash,
      version: state.version as string,
      proof: this.proof(state, code, userId),
      now: this.deps.clock(),
      sourceIp,
    });
    this.check(result);
    return result.version;
  }

  async begin(session: SessionRecord, password: string, sourceIp: string) {
    const key = this.key();
    const passwordHash = await this.password(session, password, sourceIp);
    const secret = newAuthenticatorSecret();
    const expires = this.deps.clock().getTime() + TWO_FACTOR.enrollmentMs;
    const result = await this.deps.metadata.mutateTwoFactor({
      kind: "begin",
      userId: session.user.id,
      sessionId: session.sessionId,
      passwordHash,
      now: this.deps.clock(),
      sourceIp,
      secret: encryptFactor(secret, key, session.user.id),
      version: randomUUID(),
      expires,
    });
    this.check(result);
    return {
      secret,
      otpauth_uri: authenticatorUri(secret, session.user.email),
      expires_at: new Date(expires).toISOString(),
    };
  }

  async enable(session: SessionRecord, code: string, sourceIp: string) {
    const state = await this.deps.metadata.getTwoFactor(session.user.id);
    const recovery = newRecoveryCodes(session.user.id);
    const result = await this.deps.metadata.mutateTwoFactor({
      kind: "enable",
      userId: session.user.id,
      sessionId: session.sessionId,
      now: this.deps.clock(),
      sourceIp,
      version: state.version ?? "",
      proof: this.proof(state, code, session.user.id, true),
      recoveryHashes: recovery.hashes,
    });
    this.check(result);
    return { recovery_codes: recovery.codes };
  }

  async manage(
    session: SessionRecord,
    password: string,
    code: string,
    kind: "disable" | "regenerate" | "verify",
    sourceIp: string,
  ) {
    const passwordHash = await this.password(session, password, sourceIp);
    const state = await this.deps.metadata.getTwoFactor(session.user.id);
    const recovery = newRecoveryCodes(session.user.id);
    const result = await this.deps.metadata.mutateTwoFactor({
      kind,
      userId: session.user.id,
      sessionId: session.sessionId,
      passwordHash,
      now: this.deps.clock(),
      sourceIp,
      version: state.version ?? "",
      proof: this.proof(state, code, session.user.id),
      recoveryHashes: recovery.hashes,
    });
    this.check(result);
    return { recovery_codes: kind === "regenerate" ? recovery.codes : [] };
  }

  async policy() {
    return { required: await this.deps.metadata.isTwoFactorRequired() };
  }

  async setPolicy(session: SessionRecord, required: boolean, password: string, code: string, sourceIp: string) {
    this.key();
    await this.manage(session, password, code, "verify", sourceIp);
    const ok = await this.deps.metadata.setTwoFactorRequired(
      { userId: session.user.id, instanceRole: session.user.instanceRole },
      required,
      session.sessionId,
      this.deps.clock(),
      sourceIp,
    );
    if (!ok) throw new ApiError(403, "forbidden", "an enrolled instance admin session is required");
    return { required };
  }
}
