import { describe, expect, it } from "vitest";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { validateEvent } from "../src/index.js";
import { clone, exceptionExample, invalidCases, loadExamples, loadSchema, type Mutable } from "./fixtures.js";

// ajv ships CommonJS; under NodeNext the class is on the module's `default`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const schema = loadSchema();
const validateWithSchema = ajv.compile(schema);
const examples = loadExamples();
const now = new Date("2026-11-05T12:00:00Z");

describe("JSON Schema", () => {
  it("compiles under strict mode", () => {
    expect(typeof validateWithSchema).toBe("function");
  });

  for (const { name, event } of examples) {
    it(`accepts example ${name}`, () => {
      expect(validateWithSchema(event), JSON.stringify(validateWithSchema.errors)).toBe(true);
    });
  }

  it("accepts the ingest form without project_id", () => {
    const e = clone(exceptionExample()) as Mutable;
    delete e.project_id;
    expect(validateWithSchema(e)).toBe(true);
  });
});

describe("JSON Schema and validator agree", () => {
  for (const c of invalidCases) {
    if (c.valid) {
      it(`${c.name}: both accept`, () => {
        const e = clone(exceptionExample()) as Mutable;
        c.mutate(e);
        expect(validateWithSchema(e)).toBe(true);
        expect(validateEvent(e, { mode: "stored", now }).ok).toBe(true);
      });
      continue;
    }
    const schemaDetects = c.schemaDetects ?? true;
    it(`${c.name}: schema ${schemaDetects ? "rejects" : "cannot express, validator rejects"}`, () => {
      const e = clone(exceptionExample()) as Mutable;
      c.mutate(e);
      expect(validateWithSchema(e)).toBe(!schemaDetects);
      expect(validateEvent(e, { mode: "stored", now }).ok).toBe(false);
    });
  }

  it("neither accepts an unknown kind even if exception is present", () => {
    const e = clone(exceptionExample()) as Mutable;
    e.kind = "crash";
    expect(validateWithSchema(e)).toBe(false);
    expect(validateEvent(e, { mode: "stored", now }).ok).toBe(false);
  });
});
