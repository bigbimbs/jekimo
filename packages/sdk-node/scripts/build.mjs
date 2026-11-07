// Builds dist/: ESM and CJS bundles with @jekimo/event-schema inlined (it is
// not published), plus one self-contained declaration file for each format.
//
// Declarations come from `tsc`. src/index.ts re-exports its public types from
// files under src/types/; those files are inlined into the published .d.ts so
// it has no imports, and the checks below fail the build if it would import a
// module or expose a type src/index.ts does not re-export.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

const shared = {
  entryPoints: [join(root, "src/index.ts")],
  bundle: true,
  conditions: ["@jekimo/source"],
  platform: "node",
  target: "node22",
  legalComments: "none",
  logLevel: "warning",
};
await build({ ...shared, format: "esm", outfile: join(dist, "index.js") });
await build({ ...shared, format: "cjs", outfile: join(dist, "index.cjs") });

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
const typesDir = mkdtempSync(join(tmpdir(), "jekimo-sdk-types-"));
try {
  execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json"), "--outDir", typesDir], {
    stdio: "inherit",
  });
  const dts = inlineLocalDeclarations(join(typesDir, "packages/sdk-node/src/index.d.ts"));
  if (/^\s*(import|export\s+\*|export\s+(type\s+)?\{[^}]*\}\s+from)\b/m.test(dts) || /\bimport\(/.test(dts)) {
    throw new Error("the public .d.ts references another module; re-export public types from src/types/ only");
  }
  writeFileSync(join(dist, "index.d.ts"), dts);
  writeFileSync(join(dist, "index.d.cts"), dts);
} finally {
  rmSync(typesDir, { recursive: true, force: true });
}

/**
 * Replaces the relative `import type` and `export type { ... } from` lines in
 * an entry .d.ts with the declarations of the files they name, recursively.
 * Every type an inlined file exports must be re-exported by the entry, so
 * inlining cannot widen the public API.
 */
function inlineLocalDeclarations(entry) {
  const local = /^(import|export) type \{([^}]*)\} from "(\.{1,2}\/[^"]+)\.js";\n/gm;
  const entryText = readFileSync(entry, "utf8");
  const reexported = new Set(
    [...entryText.matchAll(local)]
      .filter(([, keyword]) => keyword === "export")
      .flatMap(([, , names]) => names.split(",").map((name) => name.trim())),
  );
  const visited = new Set([entry]);
  const inlined = [];
  const visit = (file, text) => {
    for (const [, , , specifier] of text.matchAll(local)) {
      const target = resolve(dirname(file), `${specifier}.d.ts`);
      if (visited.has(target)) continue;
      visited.add(target);
      const targetText = readFileSync(target, "utf8");
      visit(target, targetText);
      for (const [, name] of targetText.matchAll(/^export (?:declare )?(?:type|interface) (\w+)/gm)) {
        if (!reexported.has(name)) throw new Error(`${target} exports ${name}, which src/index.ts does not re-export`);
      }
      inlined.push(targetText.replace(local, ""));
    }
  };
  visit(entry, entryText);
  return [...inlined, entryText.replace(local, "")].join("");
}
