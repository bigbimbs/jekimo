import { timingSafeEqual } from "node:crypto";
import type { SessionRecord } from "@jekimo/storage-postgres";
import type { FastifyBaseLogger } from "fastify";
import { DAY_MS, LOCKOUT_ATTEMPTS, LOCKOUT_WINDOW_MS } from "../../constants/index.js";
import { ApiError } from "../../errors.js";
import { generateIngestionKey } from "../../keys.js";
import { TimingSafeVerifier } from "../../passwords.js";
import { hashSessionToken, newCsrfToken, newSessionToken } from "../../session.js";
import type { AuthServiceDeps, LoginInput, SetupInput } from "../../types/index.js";
import { newProjectId } from "../projects/service.js";

/** Holds the one-time setup token printed to the console. Cleared once setup succeeds. */
export class SetupGate {
  constructor(private token: string | null) {}

  get open(): boolean {
    return this.token !== null;
  }

  check(presented: unknown): boolean {
    if (this.token === null || typeof presented !== "string") return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  close(): void {
    this.token = null;
  }
}

// Once setup completes, the setup routes answer like any unknown route.
const setupGone = () => new ApiError(404, "not_found", "not found");

/** docs/access-model.md, "Setup flow", "Passwords", and "Sessions". */
export class AuthService {
  private readonly verifier: TimingSafeVerifier;

  constructor(private readonly deps: AuthServiceDeps) {
    this.verifier = new TimingSafeVerifier(deps.hasher);
  }

  /**
   * Throws a 404 unless the instance still has no users. Closes the gate for
   * good once a user exists, including one created through another API process.
   */
  async assertSetupOpen(): Promise<void> {
    if (!this.deps.setup.open) throw setupGone();
    if ((await this.deps.metadata.countUsers()) === 0) return;
    this.deps.setup.close();
    throw setupGone();
  }

  setupTokenMatches(presented: unknown): boolean {
    return this.deps.setup.check(presented);
  }

  /** Creates the first instance admin and the first project with its ingestion key. */
  async completeSetup(input: SetupInput, log: FastifyBaseLogger) {
    const { metadata } = this.deps;
    const user = await metadata.createFirstAdmin({
      email: input.email,
      passwordHash: await this.deps.hasher.hash(input.password),
    });
    this.deps.setup.close();
    if (!user) throw setupGone();
    log.info({ user_id: user.id }, "first instance admin created");

    const actor = { userId: user.id, instanceRole: user.instanceRole };
    const project = await metadata.createProject(actor, {
      id: newProjectId(),
      name: input.projectName,
      retentionDays: this.deps.retentionDefaultDays,
      sourceIp: input.sourceIp,
    });
    const access = await metadata.resolveProjectAccess(actor, project.id);
    if (!access) throw new Error("project created during setup is not accessible");
    const generated = generateIngestionKey();
    const key = await metadata.createIngestionKey(access, {
      keyId: generated.keyId,
      keyHash: generated.keyHash,
      name: "setup",
      sourceIp: input.sourceIp,
    });
    // key_id is safe to log; the key itself is returned once and never logged.
    log.info({ project_id: project.id, key_id: key.keyId }, "first project and ingestion key created");
    return { user, project, key, secret: generated.key };
  }

  async login(input: LoginInput) {
    const { metadata } = this.deps;
    const now = this.deps.clock();
    const found = await metadata.findUserForLogin(input.email);
    const valid = await this.verifier.verify(found?.passwordHash ?? null, input.password);
    const fail = new ApiError(401, "invalid_credentials", "email or password is incorrect");
    if (!found) throw fail;
    const user = found.user;
    const audit = { actorUserId: user.id, targetType: "user", targetId: user.id, sourceIp: input.sourceIp };
    // Lockout answers exactly like a wrong password.
    const recentFailures = await metadata.countFailedLogins(user.id, new Date(now.getTime() - LOCKOUT_WINDOW_MS));
    if (recentFailures >= LOCKOUT_ATTEMPTS) {
      await metadata.appendAudit({ ...audit, action: "auth.login_locked" });
      throw fail;
    }
    if (!valid || user.status !== "active") {
      await metadata.appendAudit({ ...audit, action: "auth.login_failed" });
      throw fail;
    }
    const token = newSessionToken();
    const csrfToken = newCsrfToken();
    await metadata.createSession({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      csrfToken,
      expiresAt: new Date(now.getTime() + this.deps.sessionMaxDays * DAY_MS),
      sourceIp: input.sourceIp,
      ...(input.userAgent !== undefined && { userAgent: input.userAgent }),
    });
    await metadata.appendAudit({ ...audit, action: "auth.login" });
    return { user, token, csrfToken };
  }

  async logout(session: SessionRecord, sourceIp: string): Promise<void> {
    await this.deps.metadata.revokeSession(session.sessionId, this.deps.clock());
    await this.deps.metadata.appendAudit({
      actorUserId: session.user.id,
      action: "auth.logout",
      targetType: "user",
      targetId: session.user.id,
      sourceIp,
    });
  }
}
