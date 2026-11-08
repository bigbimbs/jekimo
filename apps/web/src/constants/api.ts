export const API_BASE = "/api/v1";
export const CSRF_HEADER = "x-jekimo-csrf-token";

/** Error codes the dashboard has messages for; any other code shows the API's English message. */
export const KNOWN_ERROR_CODES = [
  "already_member",
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
  "network",
  "not_found",
  "role_escalation",
  "unauthorized",
  "weak_password",
] as const;
export type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number];
