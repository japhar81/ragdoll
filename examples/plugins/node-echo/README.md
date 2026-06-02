# node-echo

Bare-minimum external Node plugin. Copy this directory as the starting
point for your own plugin.

The whole implementation is **30 lines of code** across two files —
`src/manifest.ts` (the `PluginManifest` declaration) and `src/server.ts`
(one `ExecuteHandler` + one `createPluginServer` call). Nothing else.

## Run it

```sh
# from the repo root
docker build -f examples/plugins/node-echo/Dockerfile -t node-echo .
docker run --rm -p 8001:8001 node-echo
```

Or run directly with the in-tree SDK:

```sh
# from the repo root
node --experimental-strip-types examples/plugins/node-echo/src/server.ts
```

## Smoke-test with curl

Connect unary is plain HTTP POST with a JSON body — no SDK required:

```sh
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"plugin":"node_echo","version":"0.1.0","inputs":{"text":"hello"}}' \
  http://localhost:8001/ragdoll.plugin.v1.PluginRuntime/Execute
# → {"outputs":{"echoed":"hello","length":5}}
```

Liveness probe matches every other PluginRuntime server:

```sh
curl -s -X POST -H 'Content-Type: application/json' -d '{}' \
  http://localhost:8001/ragdoll.plugin.v1.PluginRuntime/Health
# → {"ok":true,"plugins":["node_echo"],"message":"node_echo@0.1.0"}
```

## Register with the runtime

The runtime needs to know your plugin exists. The bundled python-plugins
sidecar is auto-registered when `PYTHON_PLUGIN_URL` is set; for your own
plugin, do the equivalent in your bootstrap path:

```ts
import { PluginRegistry } from "@ragdoll/plugin-sdk";
import { ECHO_MANIFEST } from "./examples/plugins/node-echo/src/manifest.ts";

registry.register({
  mode: "external",
  manifest: ECHO_MANIFEST,
  external: {
    baseUrl: "http://node-echo:8001",
    // protocol defaults to "connect" (HTTP/1.1 + JSON). Bump to "grpc" +
    // httpVersion: "2" for backpressure-heavy streaming.
    timeoutMs: 60_000
  }
});
```

Once registered, the plugin shows up in the Builder palette under the
`transformer` category. Drop a node, wire `text` in and `echoed` /
`length` out, and you're done.

## Test it

`tests/e2e/example-plugins.test.ts` (at the repo root) spins up this
plugin's `createEchoServer()` on an ephemeral port, calls it through the
full `executeRegisteredPlugin` Connect transport, and asserts the
round-trip. If the SDK contract ever moves under our feet, that test
catches it before the example bit-rots.

## What to change for your plugin

1. Rename `node_echo` everywhere (manifest, package.json, Dockerfile
   port, smoke probe URL).
2. Add config / secrets schemas to the manifest if the plugin reads any
   (see `docs/developer/plugin-author-quickstart.md` §1 for the
   `configSchema` / `secretsSchema` shape).
3. Replace the echo body with real work. The handler receives a proto
   `ExecuteRequest`; `req.inputs` is the merged input-port bag,
   `req.config` is the resolved config, `req.secrets` carries resolved
   secret values.
4. Add streaming if relevant: set `manifest.streaming = true` and pass
   `executeServerStream` to `createPluginServer` (see
   `plugin-author-quickstart.md` §4 for the chunk shape).
