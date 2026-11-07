// Normative text: docs/event-format.md, "Grouping". Changing the derivation
// splits issues: existing issues keep their stored fingerprint.

import { createHash } from "node:crypto";
import type { EventEnvelope } from "./types/envelope.js";
import type { StackFrame } from "./types/fingerprint.js";

const V8_FRAME = /^\s*at\s+(.+?)\s*$/;
const LINE_COL = /:\d+(?::\d+)?$/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_PREFIXED = /\b0x[0-9a-f]+\b/gi;
/** Eight or more hex characters with at least one digit and one letter. */
const HEX_BARE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
/** Digit runs not glued to a preceding letter, so "utf8" and "v2" survive. */
const NUMBER = /(?<![a-z])\d+(?:\.\d+)?/gi;

function splitFrame(frame: string): { prefix: string; path: string } {
  if (frame.endsWith(")")) {
    const open = frame.lastIndexOf("(");
    if (open >= 0) return { prefix: frame.slice(0, open + 1), path: frame.slice(open + 1, -1).replace(LINE_COL, "") };
  }
  return { prefix: "", path: frame.replace(LINE_COL, "") };
}

// Beyond the spec's node_modules and node: frames, internal/ and path-less
// frames (`<anonymous>`, `index 0`) are runtime noise too.
function isInApp(path: string): boolean {
  return !(
    path.includes("/node_modules/") ||
    path.includes("\\node_modules\\") ||
    path.startsWith("node:") ||
    path.startsWith("internal/") ||
    !/[/\\]/.test(path)
  );
}

export function stackFrames(stacktrace: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stacktrace.split("\n")) {
    const m = V8_FRAME.exec(line);
    const raw = m?.[1];
    if (raw === undefined) continue;
    const { prefix, path } = splitFrame(raw);
    frames.push({ frame: prefix ? `${prefix}${path})` : path, inApp: isInApp(path) });
  }
  return frames;
}

export function normalizeMessage(message: string): string {
  return message
    .replace(UUID, "<uuid>")
    .replace(HEX_PREFIXED, "<hex>")
    .replace(HEX_BARE, "<hex>")
    .replace(NUMBER, "<num>")
    .trim();
}

function digest(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
}

/** Never throws, so a malformed event cannot fail a worker job here. */
export function deriveFingerprint(
  event: Pick<EventEnvelope, "kind" | "message" | "exception" | "fingerprint">,
): string {
  if (typeof event.fingerprint === "string") return event.fingerprint;
  const message = typeof event.message === "string" ? event.message : "";
  const exception = event.exception;
  if (event.kind === "exception" && exception) {
    const type = typeof exception.type === "string" ? exception.type : "";
    const all = stackFrames(typeof exception.stacktrace === "string" ? exception.stacktrace : "");
    const inApp = all.filter((f) => f.inApp);
    const frames = (inApp.length > 0 ? inApp : all).map((f) => f.frame);
    if (frames.length > 0) return digest(["exception", type, ...frames]);
    const value = typeof exception.value === "string" ? exception.value : message;
    return digest(["exception", type, normalizeMessage(value)]);
  }
  return digest(["message", normalizeMessage(message)]);
}
