import type { StackFrameParts, StackLine } from "../../types/issues";

const V8_FRAME = /^\s*at\s+/;
const FRAME_PARTS = /^(\s*at\s+)(?:(.+?)\s+\((.*?)(:\d+(?::\d+)?)?\)|(.*?)(:\d+(?::\d+)?)?)$/;

// Library and runtime frames follow the in-app rule of docs/event-format.md,
// "Grouping" (as in stackFrames in @jekimo/event-schema).
function isInApp(location: string): boolean {
  return !(
    location.includes("/node_modules/") ||
    location.includes("\\node_modules\\") ||
    location.startsWith("node:") ||
    location.startsWith("internal/") ||
    !/[/\\]/.test(location)
  );
}

function splitFrame(text: string): StackFrameParts | undefined {
  const m = FRAME_PARTS.exec(text);
  if (!m) return undefined;
  const [, lead = "", fn, inner, innerPosition, bare, barePosition] = m;
  return fn !== undefined
    ? { lead, fn, location: inner ?? "", position: innerPosition ?? "" }
    : { lead, fn: "", location: bare ?? "", position: barePosition ?? "" };
}

export function parseStack(stacktrace: string): StackLine[] {
  return stacktrace
    .replace(/\s+$/, "")
    .split("\n")
    .map((raw) => {
      const text = raw.trimEnd();
      if (!V8_FRAME.test(text)) return { text, frame: false, inApp: false };
      const parts = splitFrame(text);
      return {
        text,
        frame: true,
        inApp: isInApp(parts?.location ?? text.replace(V8_FRAME, "")),
        ...(parts && { parts }),
      };
    });
}
