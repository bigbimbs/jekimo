import { FACTOR_LIMITS } from "./constants/two-factor.js";
import type { FactorTransition, TwoFactorMutation, TwoFactorState } from "./types/two-factor.js";

export function emptyTwoFactor(): TwoFactorState {
  return {
    version: null,
    secret: null,
    pendingSecret: null,
    pendingExpires: 0,
    lastStep: -1,
    recoveryHashes: [],
    failures: 0,
    failureWindow: 0,
  };
}

/** Runs under the user's row lock; no two requests can consume the same proof. */
export function transitionFactor(
  current: TwoFactorState,
  input: TwoFactorMutation,
  required: boolean,
): FactorTransition {
  const state = structuredClone(current);
  const fail = (reason: "invalid" | "locked" | "required" | "enabled" | "expired"): FactorTransition => ({
    state,
    result: { ok: false, reason },
  });
  const success = (action: FactorTransition["action"], usedRecovery = false): FactorTransition => ({
    state,
    result: { ok: true, version: state.version, usedRecovery },
    ...(action && { action }),
  });
  if (input.kind === "reset")
    return {
      state: emptyTwoFactor(),
      result: { ok: true, version: null, usedRecovery: false },
      action: "auth.two_factor_reset",
    };
  if (input.kind === "begin") {
    if (state.secret) return fail("enabled");
    state.version = input.version;
    state.pendingSecret = input.secret;
    state.pendingExpires = input.expires;
    return success("auth.two_factor_setup_started");
  }
  if (input.kind === "disable" && required) return fail("required");
  if (state.version !== input.version) return fail("invalid");
  if (input.kind === "enable" && (state.secret || !state.pendingSecret || state.pendingExpires <= input.now.getTime()))
    return fail("expired");
  if (input.kind !== "enable" && !state.secret) return fail("invalid");
  if (input.now.getTime() - state.failureWindow >= FACTOR_LIMITS.windowMs) {
    state.failureWindow = input.now.getTime();
    state.failures = 0;
  }
  if (state.failures >= FACTOR_LIMITS.attempts) return fail("locked");
  const { step, recoveryHash } = input.proof;
  const validStep = step !== null && Number.isSafeInteger(step) && step > state.lastStep;
  const usedRecovery = input.kind !== "enable" && recoveryHash !== null && state.recoveryHashes.includes(recoveryHash);
  if (!validStep && !usedRecovery) {
    state.failures++;
    return { ...fail("invalid"), action: "auth.two_factor_failed" };
  }
  if (validStep) state.lastStep = step;
  if (usedRecovery) state.recoveryHashes = state.recoveryHashes.filter((h) => h !== recoveryHash);
  state.failures = 0;
  if (input.kind === "enable") {
    state.secret = state.pendingSecret;
    state.pendingSecret = null;
    state.pendingExpires = 0;
    state.recoveryHashes = input.recoveryHashes;
    return success("auth.two_factor_enabled");
  }
  if (input.kind === "disable")
    return {
      state: emptyTwoFactor(),
      result: { ok: true, version: null, usedRecovery },
      action: "auth.two_factor_disabled",
    };
  if (input.kind === "regenerate") {
    state.recoveryHashes = input.recoveryHashes;
    return success("auth.recovery_codes_regenerated", usedRecovery);
  }
  return success(usedRecovery ? "auth.recovery_code_used" : "auth.two_factor_verified", usedRecovery);
}
