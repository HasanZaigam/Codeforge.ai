import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/**
 * Dev-only proxy: forwards /api/* to the backend (npm run api, port 3000 by
 * default) so the browser sees one origin and no CORS handling is needed on
 * the backend — the backend is intentionally left untouched in Step 4. A
 * production deployment needs an equivalent reverse proxy (or the API would
 * need CORS enabled) — out of scope here, see /docs/UI_ARCHITECTURE.md.
 *
 * `VITE_API_PROXY_TARGET` must be read via `loadEnv` — Vite does NOT inject a
 * project's .env values into this file's own `process.env` (that's only done
 * for client code via `import.meta.env`), so reading `process.env` directly
 * here silently always fell back to the :3000 default, no matter what a
 * `web/.env` set it to.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": path.resolve(__dirname, "./src") },
    },
    server: {
      proxy: {
        "/api": {
          target: env.VITE_API_PROXY_TARGET ?? "http://localhost:3000",
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/api/, ""),
          configure: (proxy) => {
            proxy.on("proxyRes", (proxyRes, req) => {
              const pid = proxyRes.headers["x-codeforge-pid"];
              const sha = proxyRes.headers["x-codeforge-git-sha"];
              if (pid || sha) {
                console.log(`[vite-proxy] ${req.method} ${req.url} -> backend pid=${pid ?? "?"}, gitSha=${sha ?? "?"}`);
              }
            });
          },
        },
      },
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
    },
  };
});
