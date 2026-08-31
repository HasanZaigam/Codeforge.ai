import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Dev-only proxy: forwards /api/* to the backend (npm run api, port 3000 by
 * default) so the browser sees one origin and no CORS handling is needed on
 * the backend — the backend is intentionally left untouched in Step 4. A
 * production deployment needs an equivalent reverse proxy (or the API would
 * need CORS enabled) — out of scope here, see /docs/UI_ARCHITECTURE.md.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
