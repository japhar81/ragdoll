"""python-echo: bare-minimum external Python plugin.

The Python sibling of `examples/plugins/node-echo/`. Receives `{ text }`
on the `text` input port, emits `{ echoed, length }` on the outputs.
Whole implementation is one handler + one `create_plugin_server` call.

Run locally:

    cd examples/plugins/python-echo
    poetry install
    poetry run hypercorn app.server:app --bind 0.0.0.0:8002

Or run via docker (from the repo root):

    docker build -f examples/plugins/python-echo/Dockerfile -t python-echo .
    docker run --rm -p 8002:8002 python-echo

Smoke probe (Connect unary is plain HTTP POST with a JSON body):

    curl -s -X POST -H 'Content-Type: application/json' \\
      -d '{"plugin":"python_echo","version":"0.1.0","inputs":{"text":"hello"}}' \\
      http://localhost:8002/ragdoll.plugin.v1.PluginRuntime/Execute
    # → {"outputs":{"echoed":"hello","length":5}}
"""

from __future__ import annotations

from google.protobuf.json_format import MessageToDict
from google.protobuf.struct_pb2 import Struct

from ragdoll_plugin_py import create_plugin_server
from ragdoll_plugin_py.proto.plugin_pb2 import ExecuteRequest, ExecuteResponse

PLUGIN_ID = "python_echo"
PLUGIN_VERSION = "0.1.0"


async def execute(req: ExecuteRequest, ctx) -> ExecuteResponse:
    # req.inputs is a google.protobuf.Struct. Convert with MessageToDict
    # to get a plain dict; alternatively read fields directly via
    # `req.inputs.fields["text"].string_value`.
    inputs = MessageToDict(req.inputs, preserving_proto_field_name=True) if req.HasField("inputs") else {}
    text = str(inputs.get("text", ""))
    outputs = Struct()
    outputs.update({"echoed": text, "length": len(text)})
    return ExecuteResponse(outputs=outputs)


# Module-level ASGI app so Hypercorn / uvicorn / Starlette can mount it
# directly. The SDK's `create_plugin_server` returns a
# `PluginRuntimeASGIApplication` — a regular ASGI callable.
app = create_plugin_server(
    plugin_id=PLUGIN_ID,
    version=PLUGIN_VERSION,
    handlers={"execute": execute},
)


if __name__ == "__main__":
    # Convenience: `python -m app.server` from this directory launches the
    # server on PORT (default 8002). Real deployments should drive Hypercorn
    # from the CLI for proper signal handling — see the docker CMD below.
    import asyncio
    import os
    from hypercorn.asyncio import serve
    from hypercorn.config import Config

    config = Config()
    config.bind = [f"0.0.0.0:{os.environ.get('PORT', '8002')}"]
    print(f"[{PLUGIN_ID}@{PLUGIN_VERSION}] listening on {config.bind[0]}")
    asyncio.run(serve(app, config))
