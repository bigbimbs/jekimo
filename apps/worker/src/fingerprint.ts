/**
 * Grouping fingerprints (docs/event-format.md, "Grouping"). An explicit
 * `fingerprint` always wins. Otherwise:
 *
 * - exceptions group by `exception.type` plus the in-app stack frames with
 *   line and column numbers removed, so a new release does not split an issue;
 * - everything else groups by `message` with UUIDs, hex strings, and numbers
 *   replaced by placeholders.
 *
 * The result is a SHA-256 hex digest. Existing issues keep their stored
 * fingerprint if this algorithm changes.
 */

import { createHash } from "node:crypto";
import type { EventEnvelope } from "@jekimo/event-schema";

const V8_FRAME = /^\s*at\s+(.+?)\s*$/;
const LINE_COL = /:\d+(?::\d+)?(?=\)?$)/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX_PREFIXED = /\b0x[0-9a-f]+\b/gi;
/** Eight or more hex characters with at least one digit and one letter. */
const HEX_BARE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
/** Digit runs not glued to a preceding letter, so "utf8" and "v2" survive. */
const NUMBER = /(?<![a-z])\d+(?:\.\d+)?/gi;

function isLibraryFrame(frame: string): boolean {
  return (
    frame.includes("node_modules") ||
    /(^|\(|\s)node:/.test(frame) ||
    frame.includes("(internal/") ||
    !/[/\\]/.test(frame)
  );
}

/** In-app frames of a V8 stack trace, with line and column numbers removed. */
export function inAppFrames(stacktrace: string): string[] {
  const frames: string[] = [];
  for (const line of stacktrace.split("\n")) {
    const m = V8_FRAME.exec(line);
    if (!m) continue;
    const frame = m[1]!;
    if (isLibraryFrame(frame)) continue;
    frames.push(frame.replace(LINE_COL, ""));
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

export function deriveFingerprint(event: Pick<EventEnvelope, "kind" | "message" | "exception">): string {
  if (event.kind === "exception" && event.exception) {
    const frames = inAppFrames(event.exception.stacktrace ?? "");
    if (frames.length > 0) return digest(["exception", event.exception.type, ...frames]);
    return digest(["exception", event.exception.type, normalizeMessage(event.exception.value ?? event.message)]);
  }
  return digest(["message", normalizeMessage(event.message)]);
}

export function fingerprintOf(event: EventEnvelope): string {
  return event.fingerprint ?? deriveFingerprint(event);
}

/** Human-readable issue title. */
export function issueTitle(event: EventEnvelope): string {
  const title = event.exception ? `${event.exception.type}: ${event.exception.value ?? event.message}` : event.message;
  return title.length > 256 ? `${title.slice(0, 255)}…` : title;
}
