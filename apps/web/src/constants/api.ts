export const API_BASE = "/api/v1";
export const CSRF_HEADER = "x-jekimo-csrf-token";

/** Error codes the dashboard has messages for; any other code shows the API's English message. */
export const KNOWN_ERROR_CODES = [
  "already_member",
  "two_factor_required",
  "two_factor_enrollment_required",
  "two_factor_required_by_admin",
  "two_factor_unavailable",
  "two_factor_already_enabled",
  "two_factor_setup_expired",
  "two_factor_locked",
  "invalid_two_factor_code",

  "csrf_failed",
  "email_taken",
  "forbidden",
  "internal",
  "invalid_credentials",
  "invalid_json",
  "invalid_request",
  "invalid_token",
  "key_already_revoked",
  "key_not_active",
  "key_not_found",
  "last_admin",
  "member_not_found",
  "unknown_role",
  "user_not_found",
  "network",
  "not_found",
  "role_escalation",
  "unauthorized",
  "weak_password",
] as const;
export type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number];
