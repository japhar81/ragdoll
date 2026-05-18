import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Dev server proxies the control-plane API so the SPA can call relative
 * `/api/*` and `/healthz` paths without CORS. The API listens on :3001
 * (see apps/api/src/server.ts).
 */
export default defineConfig({
  root: here,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
      "/healthz": { target: "http://localhost:3001", changeOrigin: true },
      "/readyz": { target: "http://localhost:3001", changeOrigin: true }
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
