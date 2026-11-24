import type { TwoFactorPolicy } from "./types/two-factor.js";

export function validateTwoFactorPolicy(value: unknown): value is TwoFactorPolicy {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "required" in value &&
    typeof value.required === "boolean"
  );
}
