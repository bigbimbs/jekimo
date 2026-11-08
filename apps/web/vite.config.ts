import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

// The dev server proxies the API so the session cookie and the dashboard share
// one origin, as they do behind Caddy in production.
const api = process.env.JEKIMO_DEV_API_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ["@jekimo/source", ...defaultClientConditions] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": api, "/healthz": api },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "vendor", test: /node_modules/ },
          ],
        },
      },
    },
  },
});
