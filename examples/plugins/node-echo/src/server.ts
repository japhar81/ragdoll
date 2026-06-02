/**
 * node-echo: bare-minimum external Node plugin.
 *
 * Two exports:
 *   - `createEchoServer()`  — builds an http2 server (unstarted) so tests can
 *                              listen on an ephemeral port and run a real
 *                              round-trip against the example.
 *   - `main()`              — listens on PORT (default 8001), used by the
 *                              Dockerfile CMD.
 *
 * Run locally:
 *   node --experimental-strip-types src/server.ts
 *
 * Hit it with curl (Connect unary is just JSON POST):
 *   curl -s -X POST -H 'Content-Type: application/json' \
 *     -d '{"plugin":"node_echo","version":"0.1.0","inputs":{"text":"hello"}}' \
 *     http://localhost:8001/ragdoll.plugin.v1.PluginRuntime/Execute
 *   → {"outputs":{"echoed":"hello","length":5}}
 */
import type * as http from "node:http";
import type * as http2 from "node:http2";
import { create } from "@bufbuild/protobuf";
import { ExecuteResponseSchema } from "@ragdoll/proto-gen/plugin";
import { createPluginServer, type ExecuteHandler } from "@ragdoll/plugin-sdk/author";
import { ECHO_MANIFEST } from "./manifest.ts";

const execute: ExecuteHandler = (req) => {
  // req.inputs is a google.protobuf.Struct (JsonObject in TypeScript). The
  // runtime forwards the pipeline node's input port values here keyed by
  // port name. For declared input ports the canonical pattern is to read
  // them with a defensive cast; the manifest declares `text` as required so
  // an unset value is a pipeline-spec bug, not a plugin one.
  const text = String((req.inputs as { text?: unknown })?.text ?? "");
  return create(ExecuteResponseSchema, {
    outputs: { echoed: text, length: text.length }
  });
};

export function createEchoServer(): http.Server | http2.Http2Server {
  return createPluginServer({
    pluginId: ECHO_MANIFEST.id,
    version: ECHO_MANIFEST.version,
    handlers: { execute }
    // transport defaults to "http1" — Connect HTTP/JSON works over h1,
    // which keeps the curl smoke-probe in the README dead simple. Set
    // transport: "http2" if your plugin needs native gRPC or
    // full-duplex bidi.
  });
}

export function main(): void {
  const port = Number(process.env.PORT ?? 8001);
  const server = createEchoServer();
  server.listen(port, () => {
    console.log(`[${ECHO_MANIFEST.id}@${ECHO_MANIFEST.version}] listening on :${port}`);
  });
}

// `node --experimental-strip-types src/server.ts` runs this. The `import.meta`
// check keeps the test path (which imports `createEchoServer`) from
// auto-starting the listener.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
