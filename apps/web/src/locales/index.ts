import type { Locale, Namespace } from "../constants/i18n";
import auth from "./en/auth.json";
import common from "./en/common.json";
import errors from "./en/errors.json";
import issues from "./en/issues.json";
import settings from "./en/settings.json";

export const en = { common, auth, issues, settings, errors };

export const resources: Record<Locale, Record<Namespace, object>> = { en };
