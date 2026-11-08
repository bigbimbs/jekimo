import { createContext, useContext } from "react";
import { DARK_SCHEME_QUERY, THEME_PREFERENCES, THEME_STORAGE_KEY, type ThemePreference } from "../../constants/theme";
import type { ThemeState } from "../../types/theme";

export const ThemeContext = createContext<ThemeState | null>(null);

export function useTheme(): ThemeState {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme needs a ThemeProvider");
  return theme;
}

export function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_PREFERENCES.find((p) => p === stored) ?? "system";
  } catch {
    return "system";
  }
}

export function storePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage can be blocked; the choice then lasts for this page only.
  }
}

export function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_SCHEME_QUERY).matches;
}

export function applyTheme(resolved: "light" | "dark"): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}
