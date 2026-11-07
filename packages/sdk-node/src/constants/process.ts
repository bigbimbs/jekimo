export const UNHANDLED_REJECTIONS_MODES = ["throw", "strict", "warn", "none", "warn-with-error-code"] as const;
export type UnhandledRejectionsMode = (typeof UNHANDLED_REJECTIONS_MODES)[number];

export const DEFAULT_UNHANDLED_TIMEOUT_MS = 2000;
