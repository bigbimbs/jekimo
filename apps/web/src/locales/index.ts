import type { Locale, Namespace } from "../constants/i18n";
import admin from "./en/admin.json";
import audit from "./en/audit.json";
import auth from "./en/auth.json";
import common from "./en/common.json";
import cron from "./en/cron.json";
import dashboard from "./en/dashboard.json";
import database from "./en/database.json";
import errors from "./en/errors.json";
import events from "./en/events.json";
import issues from "./en/issues.json";
import members from "./en/members.json";
import notifications from "./en/notifications.json";
import security from "./en/security.json";
import settings from "./en/settings.json";
import traces from "./en/traces.json";

export const en = {
  cron,
  database,
  traces,
  notifications,
  admin,
  common,
  auth,
  issues,
  settings,
  members,
  security,
  audit,
  dashboard,
  events,
  errors,
};

export const resources: Record<Locale, Record<Namespace, object>> = { en };
