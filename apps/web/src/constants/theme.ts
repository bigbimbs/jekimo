export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** Also read by public/theme.js before the first paint. */
export const THEME_STORAGE_KEY = "jekimo.theme";
export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";
