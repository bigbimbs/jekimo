export const ACCOUNT_LINK_KINDS = ["invite", "reset-password"] as const;
export type AccountLinkKind = (typeof ACCOUNT_LINK_KINDS)[number];

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MAX_EMAIL_CHARS = 254;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PASSWORD_MIN_CHARS = 12;
export const PASSWORD_MAX_CHARS = 128;

export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_ATTEMPTS = 10;

export const DEFAULT_AUDIT_LIMIT = 100;
export const MAX_AUDIT_LIMIT = 500;
