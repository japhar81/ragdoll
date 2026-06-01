"""Python plugin author SDK — thin wrapper around connectrpc.

Mirror of `@ragdoll/plugin-sdk/author` (TypeScript). Same one-call server
shape, same .proto contract, same shared concerns layer. Plugin authors
importing `ragdoll_plugin_py` get:

  - The `PluginRuntime` service descriptors from the shared proto/plugin.proto
  - `create_plugin_server(plugin_id, version, handlers)` returning a
    Connect ASGI app ready to mount on Hypercorn / uvicorn / Starlette
  - `default_interceptors()` bundling auth/tenant/allow-list/OTel concerns
    so plugin authors don't reimplement them per plugin

Phase A scaffold; Phase B fills in the interceptor implementations.

Example:

    from ragdoll_plugin_py import create_plugin_server, ExecuteHandler
    from ragdoll_plugin_py.proto.plugin_pb2 import ExecuteResponse
    from hypercorn.asyncio import serve
    from hypercorn.config import Config
    import asyncio

    async def execute(req, ctx) -> ExecuteResponse:
        return ExecuteResponse(outputs={"echoed": req.inputs})

    app = create_plugin_server(
        plugin_id="my_echo",
        version="0.1.0",
        handlers={"execute": execute},
    )

    config = Config()
    config.bind = ["0.0.0.0:8000"]
    asyncio.run(serve(app, config))
"""

# Re-export the SDK's user-facing surface from the implementation module so
# `from ragdoll_plugin_py import create_plugin_server` works at the package
# root. Generated proto descriptors live at `ragdoll_plugin_py.proto.*` and
# are imported by callers directly (mirrors the Node side's
# `import { ExecuteRequest } from "@ragdoll/proto-gen/plugin"`).
from .server import (
    create_plugin_server,
    default_interceptors,
    ExecuteHandler,
    StreamHandler,
    ClientStreamHandler,
    BidiHandler,
    PluginHandlers,
)

__all__ = [
    "create_plugin_server",
    "default_interceptors",
    "ExecuteHandler",
    "StreamHandler",
    "ClientStreamHandler",
    "BidiHandler",
    "PluginHandlers",
]
