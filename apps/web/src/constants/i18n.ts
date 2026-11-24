export const SUPPORTED_LOCALES = ["en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const NAMESPACES = [
  "admin",
  "notifications",
  "cron",
  "database",
  "traces",
  "common",
  "auth",
  "issues",
  "settings",
  "members",
  "security",
  "audit",
  "dashboard",
  "events",
  "errors",
] as const;
export type Namespace = (typeof NAMESPACES)[number];
