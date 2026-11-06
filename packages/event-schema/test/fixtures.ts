import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventEnvelope } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
export const packageRoot = join(here, "..");
export const schemaPath = join(packageRoot, "schema", "event-envelope.v1.json");
const examplesDir = join(packageRoot, "examples");

export function loadSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
}

export function loadExamples(): Array<{ name: string; event: EventEnvelope }> {
  return readdirSync(examplesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((name) => ({
      name,
      event: JSON.parse(readFileSync(join(examplesDir, name), "utf8")) as EventEnvelope,
    }));
}

/** The exception example, used as the base for mutation tests. */
export function exceptionExample(): EventEnvelope {
  const found = loadExamples().find((e) => e.name === "exception.json");
  if (!found) throw new Error("examples/exception.json is missing");
  return found.event;
}

/** Deep-clones a JSON value. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type Mutable = Record<string, any>;

/**
 * Invalid variations of a valid stored-form event. `schemaDetects` is false
 * for rules that JSON Schema cannot express and only the validator enforces.
 */
// biome-ignore format: one case per line keeps the cases readable as a table
export const invalidCases: Array<{
  name: string;
  mutate: (e: Mutable) => void;
  code: string;
  schemaDetects?: boolean;
  /** True for boundary cases that must be accepted; they document where the limit sits. */
  valid?: boolean;
}> = [
  { name: "wrong schema_version", mutate: (e) => { e.schema_version = 2; }, code: "enum" },
  { name: "missing event_id", mutate: (e) => { delete e.event_id; }, code: "required" },
  { name: "event_id not a ULID", mutate: (e) => { e.event_id = "not-a-ulid"; }, code: "pattern" },
  { name: "event_id with excluded letters", mutate: (e) => { e.event_id = "01JBQ4Z3H8X9T2K7M5N6P8R9IL"; }, code: "pattern" },
  { name: "missing timestamp", mutate: (e) => { delete e.timestamp; }, code: "required" },
  { name: "timestamp not RFC 3339", mutate: (e) => { e.timestamp = "05/11/2026 09:14"; }, code: "pattern" },
  { name: "timestamp without zone", mutate: (e) => { e.timestamp = "2026-11-05T09:14:33"; }, code: "pattern" },
  { name: "unknown kind", mutate: (e) => { e.kind = "metric"; }, code: "enum" },
  { name: "unknown severity", mutate: (e) => { e.severity = "critical"; }, code: "enum" },
  { name: "missing message", mutate: (e) => { delete e.message; }, code: "required" },
  { name: "empty message", mutate: (e) => { e.message = ""; }, code: "min_length" },
  { name: "message too long", mutate: (e) => { e.message = "x".repeat(4097); }, code: "max_length" },
  { name: "message wrong type", mutate: (e) => { e.message = 42; }, code: "type" },
  { name: "service too long", mutate: (e) => { e.service = "s".repeat(129); }, code: "max_length" },
  { name: "fingerprint too long", mutate: (e) => { e.fingerprint = "f".repeat(257); }, code: "max_length" },
  { name: "exception missing for kind exception", mutate: (e) => { e.kind = "exception"; delete e.exception; }, code: "required" },
  { name: "exception missing type", mutate: (e) => { e.kind = "exception"; e.exception = { value: "boom" }; }, code: "required" },
  { name: "exception not an object", mutate: (e) => { e.kind = "exception"; e.exception = "boom"; }, code: "type" },
  { name: "stacktrace too long", mutate: (e) => { e.kind = "exception"; e.exception = { type: "E", stacktrace: "x".repeat(65537) }; }, code: "max_length" },
  { name: "sdk missing version", mutate: (e) => { e.sdk = { name: "x" }; }, code: "required" },
  { name: "context value not a string", mutate: (e) => { e.context = { request_id: 7 }; }, code: "type" },
  { name: "context too many keys", mutate: (e) => { e.context = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, "v"])); }, code: "max_keys" },
  { name: "context key too long", mutate: (e) => { e.context = { ["k".repeat(65)]: "v" }; }, code: "max_length" },
  { name: "context value too long", mutate: (e) => { e.context = { k: "v".repeat(1025) }; }, code: "max_length" },
  { name: "attributes not an object", mutate: (e) => { e.attributes = ["a"]; }, code: "type" },
  { name: "attributes too many keys", mutate: (e) => { e.attributes = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 1])); }, code: "max_keys" },
  { name: "attribute string too long", mutate: (e) => { e.attributes = { big: "x".repeat(1025) }; }, code: "max_length" },
  { name: "attribute array too long", mutate: (e) => { e.attributes = { list: Array.from({ length: 33 }, () => 1) }; }, code: "max_items" },
  { name: "attribute nested at the depth limit", mutate: (e) => { e.attributes = { a: { b: { c: { d: 1 } } } }; }, code: "", valid: true },
  { name: "attribute nested too deep", mutate: (e) => { e.attributes = { a: { b: { c: { d: { e: 1 } } } } }; }, code: "max_depth", schemaDetects: false },
  { name: "attribute non-finite number", mutate: (e) => { e.attributes = { n: Number.POSITIVE_INFINITY }; }, code: "invalid_number" },
  { name: "timestamp far in the future", mutate: (e) => { e.timestamp = "2999-01-01T00:00:00Z"; }, code: "future_timestamp", schemaDetects: false },
  {
    name: "event over 128 KiB",
    mutate: (e) => {
      e.kind = "exception";
      e.exception = { type: "E", stacktrace: "s".repeat(65536) };
      e.attributes = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, "v".repeat(1024)]));
    },
    code: "max_size",
    schemaDetects: false,
  },
];
