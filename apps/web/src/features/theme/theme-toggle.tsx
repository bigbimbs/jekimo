import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { ToggleGroup } from "radix-ui";
import { useTranslation } from "react-i18next";
import { THEME_PREFERENCES } from "../../constants/theme";
import { cn } from "../../lib/utils";
import { useTheme } from "./theme";

const ICONS = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

export function ThemeToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  return (
    <ToggleGroup.Root
      type="single"
      value={preference}
      onValueChange={(value) => {
        const next = THEME_PREFERENCES.find((p) => p === value);
        if (next) setPreference(next);
      }}
      aria-label={t("theme.label")}
      className={cn("inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5", className)}
    >
      {THEME_PREFERENCES.map((p) => {
        const Icon = ICONS[p];
        return (
          <ToggleGroup.Item
            key={p}
            value={p}
            aria-label={t(`theme.${p}`)}
            title={t(`theme.${p}`)}
            className="inline-flex h-6 min-w-7 flex-1 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,box-shadow] duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-xs data-[state=on]:ring-1 data-[state=on]:ring-border"
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </ToggleGroup.Item>
        );
      })}
    </ToggleGroup.Root>
  );
}
