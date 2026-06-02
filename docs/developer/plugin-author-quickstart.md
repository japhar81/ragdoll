# Plugin author quickstart

This guide walks an author through shipping an *external plugin* on top of
the connect-rpc transport (ADR
[0022](../adr/0022-connect-rpc-plugin-transport.md)). The runtime invokes
your plugin over Connect HTTP/JSON, native gRPC, or gRPC-Web — same handler,
client picks the wire.

Two language SDKs ship today with identical surface area:

- **Node**: `@ragdoll/plugin-sdk/author` — covered below in sections 1-8.
- **Python**: `ragdoll-plugin-py` — covered in sections 9-12; same .proto
  contract, same `default_interceptors()` semantics, same one-call
  `create_plugin_server()` shape.

Pick whichever your plugin happens to be written in. The runtime treats them
identically — every `RegisteredPlugin` entry with an `external.baseUrl` is
called via the same dispatcher regardless of which language served it.

## 1. Define the manifest

Plugins are addressed by `category:id:version`. The manifest lives wherever
your loader looks (env-var `PYTHON_PLUGIN_URL` for the bundled crawl4ai
sidecar; custom registries for other deployments).

```ts
import type { PluginManifest } from "@ragdoll/plugin-sdk";

export const myEchoManifest: PluginManifest = {
  id: "my_echo",
  name: "Echo plugin",
  version: "0.1.0",
  category: "transformer",
  description: "Echoes input back. Demo / template.",
  inputPorts: [{ name: "text", required: true }],
  outputPorts: [{ name: "echoed" }],
  // Opt into streaming if your plugin can yield incremental output.
  // Without this flag, the runtime always uses the unary RPC even if the
  // caller wires an onToken sink.
  streaming: false
};
```

## 2. Implement the server

`@ragdoll/plugin-sdk/author` exposes `createPluginServer()` — one function,
one process, all three protocols.

```ts
import { createPluginServer, type ExecuteHandler } from "@ragdoll/plugin-sdk/author";
import { myEchoManifest } from "./manifest.ts";

const execute: ExecuteHandler = async (req) => {
  // req.inputs is JsonObject from the .proto Struct field
  const text = (req.inputs as { text?: string })?.text ?? "";
  return {
    outputs: { echoed: text },
    metadata: { length: text.length }
  };
};

const server = createPluginServer({
  pluginId: myEchoManifest.id,
  version: myEchoManifest.version,
  handlers: { execute }
});

server.listen(8001, () => {
  console.log(`${myEchoManifest.id} listening on :8001`);
});
```

That's the whole thing. The SDK mounts an h2c listener that serves Connect
HTTP/JSON, gRPC-Web, and native gRPC simultaneously from the same router.

Run it locally:

```sh
node --experimental-strip-types my-echo-server.ts
```

Smoke-test the unary call without any client SDK:

```sh
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"plugin":"my_echo","version":"0.1.0","inputs":{"text":"hello"}}' \
  http://localhost:8001/ragdoll.plugin.v1.PluginRuntime/Execute
# → {"outputs":{"echoed":"hello"},"metadata":{"length":5}}
```

## 3. Register with the runtime

Tell the runtime where to find the plugin. The bundled `plugin-loader`
reads `PYTHON_PLUGIN_URL` for the crawl4ai sidecar; for your own plugin
either set up an analogous env var or register programmatically:

```ts
import { PluginRegistry } from "@ragdoll/plugin-sdk";
import { myEchoManifest } from "./manifest.ts";

registry.register({
  mode: "external",
  manifest: myEchoManifest,
  external: {
    baseUrl: "http://localhost:8001",
    // protocol defaults to "connect" (HTTP/1.1 + JSON)
    // bump to "grpc" + httpVersion: "2" for backpressure-heavy streaming
    timeoutMs: 60_000
  }
});
```

The runtime will dispatch unary calls through `PluginRuntime.Execute` and
streaming calls (when `manifest.streaming = true` AND the caller provides
an `onToken` sink) through `PluginRuntime.ExecuteServerStream`.

## 4. Streaming plugins

Server-streaming — the common case (LLM tokens, crawl progress, transcript
fragments). Author yields `ExecuteChunk` instances:

```ts
import {
  createPluginServer,
  type ExecuteRequest,
  type ExecuteChunk
} from "@ragdoll/plugin-sdk/author";

async function* streamHandler(req: ExecuteRequest): AsyncIterable<ExecuteChunk> {
  const prompt = String((req.inputs as { prompt?: string })?.prompt ?? "");
  for (const word of prompt.split(" ")) {
    yield { payload: { case: "token", value: word + " " }, nodeId: req.nodeId };
    await new Promise((r) => setTimeout(r, 30));
  }
  // Final chunk carries the complete envelope. Optional — if omitted, the
  // runtime synthesises one from accumulated deltas.
  yield {
    payload: {
      case: "final",
      value: { outputs: { text: prompt }, $typeName: "ragdoll.plugin.v1.ExecuteResponse" } as never
    },
    nodeId: req.nodeId
  };
}

const server = createPluginServer({
  pluginId: "my_streamer",
  version: "0.1.0",
  handlers: {
    execute: async () => ({ outputs: {} } as never),  // fallback for non-streaming callers
    executeServerStream: streamHandler
  }
});
```

Client-streaming and bidi work the same way — see
`packages/plugin-sdk/src/author.ts` for `ClientStreamHandler` and
`BidiHandler` shapes. Reach for those only when your plugin genuinely needs
the corresponding RPC kind; the runtime picks the right RPC based on
manifest declarations + caller intent.

## 5. Choosing a protocol

The server always answers Connect HTTP/JSON, native gRPC, and gRPC-Web from
the same handler — the *client* chooses which wire to speak. Defaults:

| Scenario                                  | `protocol`   | `httpVersion` | Why |
|-------------------------------------------|--------------|---------------|-----|
| Most calls (unary, server-stream, debug)  | `connect` (default) | `1.1` (default) | Works through every proxy/WAF; JSON is curl-debuggable; no h2 negotiation required |
| Backpressure-heavy streaming              | `grpc`       | `2` (required) | Real flow control + lower per-frame overhead |
| Full-duplex bidi mid-stream interleave    | `connect`    | `2`           | bidi over HTTP/1.1 is half-duplex; need h2 end-to-end |
| Browser-originated (rare for plugins)     | `grpc-web`   | `1.1` or `2`  | Browsers can't speak native gRPC |

`appProtocol: http2` on the Service is mandatory for any client using
`protocol: "grpc"` (Phase B work — see ADR 0022 deferred section).

## 6. Testing your plugin

A good test starts an in-process Connect server and hits it with the SDK's
real client. Mocking the wire shape is fragile; mocking the server is fine.

```ts
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { PluginRuntime } from "@ragdoll/proto-gen/plugin";

test("my_echo round-trips inputs", async () => {
  const server = http.createServer(
    connectNodeAdapter({
      routes: (r) => {
        r.service(PluginRuntime, {
          async execute(req) {
            return { outputs: { echoed: (req.inputs as { text: string }).text } } as never;
          },
          async health() { return { ok: true, plugins: ["my_echo"], message: "" }; },
          async *executeServerStream() {},
          async executeClientStream() { throw new Error("unused"); },
          async *executeBidi() {}
        });
      }
    })
  );
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const port = (server.address() as { port: number }).port;
  const client = createClient(
    PluginRuntime,
    createConnectTransport({ baseUrl: `http://127.0.0.1:${port}`, httpVersion: "1.1" })
  );
  const resp = await client.execute({ plugin: "my_echo", inputs: { text: "hi" } } as never);
  assert.deepEqual(resp.outputs, { echoed: "hi" });
  await new Promise<void>((done) => server.close(() => done()));
});
```

## 7. Regenerating the .proto

Edit `proto/plugin.proto`, then `npm run generate`. The TS descriptors land
in `packages/proto-gen/src/plugin_pb.ts` and any plugin (or the runtime) that
imports from `@ragdoll/proto-gen` picks up the change on the next build /
type-check.

Breaking changes to the wire contract bump the proto package
(`ragdoll.plugin.v2`); additive changes keep `v1`. The `buf breaking`
config in `buf.yaml` enforces this.

## 8. Common pitfalls

- **Forgetting `manifest.streaming: true`.** The runtime routes through
  `ExecuteServerStream` only when both flags align (manifest + caller's
  `onToken`). Without the manifest flag your stream handler is dead code.
- **Returning the wrong proto shape from a stream handler.** `ExecuteChunk`
  uses a `oneof payload` — your `yield` must include `{ payload: { case: "token" | "delta" | "final", value: ... } }`. Type errors here catch most
  mistakes at compile time.
- **Mutating `req` in place.** Treat the request object as frozen — the
  Connect runtime may reuse the buffer between concurrent calls in some
  transports. Copy what you need.
- **Heavy work in `health`.** `Health` is a cheap probe; do the minimum to
  prove your plugin is ready. The runtime polls it on a tight cadence.

---

# Plugin author quickstart (Python)

The Python SDK ships as `ragdoll-plugin-py` in `packages/plugin-py/`. The
runtime calls Python plugins over the same connect-rpc contract the Node
side uses — operators register the plugin endpoint exactly the same way
(`mode: "external"`, `external: { baseUrl, ... }`); the runtime doesn't
care which language served the handler.

The bundled `services/python-plugins` sidecar (crawl4ai + scrapy +
rerank_bge) is the reference consumer; copy the pattern when you write a
new Python plugin.

## 9. Install + manifest

```sh
pip install ragdoll-plugin-py          # core (Connect over ASGI)
pip install ragdoll-plugin-py[otel]    # + OpenTelemetry traceparent propagation
```

Intel-Mac dev needs Rust (the `pyqwest` transitive dep doesn't ship an
Intel-mac wheel) — `brew install rust`. Apple Silicon + Linux + every prod
target install from wheels with no Rust. See the main README.

Manifests are declared on the Node side (the runtime owns the catalog).
Tell the runtime your plugin exists by registering it from any Node
bootstrap path:

```ts
registry.register({
  mode: "external",
  manifest: {
    id: "my_python_plugin",
    name: "My Python Plugin",
    version: "0.1.0",
    category: "transformer",
    description: "..."
  },
  external: { baseUrl: "http://my-python-plugin:8000", timeoutMs: 60_000 }
});
```

## 10. Implement the server

```python
# my_server.py
import asyncio
from hypercorn.asyncio import serve
from hypercorn.config import Config

from ragdoll_plugin_py import create_plugin_server
from ragdoll_plugin_py.proto.plugin_pb2 import ExecuteRequest, ExecuteResponse
from google.protobuf.struct_pb2 import Struct

async def execute(req: ExecuteRequest, ctx) -> ExecuteResponse:
    # req.inputs is a google.protobuf.Struct; convert to a dict via
    # google.protobuf.json_format.MessageToDict if you need plain values,
    # OR access fields directly via the Struct accessors.
    from google.protobuf.json_format import MessageToDict
    inputs = MessageToDict(req.inputs) if req.HasField("inputs") else {}
    text = inputs.get("text", "")
    outputs = Struct(); outputs.update({"echoed": text, "length": len(text)})
    return ExecuteResponse(outputs=outputs)

app = create_plugin_server(
    plugin_id="my_python_plugin",
    version="0.1.0",
    handlers={"execute": execute},
)

if __name__ == "__main__":
    config = Config()
    config.bind = ["0.0.0.0:8000"]
    asyncio.run(serve(app, config))
```

`create_plugin_server` returns an ASGI app you can `serve()` directly with
Hypercorn (for HTTP/2 + native gRPC + full-duplex bidi support) or mount
inside Starlette / FastAPI for sharing the listener with other routes. The
bundled `services/python-plugins/app/main.py` demonstrates the
shared-listener pattern (5-line Starlette `/healthz` shim + the Connect
ASGI app on the same port, picked apart by a tiny manual ASGI dispatcher).

## 11. Streaming + the other RPC kinds

The handler signatures mirror the Node SDK:

```python
from typing import AsyncIterator
from ragdoll_plugin_py.proto.plugin_pb2 import ExecuteChunk

async def execute_server_stream(req: ExecuteRequest, ctx) -> AsyncIterator[ExecuteChunk]:
    prompt = MessageToDict(req.inputs).get("prompt", "")
    for word in prompt.split():
        yield ExecuteChunk(token=word + " ", node_id=req.node_id)
        await asyncio.sleep(0.03)
    # Optional final envelope; if omitted, the runtime synthesises one.
    final = ExecuteResponse(outputs=Struct(value={"text": prompt}))
    yield ExecuteChunk(final=final, node_id=req.node_id)

app = create_plugin_server(
    plugin_id="my_streamer",
    version="0.1.0",
    handlers={
        "execute": ...,
        "execute_server_stream": execute_server_stream,
    },
)
```

Pass `execute_client_stream` and `execute_bidi` if you need them. Default
fallbacks: client-stream calls `execute` on the last request seen; bidi
emits one response chunk per request (unary chain).

## 12. Shared concerns (auth, tenant, allow-list, OTel)

`create_plugin_server` bundles `default_interceptors()` automatically.
Configuration is env-driven and degrades to no-op when unset:

```sh
export RAGDOLL_PLUGIN_TOKEN=...                # required bearer on every RPC
export RAGDOLL_PLUGIN_REQUIRE_TENANT=1         # reject calls without x-ragdoll-tenant
export RAGDOLL_PLUGIN_HOST_ALLOWLIST=foo,bar   # reject calls from off-list x-forwarded-host
```

OpenTelemetry traceparent propagation activates automatically when the
`[otel]` extra is installed.

To add your own interceptors, pass them via `interceptors=` — they run
BEFORE the defaults (so you can short-circuit, e.g. for a custom rate-limit
check before auth is even attempted):

```python
app = create_plugin_server(
    plugin_id="my_plugin",
    version="0.1.0",
    handlers={"execute": execute},
    interceptors=[MyRateLimitInterceptor(), MyAuditLogInterceptor()],
)
```

## 13. Testing your Python plugin

A good test starts your `create_plugin_server` app on an ephemeral port
and hits it with the SDK's Connect client. The pattern from the bundled
sidecar:

```python
import asyncio
import httpx
import pytest
from hypercorn.asyncio import serve
from hypercorn.config import Config

from my_server import app  # the ASGI app returned by create_plugin_server

@pytest.mark.asyncio
async def test_execute_echoes_inputs():
    config = Config()
    config.bind = ["127.0.0.1:0"]  # ephemeral
    server_task = asyncio.create_task(serve(app, config))
    try:
        # ... resolve the bound port from hypercorn's lifespan signals,
        # then httpx.post() at /ragdoll.plugin.v1.PluginRuntime/Execute
        ...
    finally:
        server_task.cancel()
```

For a higher-fidelity test that exercises the FULL Node-runtime → Python
sidecar chain, see `tests/e2e/cross-language-plugin.e2e.test.ts` — it
spins up the bundled python-plugins container and asserts the Connect
contract end-to-end.

## 14. Python pitfalls

- **`req.config` and friends are `Struct`, not dict.** Use
  `from google.protobuf.json_format import MessageToDict` to convert; or
  read individual fields with `struct.fields["key"].string_value` /
  `.number_value`. Direct attribute access on `Struct` does not work.
- **`Struct` represents all numbers as float64.** A config value `3` comes
  through as `3.0`. Cast to `int` if you index a list with it (`range(int(n))`).
- **Hypercorn vs uvicorn.** uvicorn is HTTP/1.1 only — Connect HTTP/JSON
  works, but native gRPC and full-duplex bidi require Hypercorn (or
  Daphne). The bundled sidecar uses Hypercorn for this reason.
- **The generated `plugin_connect.py` has a flat import (`import plugin_pb2`)** that breaks when the module is loaded as part of a package.
  `scripts/gen-proto.sh` post-processes the generated file to rewrite this
  to a relative import. Always run codegen via the script, not raw protoc.
