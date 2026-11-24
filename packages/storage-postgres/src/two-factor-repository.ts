import { PostgresAccessRepository } from "./access-repository.js";
import { withTransaction } from "./pool.js";
import { insertAudit } from "./sql-shared.js";
import { emptyTwoFactor, transitionFactor } from "./two-factor-state.js";
import type { Actor } from "./types/access.js";
import type { TwoFactorMutation, TwoFactorRepository, TwoFactorResult, TwoFactorState } from "./types/two-factor.js";

export class PostgresTwoFactorRepository extends PostgresAccessRepository implements TwoFactorRepository {
  async getTwoFactor(userId: string): Promise<TwoFactorState> {
    const { rows } = await this.pool.query<{ state: TwoFactorState }>(
      "SELECT state FROM user_two_factor WHERE user_id = $1",
      [userId],
    );
    return rows[0]?.state ?? emptyTwoFactor();
  }

  async isTwoFactorRequired(): Promise<boolean> {
    const { rows } = await this.pool.query<{ two_factor_required: boolean }>(
      "SELECT two_factor_required FROM instance_security WHERE id = true",
    );
    if (!rows[0]) throw new Error("instance security settings missing");
    return rows[0].two_factor_required;
  }

  mutateTwoFactor(input: TwoFactorMutation): Promise<TwoFactorResult> {
    return withTransaction(this.pool, async (client) => {
      // Shared lock prevents a disable from racing an administrator enabling enforcement.
      const policy = await client.query<{ two_factor_required: boolean }>(
        "SELECT two_factor_required FROM instance_security WHERE id = true FOR SHARE",
      );
      if (!policy.rows[0]) throw new Error("instance security settings missing");
      const user = await client.query<{ status: string; password_hash: string }>(
        "SELECT status, password_hash FROM users WHERE id = $1 FOR UPDATE",
        [input.userId],
      );
      if (
        !user.rows[0] ||
        (input.kind !== "reset" && user.rows[0].status !== "active") ||
        (input.passwordHash !== undefined && user.rows[0].password_hash !== input.passwordHash)
      )
        return { ok: false, reason: "invalid" };
      if (input.kind !== "verify" && input.kind !== "reset" && !input.sessionId)
        return { ok: false, reason: "invalid" };
      if (input.sessionId) {
        const session = await client.query(
          "SELECT id FROM sessions WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > $3",
          [input.sessionId, input.userId, input.now],
        );
        if (!session.rows[0]) return { ok: false, reason: "invalid" };
      }
      const { rows } = await client.query<{ state: TwoFactorState }>(
        "SELECT state FROM user_two_factor WHERE user_id = $1",
        [input.userId],
      );
      const next = transitionFactor(rows[0]?.state ?? emptyTwoFactor(), input, policy.rows[0].two_factor_required);
      await client.query(
        "INSERT INTO user_two_factor (user_id, state) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state",
        [input.userId, JSON.stringify(next.state)],
      );
      if (next.result.ok && ["enable", "disable", "reset", "regenerate"].includes(input.kind)) {
        await client.query(
          "UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3)",
          [input.userId, input.now, input.sessionId ?? null],
        );
        if (input.sessionId)
          await client.query("UPDATE sessions SET two_factor_version = $2 WHERE id = $1", [
            input.sessionId,
            next.state.secret ? next.state.version : null,
          ]);
      }
      if (next.action)
        await insertAudit(client, {
          actorUserId: input.kind === "reset" ? null : input.userId,
          targetType: "user",
          targetId: input.userId,
          action: next.action,
          ...(input.sourceIp && { sourceIp: input.sourceIp }),
        });
      return next.result;
    });
  }

  setTwoFactorRequired(
    actor: Actor,
    required: boolean,
    sessionId: string,
    now: Date,
    sourceIp?: string,
  ): Promise<boolean> {
    if (actor.instanceRole !== "admin") throw new Error("instance admin required");
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT id FROM instance_security WHERE id = true FOR UPDATE");
      const user = await client.query<{ instance_role: string; status: string }>(
        "SELECT instance_role, status FROM users WHERE id = $1 FOR UPDATE",
        [actor.userId],
      );
      if (user.rows[0]?.instance_role !== "admin" || user.rows[0].status !== "active") return false;
      const { rows } = await client.query(
        `SELECT s.id FROM sessions s JOIN user_two_factor f ON f.user_id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > $3
        AND f.state->>'secret' IS NOT NULL AND s.two_factor_version::text = f.state->>'version'`,
        [sessionId, actor.userId, now],
      );
      if (!rows[0]) return false;
      await client.query("UPDATE instance_security SET two_factor_required = $1 WHERE id = true", [required]);
      await insertAudit(client, {
        actorUserId: actor.userId,
        targetType: "instance",
        targetId: "instance",
        action: "instance.settings_updated",
        details: { two_factor_required: required },
        ...(sourceIp && { sourceIp }),
      });
      return true;
    });
  }
}
