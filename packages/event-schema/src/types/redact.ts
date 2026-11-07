export interface RedactOptions {
  /** Extra key names, compared with normalizeKey like the defaults. */
  extraKeys?: readonly string[];
  /** Regular expressions tested against the original key name. */
  patterns?: readonly RegExp[];
  /** When true, drop `context` entirely. */
  dropContext?: boolean;
}

/** True when the value under this key must be replaced. */
export type KeyRedactor = (key: string) => boolean;
