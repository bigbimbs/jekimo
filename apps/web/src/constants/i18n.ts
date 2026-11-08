export const SUPPORTED_LOCALES = ["en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const NAMESPACES = ["common", "auth", "issues", "settings", "errors"] as const;
export type Namespace = (typeof NAMESPACES)[number];
