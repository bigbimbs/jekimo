export const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TWO_FACTOR = {
  periodSeconds: 30,
  digits: 6,
  enrollmentMs: 10 * 60_000,
  recoveryCount: 8,
  issuer: "Jekimo",
} as const;

export const ENROLLMENT_ROUTES = new Set([
  "/api/v1/auth/session",
  "/api/v1/auth/logout",
  "/api/v1/auth/two-factor",
  "/api/v1/auth/two-factor/setup",
  "/api/v1/auth/two-factor/enable",
]);
