// Bundles an app's TypeScript entry points, and the workspace packages they
// import, into dist/*.mjs with esbuild. Third-party packages stay external
// and are loaded from node_modules at run time.
//
// Usage: node scripts/build-app.mjs <app dir> <name>=<entry> [<name>=<entry> ...]
// Entry paths are relative to the app directory.

import { build } from "esbuild";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [appDir, ...entries] = process.argv.slice(2);
if (!appDir || entries.length === 0) {
  console.error("usage: build-app.mjs <app dir> <name>=<entry> ...");
  process.exit(2);
}

const entryPoints = Object.fromEntries(
  entries.map((e) => {
    const [name, path] = e.split("=");
    return [name, join(root, appDir, path)];
  }),
);

await build({
  entryPoints,
  outdir: join(root, appDir, "dist"),
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  plugins: [
    {
      name: "external-dependencies",
      setup(b) {
        // Bare imports other than @jekimo/* workspaces are runtime dependencies.
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith("@jekimo/") ? undefined : { path: args.path, external: true }));
      },
    },
  ],
});
