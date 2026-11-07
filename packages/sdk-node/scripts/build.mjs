// Builds dist/: ESM and CJS bundles with @jekimo/event-schema inlined (it is
// not published), plus one self-contained declaration file for each format.
//
// Declarations come from `tsc`. src/index.ts declares every public type
// itself, so its .d.ts has no imports; the check below fails the build if that
// ever stops being true.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });

const shared = {
  entryPoints: [join(root, "src/index.ts")],
  bundle: true,
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
  const dts = readFileSync(join(typesDir, "packages/sdk-node/src/index.d.ts"), "utf8");
  if (/^\s*(import|export\s+\*|export\s+\{[^}]*\}\s+from)\b/m.test(dts) || /\bimport\(/.test(dts)) {
    throw new Error("src/index.ts must declare every public type itself: its .d.ts references another module");
  }
  writeFileSync(join(dist, "index.d.ts"), dts);
  writeFileSync(join(dist, "index.d.cts"), dts);
} finally {
  rmSync(typesDir, { recursive: true, force: true });
}
