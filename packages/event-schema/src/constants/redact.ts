/**
 * Attribute and context keys that SDKs redact by default, compared
 * case-insensitively after removing `-`, `_`, and spaces. The value is replaced with
 * `[REDACTED]` before the event leaves the application process.
 * Normative text: docs/event-format.md, "Privacy defaults".
 */
export const DEFAULT_REDACTED_KEYS: readonly string[] = [
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "clientsecret",
  "sessionid",
  "creditcard",
  "cardnumber",
  "cvv",
  "ssn",
];

export const REDACTED_VALUE = "[REDACTED]";
