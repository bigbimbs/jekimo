import { defineConfig } from "vitest/config";

// Workspace packages export "@jekimo/source" (their TypeScript sources) ahead
// of the built dist/ files, so tests run without building them first.
const conditions = ["@jekimo/source"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ["apps/*/{src,test}/**/*.test.ts", "packages/*/{src,test}/**/*.test.ts"],
  },
});
