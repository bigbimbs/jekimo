import type { en } from "../locales";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof en;
  }
}
