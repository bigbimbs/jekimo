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
      className={cn("inline-flex items-center gap-0.5 rounded-md border border-border bg-background p-0.5", className)}
    >
      {THEME_PREFERENCES.map((p) => {
        const Icon = ICONS[p];
        return (
          <ToggleGroup.Item
            key={p}
            value={p}
            aria-label={t(`theme.${p}`)}
            title={t(`theme.${p}`)}
            className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-muted data-[state=on]:text-foreground"
          >
            <Icon className="size-4" aria-hidden="true" />
          </ToggleGroup.Item>
        );
      })}
    </ToggleGroup.Root>
  );
}
