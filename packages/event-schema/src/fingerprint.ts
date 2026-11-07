/**
 * Grouping fingerprints. Normative text: docs/event-format.md, "Grouping".
 *
 * An explicit `fingerprint` always wins. Otherwise:
 *
 * - exceptions group by `exception.type` plus the in-app frames of
 *   `exception.stacktrace` with line and column numbers removed, so a new
 *   release does not split an issue; when no frame is in-app, all frames are
 *   used; with no frames at all, the normalized exception value is used;
 * - every other kind groups by `message` with UUIDs, hex strings, and numbers
 *   replaced by placeholders.
 *
 * The result is a SHA-256 hex digest (64 characters), well inside the
 * fingerprint limit. Existing issues keep their stored fingerprint if this
 * algorithm changes.
 */

import { createHash } from "node:crypto";
import type { EventEnvelope } from "./types.js";

const V8_FRAME = /^\s*at\s+(.+?)\s*$/;
const LINE_COL = /:\d+(?::\d+)?$/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_PREFIXED = /\b0x[0-9a-f]+\b/gi;
/** Eight or more hex characters with at least one digit and one letter. */
const HEX_BARE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
/** Digit runs not glued to a preceding letter, so "utf8" and "v2" survive. */
const NUMBER = /(?<![a-z])\d+(?:\.\d+)?/gi;

/** One V8 stack frame without line and column numbers, and whether it is in-app. */
export interface StackFrame {
  frame: string;
  inApp: boolean;
}

/** `fn (path:1:2)` or `path:1:2` → the location, without line and column. */
function splitFrame(frame: string): { prefix: string; path: string } {
  if (frame.endsWith(")")) {
    const open = frame.lastIndexOf("(");
    if (open >= 0) return { prefix: frame.slice(0, open + 1), path: frame.slice(open + 1, -1).replace(LINE_COL, "") };
  }
  return { prefix: "", path: frame.replace(LINE_COL, "") };
}

/**
 * Library and runtime frames are not in-app: paths inside `node_modules`,
 * Node.js internals (`node:` and `internal/`), and frames without a file path
 * such as `<anonymous>` or `index 0`.
 */
function isInApp(path: string): boolean {
  return !(
    path.includes("/node_modules/") ||
    path.includes("\\node_modules\\") ||
    path.startsWith("node:") ||
    path.startsWith("internal/") ||
    !/[/\\]/.test(path)
  );
}

/** Frames of a V8 stack trace, in order, with line and column numbers removed. */
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

/** Replaces UUIDs, hex strings, and numbers with placeholders. */
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

/**
 * The event's grouping key: its explicit `fingerprint`, or one derived per
 * docs/event-format.md, "Grouping". Never throws.
 */
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
