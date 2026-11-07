import type { Severity } from "./envelope.js";

/** Normative text: docs/retention.md, "Sampling". */
export const ALWAYS_KEPT_SEVERITIES: ReadonlySet<Severity> = new Set<Severity>(["error", "fatal"]);
