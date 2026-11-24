import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { expect, it } from "vitest";
import { validateEvent } from "../src/index.js";
import { loadExamples, loadSchema } from "./fixtures.js";

const ajv = new Ajv2020Module.default({ strict: true });
addFormatsModule.default(ajv);
const schema = ajv.compile(loadSchema());
const example = loadExamples().find((e) => e.name === "database-query.json")!.event;
const now = new Date("2026-11-05T12:00:00Z");
it("keeps typed timings while dropping unknown database data", () => {
  const input = {
    ...example,
    database: { ...example.database, statement: "select synthetic_secret", parameters: ["synthetic_secret"] },
  };
  const result = validateEvent(input, { mode: "stored", now });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.event.database).toEqual(example.database);
    expect(JSON.stringify(result.event)).not.toContain("synthetic_secret");
  }
  expect(result.warnings.map((w) => w.path)).toEqual(["/database/statement", "/database/parameters"]);
});
it.each([-1, Infinity, NaN, 604800001, "1", null, undefined])(
  "rejects invalid duration %s in both contracts",
  (duration) => {
    const input = { ...example, database: { ...example.database, duration_ms: duration } };
    expect(validateEvent(input, { mode: "stored", now }).ok).toBe(false);
    expect(schema(input)).toBe(false);
  },
);
it.each([{ name: "" }, { name: "x".repeat(129) }, { system: "unknown" }, { operation: "drop" }, { status: "failed" }])(
  "rejects invalid metadata %j",
  (fields) => {
    const input = { ...example, database: { ...example.database, ...fields } };
    expect(validateEvent(input, { mode: "stored", now }).ok).toBe(false);
    expect(schema(input)).toBe(false);
  },
);
it("requires event kind and accepts fractional duration", () => {
  expect(schema(example)).toBe(true);
  const input = { ...example, kind: "log" };
  expect(schema(input)).toBe(false);
  expect(validateEvent(input, { mode: "stored", now }).ok).toBe(false);
});
