import { useTranslation } from "react-i18next";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

export function formatRelative(locale: string, iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === "second") return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(0, "second");
}

export function formatDateTime(locale: string, iso: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(iso));
}

export function formatNumber(locale: string, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

/** Intl formatters bound to the active locale. */
export function useFormat() {
  const { i18n } = useTranslation();
  const locale = i18n.language;
  return {
    relative: (iso: string) => formatRelative(locale, iso),
    dateTime: (iso: string) => formatDateTime(locale, iso),
    number: (value: number, options?: Intl.NumberFormatOptions) => formatNumber(locale, value, options),
  };
}
