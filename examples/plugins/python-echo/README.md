# python-echo

Bare-minimum external Python plugin. Copy this directory as the starting
point for your own plugin.

The whole implementation is **~30 lines** in `app/server.py` — one
handler function + one `create_plugin_server` call. The manifest lives
on the Node runtime side (registered via `plugin-loader` like every
other external plugin) since that's where the Builder reads it.

## Run it

```sh
# from the repo root
docker build -f examples/plugins/python-echo/Dockerfile -t python-echo .
docker run --rm -p 8002:8002 python-echo
```

Or run directly with Poetry (after symlinking the SDK):

```sh
# from the repo root
ln -sf "$PWD/packages/plugin-py" /opt/ragdoll-plugin-py   # one-time, may need sudo
cd examples/plugins/python-echo
poetry install
poetry run hypercorn app.server:app --bind 0.0.0.0:8002
```

## Smoke-test with curl

Connect unary is plain HTTP POST with a JSON body — no SDK required:

```sh
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"plugin":"python_echo","version":"0.1.0","inputs":{"text":"hello"}}' \
  http://localhost:8002/ragdoll.plugin.v1.PluginRuntime/Execute
# → {"outputs":{"echoed":"hello","length":5}}
```

Liveness probe matches every other PluginRuntime server:

```sh
curl -s -X POST -H 'Content-Type: application/json' -d '{}' \
  http://localhost:8002/ragdoll.plugin.v1.PluginRuntime/Health
# → {"ok":true,"plugins":["python_echo"],"message":"python_echo@0.1.0"}
```

## Register with the runtime

The runtime side is identical to any other external plugin — declare a
`PluginManifest` and a `RegisteredPlugin` pointing at the server's
baseUrl. Add this to your bootstrap path (or wherever you wire
`plugin-loader`):

```ts
import { PluginRegistry } from "@ragdoll/plugin-sdk";

registry.register({
  mode: "external",
  manifest: {
    id: "python_echo",
    name: "Python Echo (example)",
    version: "0.1.0",
    category: "transformer",
    description: "Echo plugin example — Python sibling of node-echo.",
    inputPorts: [{ name: "text", required: true }],
    outputPorts: [
      { name: "echoed", description: "The input text, unchanged." },
      { name: "length", description: "Character length of the input." }
    ]
  },
  external: {
    baseUrl: "http://python-echo:8002",
    // protocol defaults to "connect" (HTTP/1.1 + JSON). Bump to "grpc" +
    // httpVersion: "2" for backpressure-heavy streaming.
    timeoutMs: 60_000
  }
});
```

## Notes on the Struct ↔ dict conversion

`req.inputs` is a `google.protobuf.Struct`, not a plain dict. Two
common patterns to extract values:

```python
# Option A — convert the whole Struct to a dict (preferred for small
# payloads; the standard well-known-types JSON mapping handles
# nested objects, lists, numbers, bools cleanly):
from google.protobuf.json_format import MessageToDict
inputs = MessageToDict(req.inputs, preserving_proto_field_name=True)
text = inputs.get("text", "")

# Option B — read a single field directly (avoids the dict allocation
# for hot paths):
text = req.inputs.fields["text"].string_value
```

The example uses Option A. Numbers come through as Python `float`
regardless of the wire type — cast to `int` if you index a list with one.

## Test it

`tests/e2e/example-plugins.test.ts` (at the repo root) starts this
plugin via docker, calls it through the full `executeRegisteredPlugin`
Connect transport, and asserts the round-trip. The test skips
gracefully when docker isn't available.

## What to change for your plugin

1. Rename `python_echo` everywhere (handler `PLUGIN_ID`, package name,
   Dockerfile port, smoke probe URL, registration manifest).
2. Add config / secrets schemas to the manifest if the plugin reads any
   (those live on the Node side, see
   `docs/developer/plugin-author-quickstart.md` §9-14).
3. Replace the echo body with real work. The handler receives a proto
   `ExecuteRequest`; `req.config` carries resolved config,
   `req.secrets` carries resolved secret values, `req.tenant_id` /
   `req.environment` / `req.request_id` give you the runtime context.
4. Add streaming if relevant: pass an `execute_server_stream` handler
   to `create_plugin_server` (see `plugin-author-quickstart.md` §11).
