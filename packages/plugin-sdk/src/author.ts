/**
 * Node plugin author SDK — thin wrapper around connect-rpc.
 *
 * Plugin authors importing `@ragdoll/plugin-sdk/author` get:
 *   - The `PluginRuntime` service descriptor from the shared .proto
 *   - A one-call `createPluginServer()` that mounts the handler over
 *     Connect HTTP/JSON + gRPC + gRPC-Web (the SAME handler answers all
 *     three protocols — clients pick) on an http2 listener
 *   - Type aliases that turn the generated proto types into ergonomic
 *     names (`ExecuteHandler`, `StreamHandler`, etc.)
 *
 * Shared concerns (auth interceptor, tenant-scope check, allow-listed
 * hosts enforcement, OTel context propagation) are exposed via
 * `defaultInterceptors()`. The Node side ships an empty list — author
 * deployments compose the interceptors they need. The Python sibling
 * (`ragdoll_plugin_py.default_interceptors`) ships the four standard
 * interceptors enabled by env vars; the asymmetry is intentional today
 * because the only in-tree external plugin is the Python crawl4ai
 * sidecar. When a Node-side external plugin lands, populate this list
 * with the equivalents so both author SDKs stay symmetrical.
 *
 * Example author file (a fictional "echo" plugin):
 *
 *   import { createPluginServer, type ExecuteHandler } from "@ragdoll/plugin-sdk/author";
 *
 *   const execute: ExecuteHandler = async (req) => ({
 *     outputs: { echoed: req.inputs }
 *   });
 *
 *   const server = createPluginServer({
 *     pluginId: "echo_plugin",
 *     version: "0.1.0",
 *     handlers: { execute },
 *   });
 *   server.listen(8000, () => console.log("plugin up on :8000"));
 */
import * as http2 from "node:http2";
import { create } from "@bufbuild/protobuf";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { Interceptor } from "@connectrpc/connect";
import {
  ExecuteResponseSchema,
  PluginRuntime,
  type ExecuteChunk,
  type ExecuteRequest,
  type ExecuteResponse,
  type HealthResponse
} from "@ragdoll/proto-gen/plugin";

/** Re-exports — authors should import these from the SDK, not from `@ragdoll/proto-gen` directly. */
export { PluginRuntime, ExecuteResponseSchema };
export type { ExecuteRequest, ExecuteResponse, ExecuteChunk, HealthResponse };

/** Unary execution handler. Plugin author returns the response envelope. */
export type ExecuteHandler = (req: ExecuteRequest) => Promise<ExecuteResponse> | ExecuteResponse;

/**
 * Server-streaming handler. Author returns / yields `ExecuteChunk` instances,
 * typically:
 *   - `{ payload: { case: "token", value: "..." }, nodeId: req.nodeId }` per token
 *   - `{ payload: { case: "delta", value: { partialKey: ... } }, ... }` for partial outputs
 *   - `{ payload: { case: "final", value: <ExecuteResponse> }, ... }` as the last chunk
 * Final chunk is optional; if omitted, the runtime synthesises an envelope
 * from accumulated deltas.
 */
export type StreamHandler = (req: ExecuteRequest) => AsyncIterable<ExecuteChunk>;

/** Client-streaming + bidi handlers. Reach for these only if your plugin actually needs them. */
export type ClientStreamHandler = (reqs: AsyncIterable<ExecuteRequest>) => Promise<ExecuteResponse>;
export type BidiHandler = (reqs: AsyncIterable<ExecuteRequest>) => AsyncIterable<ExecuteChunk>;

/**
 * The set of handlers a plugin author registers. Only `execute` is required;
 * everything else is opt-in based on which RPC kinds the plugin supports.
 * Health is auto-implemented (returns the registered plugin id + ok:true);
 * authors can override by supplying a `health` handler.
 */
export interface PluginHandlers {
  health?: () => Promise<HealthResponse> | HealthResponse;
  execute: ExecuteHandler;
  executeServerStream?: StreamHandler;
  executeClientStream?: ClientStreamHandler;
  executeBidi?: BidiHandler;
}

export interface CreatePluginServerOptions {
  /** Plugin id (must match the manifest the runtime registers). */
  pluginId: string;
  /** Plugin version string (semver). */
  version: string;
  /** RPC handlers. */
  handlers: PluginHandlers;
  /**
   * Connect-rpc interceptors. The SDK appends `defaultInterceptors()` (auth,
   * tenant-scope, allow-list, OTel propagator) automatically — author-supplied
   * interceptors run first, then defaults. Node defaults are an empty list
   * today (the Python SDK ships the four standard interceptors via env vars
   * — see ragdoll_plugin_py.default_interceptors); add equivalents here when
   * a Node-side external plugin lands.
   */
  interceptors?: Interceptor[];
}

/**
 * Default shared-concerns interceptor list. Empty on the Node side today —
 * exported so author-side compositions are forward-compatible and the
 * Node↔Python parity story stays clear. Equivalents exist on the Python
 * side at `ragdoll_plugin_py.default_interceptors`:
 *   - auth bearer (RAGDOLL_PLUGIN_TOKEN)
 *   - tenant-scope (RAGDOLL_PLUGIN_REQUIRE_TENANT=1 → require x-ragdoll-tenant)
 *   - host allow-list (RAGDOLL_PLUGIN_HOST_ALLOWLIST=comma,separated)
 *   - OTel traceparent extractor (lazy-imports opentelemetry-api)
 * Populate this list with the Node equivalents when a Node-side external
 * plugin ships and these become load-bearing here too.
 */
export function defaultInterceptors(): Interceptor[] {
  return [];
}

/**
 * Build an http2 server that serves the `PluginRuntime` over Connect, gRPC,
 * and gRPC-Web from one handler. h2c (cleartext); production callers should
 * wrap with TLS via http2.createSecureServer. Returns the unstarted server
 * — caller invokes `.listen(port)` so they control the bind lifecycle.
 */
export function createPluginServer(opts: CreatePluginServerOptions): http2.Http2Server {
  const userInterceptors = opts.interceptors ?? [];
  const interceptors: Interceptor[] = [...userInterceptors, ...defaultInterceptors()];
  const handler = connectNodeAdapter({
    routes: (router) => {
      router.service(PluginRuntime, {
        async health() {
          if (opts.handlers.health) return opts.handlers.health();
          return { ok: true, plugins: [opts.pluginId], message: `${opts.pluginId}@${opts.version}` };
        },
        async execute(req) {
          return opts.handlers.execute(req);
        },
        async *executeServerStream(req) {
          if (!opts.handlers.executeServerStream) {
            // Author didn't declare streaming — fall through to unary and
            // wrap the result as one final chunk so older clients work.
            const resp = await opts.handlers.execute(req);
            yield { payload: { case: "final", value: resp }, nodeId: req.nodeId } as ExecuteChunk;
            return;
          }
          for await (const chunk of opts.handlers.executeServerStream(req)) {
            yield chunk;
          }
        },
        async executeClientStream(reqs) {
          if (!opts.handlers.executeClientStream) {
            // Default: drain the input stream and call execute on the LAST
            // request seen. Useful for plugins that just want the final form.
            let last: ExecuteRequest | undefined;
            for await (const r of reqs) last = r;
            if (!last) return create(ExecuteResponseSchema, {});
            return opts.handlers.execute(last);
          }
          return opts.handlers.executeClientStream(reqs);
        },
        async *executeBidi(reqs) {
          if (!opts.handlers.executeBidi) {
            // Default: for each input request, invoke unary execute and emit
            // one chunk per response. Authors override when they need
            // interleaved request/response semantics.
            for await (const r of reqs) {
              const resp = await opts.handlers.execute(r);
              yield { payload: { case: "final", value: resp }, nodeId: r.nodeId } as ExecuteChunk;
            }
            return;
          }
          for await (const chunk of opts.handlers.executeBidi(reqs)) {
            yield chunk;
          }
        }
      });
    },
    // The Connect adapter applies interceptors via the router config; passing
    // them on the adapter (rather than per-service) keeps cross-cutting concerns
    // in one place.
    ...(interceptors.length > 0 ? { interceptors } : {})
  });
  return http2.createServer(handler);
}
