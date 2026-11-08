import type { ThemePreference } from "../constants/theme";

export interface ThemeState {
  preference: ThemePreference;
  resolved: "light" | "dark";
  setPreference(preference: ThemePreference): void;
}
