// The catalogue check from docs/architecture.md, "Translation": every locale
// has the English keys and no others, no empty values, valid ICU syntax, and
// the same variables as English.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type MessageFormatElement, parse, TYPE } from "@formatjs/icu-messageformat-parser";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, NAMESPACES, SUPPORTED_LOCALES } from "../src/constants/i18n";

const LOCALES_DIR = fileURLToPath(new URL("../src/locales", import.meta.url));

function flatten(value: unknown, prefix = "", out = new Map<string, unknown>()): Map<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
  } else {
    out.set(prefix, value);
  }
  return out;
}

function variables(elements: MessageFormatElement[], out = new Set<string>()): Set<string> {
  for (const el of elements) {
    if (
      el.type === TYPE.argument ||
      el.type === TYPE.number ||
      el.type === TYPE.date ||
      el.type === TYPE.time ||
      el.type === TYPE.select ||
      el.type === TYPE.plural
    )
      out.add(el.value);
    if (el.type === TYPE.select || el.type === TYPE.plural)
      for (const option of Object.values(el.options)) variables(option.value, out);
    if (el.type === TYPE.tag) variables(el.children, out);
  }
  return out;
}

function load(locale: string): Map<string, Map<string, unknown>> {
  const dir = join(LOCALES_DIR, locale);
  return new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => [f.replace(/\.json$/, ""), flatten(JSON.parse(readFileSync(join(dir, f), "utf8")))]),
  );
}

const locales = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const english = load(DEFAULT_LOCALE);

describe("message catalogues", () => {
  it("exist for every supported locale, with the declared namespaces", () => {
    for (const locale of SUPPORTED_LOCALES) expect(locales).toContain(locale);
    expect([...english.keys()].sort()).toEqual([...NAMESPACES].sort());
  });

  for (const locale of locales) {
    it(`${locale}: same keys as English, non-empty valid ICU, same variables`, () => {
      const catalogue = load(locale);
      const problems: string[] = [];
      for (const ns of new Set([...english.keys(), ...catalogue.keys()])) {
        const en = english.get(ns) ?? new Map();
        const messages = catalogue.get(ns) ?? new Map();
        for (const key of en.keys()) if (!messages.has(key)) problems.push(`${ns}:${key} is missing`);
        for (const [key, value] of messages) {
          const id = `${ns}:${key}`;
          if (!en.has(key)) problems.push(`${id} is not in the English catalogue`);
          if (typeof value !== "string" || value.trim() === "") {
            problems.push(`${id} is empty or not a string`);
            continue;
          }
          let ast: MessageFormatElement[];
          try {
            ast = parse(value);
          } catch (err) {
            problems.push(`${id} is not valid ICU: ${(err as Error).message}`);
            continue;
          }
          const source = en.get(key);
          if (locale !== DEFAULT_LOCALE && typeof source === "string") {
            const expected = [...variables(parse(source))].sort().join(", ");
            const actual = [...variables(ast)].sort().join(", ");
            if (expected !== actual) problems.push(`${id} uses {${actual}}, English uses {${expected}}`);
          }
        }
      }
      expect(problems).toEqual([]);
    });
  }
});
