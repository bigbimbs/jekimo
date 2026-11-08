import { useTranslation } from "react-i18next";

export function Logo() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-2 text-[0.9375rem] font-semibold tracking-tight">
      <svg viewBox="0 0 32 32" className="size-6 drop-shadow-sm" aria-hidden="true">
        <rect width="32" height="32" rx="8" className="fill-foreground" />
        <path
          d="M19 8v11.5a4.5 4.5 0 0 1-9 0"
          fill="none"
          className="stroke-background"
          strokeWidth="3.2"
          strokeLinecap="round"
        />
      </svg>
      {t("appName")}
    </span>
  );
}
