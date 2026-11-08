import type { StackLine } from "../../types/issues";

const V8_FRAME = /^\s*at\s+/;

// Library and runtime frames follow the in-app rule of docs/event-format.md,
// "Grouping" (as in stackFrames in @jekimo/event-schema).
function isInApp(line: string): boolean {
  const location = /\(([^()]*)\)\s*$/.exec(line)?.[1] ?? line.replace(V8_FRAME, "");
  return !(
    location.includes("/node_modules/") ||
    location.includes("\\node_modules\\") ||
    location.startsWith("node:") ||
    location.startsWith("internal/") ||
    !/[/\\]/.test(location)
  );
}

export function parseStack(stacktrace: string): StackLine[] {
  return stacktrace
    .replace(/\s+$/, "")
    .split("\n")
    .map((text) => {
      const frame = V8_FRAME.test(text);
      return { text: text.trimEnd(), frame, inApp: frame && isInApp(text) };
    });
}
