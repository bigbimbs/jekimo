import i18next, { type i18n } from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import { DEFAULT_LOCALE, type Locale, NAMESPACES, SUPPORTED_LOCALES } from "../constants/i18n";
import { resources } from "../locales";

/** docs/architecture.md, "Translation": browser languages, then their base language, then English. */
export function resolveLocale(languages: readonly string[]): Locale {
  for (const tag of languages) {
    const candidates = [tag, tag.split("-")[0] ?? tag];
    const match = SUPPORTED_LOCALES.find((l) => candidates.some((c) => c.toLowerCase() === l));
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

export function createI18n(languages: readonly string[] = navigator.languages): i18n {
  const instance = i18next.createInstance();
  instance
    .use(ICU)
    .use(initReactI18next)
    .init({
      lng: resolveLocale(languages),
      fallbackLng: DEFAULT_LOCALE,
      supportedLngs: [...SUPPORTED_LOCALES],
      resources,
      ns: [...NAMESPACES],
      defaultNS: "common",
      initAsync: false,
      interpolation: { escapeValue: false },
    });
  return instance;
}

export function applyDocumentLocale(instance: i18n): void {
  document.documentElement.lang = instance.language;
  document.documentElement.dir = instance.dir(instance.language);
  document.title = instance.t("common:appName");
}
