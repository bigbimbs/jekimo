import { type ReactNode, useEffect, useMemo, useState } from "react";
import { DARK_SCHEME_QUERY, type ThemePreference } from "../../constants/theme";
import { applyTheme, readPreference, storePreference, systemPrefersDark, ThemeContext } from "./theme";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const media = window.matchMedia(DARK_SCHEME_QUERY);
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const resolved = preference === "system" ? (systemDark ? "dark" : "light") : preference;

  useEffect(() => applyTheme(resolved), [resolved]);

  const value = useMemo(
    () => ({
      preference,
      resolved,
      setPreference(next: ThemePreference) {
        storePreference(next);
        setPreference(next);
      },
    }),
    [preference, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
