import type { AuditAction } from "../constants/audit.js";
import type { Actor } from "./access.js";

export interface TwoFactorState {
  version: string | null;
  secret: string | null;
  pendingSecret: string | null;
  pendingExpires: number;
  lastStep: number;
  recoveryHashes: string[];
  failures: number;
  failureWindow: number;
}

export interface FactorProof {
  step: number | null;
  recoveryHash: string | null;
}

export type TwoFactorMutation = {
  userId: string;
  now: Date;
  sourceIp?: string;
  sessionId?: string;
  passwordHash?: string;
} & (
  | { kind: "begin"; secret: string; version: string; expires: number }
  | { kind: "enable"; version: string; proof: FactorProof; recoveryHashes: string[] }
  | { kind: "verify" | "disable"; version: string; proof: FactorProof }
  | { kind: "regenerate"; version: string; proof: FactorProof; recoveryHashes: string[] }
  | { kind: "reset" }
);

export type TwoFactorResult =
  | { ok: true; version: string | null; usedRecovery: boolean }
  | { ok: false; reason: "invalid" | "locked" | "required" | "enabled" | "expired" };

export interface FactorTransition {
  state: TwoFactorState;
  result: TwoFactorResult;
  action?: AuditAction;
}

export interface TwoFactorRepository {
  getTwoFactor(userId: string): Promise<TwoFactorState>;
  isTwoFactorRequired(): Promise<boolean>;
  /** Serializes proof consumption, enrollment, recovery codes, and session invalidation per user. */
  mutateTwoFactor(input: TwoFactorMutation): Promise<TwoFactorResult>;
  /** Requires an active instance admin with an enrolled, verified session. */
  setTwoFactorRequired(
    actor: Actor,
    required: boolean,
    sessionId: string,
    now: Date,
    sourceIp?: string,
  ): Promise<boolean>;
}
