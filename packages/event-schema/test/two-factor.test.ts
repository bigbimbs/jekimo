import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { validateTwoFactorPolicy } from "../src/index.js";
import { packageRoot } from "./fixtures.js";

const schema = JSON.parse(readFileSync(join(packageRoot, "schema/two-factor-policy.v1.json"), "utf8"));
const example = JSON.parse(readFileSync(join(packageRoot, "examples/security/two-factor-policy.json"), "utf8"));
const validate = new Ajv2020Module.default({ strict: true }).compile(schema);

describe("two-factor policy contract", () => {
  it.each([true, false])("accepts required=%s in the validator and JSON Schema", (required) => {
    expect(validateTwoFactorPolicy({ required })).toBe(true);
    expect(validate({ required })).toBe(true);
  });
  it.each([null, [], {}, { required: "true" }, { required: true, extra: 1 }])("rejects invalid policy %j", (input) => {
    expect(validateTwoFactorPolicy(input)).toBe(false);
    expect(validate(input)).toBe(false);
  });
  it("keeps the example and normative policy in agreement", () => {
    expect(validateTwoFactorPolicy(example)).toBe(true);
    const docs = readFileSync(join(packageRoot, "../../docs/access-model.md"), "utf8");
    expect(docs).toContain("`required: false`");
    expect(docs).toContain("`required: true`");
  });
});
