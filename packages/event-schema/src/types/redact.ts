export interface RedactOptions {
  /** Extra key names, compared with normalizeKey like the defaults. */
  extraKeys?: readonly string[];
  /** Regular expressions tested against the original key name. */
  patterns?: readonly RegExp[];
  dropContext?: boolean;
}

export type KeyRedactor = (key: string) => boolean;
