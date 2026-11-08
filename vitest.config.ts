import { defaultClientConditions } from "vite";
import { defineConfig } from "vitest/config";

// Workspace packages export "@jekimo/source" (their TypeScript sources) ahead
// of the built dist/ files, so tests run without building them first.
const conditions = ["@jekimo/source"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["apps/*/{src,test}/**/*.test.ts", "packages/*/{src,test}/**/*.test.ts"],
          exclude: ["apps/web/src/**", "**/node_modules/**"],
        },
      },
      {
        extends: true,
        resolve: { conditions: [...conditions, ...defaultClientConditions] },
        test: {
          name: "web",
          include: ["apps/web/src/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["apps/web/src/test/setup.ts"],
        },
      },
    ],
  },
});
