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
      // `ws: true` makes Vite forward the WebSocket upgrade for
      // `/api/events`. Without it the dev SPA's live-update socket hangs on
      // connect because http-proxy only handles plain HTTP.
      "/api": { target: "http://localhost:3001", changeOrigin: true, ws: true },
      "/healthz": { target: "http://localhost:3001", changeOrigin: true },
      "/readyz": { target: "http://localhost:3001", changeOrigin: true }
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // npm workspaces hoist server-only deps (connect-rpc / grpc-js / pg /
      // fastify / etc.) into the root node_modules; vite's resolver sees them
      // as available and will try to bundle them on any incidental import
      // chain. The web app NEVER imports any of these — they're Node-only.
      // Marking them external means rollup refuses to follow imports into
      // them rather than tripping over their `node:*` requires.
      external: [
        /^@connectrpc\//,
        /^@grpc\//,
        /^@bufbuild\//,
        /^@ragdoll\/(plugin-sdk|proto-gen|runtime|db|auth|secrets|providers|plugin-loader|cron|opensearch|vector|graph|observability|git-storage)$/,
        /^@ragdoll\/(plugin-sdk|proto-gen|runtime|db|auth|secrets|providers|plugin-loader|cron|opensearch|vector|graph|observability|git-storage)\//
      ]
    }
  },
  optimizeDeps: {
    exclude: ["@connectrpc/connect", "@connectrpc/connect-node", "@grpc/grpc-js", "@grpc/proto-loader", "@bufbuild/protobuf"]
  }
});
