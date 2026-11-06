import { readFileSync } from "node:fs";
import { join } from "node:path";
import type * as schema from "@jekimo/event-schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import type * as sdk from "../src/index.js";
import { SDK_NAME, SDK_VERSION } from "../src/index.js";

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8")) as Record<string, unknown>;

describe("package metadata", () => {
  it("reports the package name and version in events", () => {
    expect(SDK_NAME).toBe(pkg.name);
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it("is publishable", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.engines).toEqual({ node: ">=22.12" });
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.files).toEqual(["dist"]);
    expect(pkg.dependencies).toBeUndefined();
  });
});

describe("public types mirror @jekimo/event-schema", () => {
  it("EventEnvelope, ExceptionInfo, and AttributeValue agree in both directions", () => {
    type Ingest = Omit<schema.EventEnvelope, "project_id">;
    expectTypeOf<sdk.EventEnvelope>().toEqualTypeOf<Ingest>();
    expectTypeOf<sdk.ExceptionInfo>().toEqualTypeOf<schema.ExceptionInfo>();
    expectTypeOf<sdk.AttributeValue>().toEqualTypeOf<schema.AttributeValue>();
    expectTypeOf<sdk.Severity>().toEqualTypeOf<schema.Severity>();
    expectTypeOf<sdk.EventKind>().toEqualTypeOf<schema.EventKind>();
  });

  it("ValidationIssue accepts the schema's issues", () => {
    expectTypeOf<schema.ValidationIssue>().toExtend<sdk.ValidationIssue>();
  });

  it("the global fetch is a valid transport", () => {
    expectTypeOf<(url: string, request: sdk.TransportRequest) => Promise<Response>>().toExtend<sdk.Transport>();
  });
});
