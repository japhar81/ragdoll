"""Connect server factory for Python plugin authors.

Mirror of `packages/plugin-sdk/src/author.ts` (createPluginServer).
"""
from __future__ import annotations

from typing import Any, AsyncIterator, Awaitable, Callable, Iterable, Optional, Protocol, TypedDict, Union

from connectrpc.interceptor import Interceptor
from connectrpc.request import RequestContext

from .proto.plugin_pb2 import ExecuteChunk, ExecuteRequest, ExecuteResponse, HealthRequest, HealthResponse
from .proto.plugin_connect import (
    PluginRuntime as _GeneratedPluginProtocol,
    PluginRuntimeASGIApplication,
)
from .interceptors import default_interceptors

# ---- Handler signatures ---------------------------------------------------
# Author-facing aliases mirror the Node SDK's TypeScript exports
# (ExecuteHandler, StreamHandler, ClientStreamHandler, BidiHandler) so the
# two SDKs stay 1:1 in surface area.

# Note: Python's protocols can't express "may be sync or async" cleanly, so
# we accept either form via Union. The dispatcher in `create_plugin_server`
# awaits coroutines and returns sync values directly.
ExecuteHandler = Callable[
    [ExecuteRequest, RequestContext],
    Union[ExecuteResponse, Awaitable[ExecuteResponse]],
]

StreamHandler = Callable[
    [ExecuteRequest, RequestContext],
    AsyncIterator[ExecuteChunk],
]

ClientStreamHandler = Callable[
    [AsyncIterator[ExecuteRequest], RequestContext],
    Awaitable[ExecuteResponse],
]

BidiHandler = Callable[
    [AsyncIterator[ExecuteRequest], RequestContext],
    AsyncIterator[ExecuteChunk],
]


class PluginHandlers(TypedDict, total=False):
    """Handlers an author registers. Only `execute` is required."""

    health: Callable[[HealthRequest, RequestContext], Union[HealthResponse, Awaitable[HealthResponse]]]
    execute: ExecuteHandler
    execute_server_stream: StreamHandler
    execute_client_stream: ClientStreamHandler
    execute_bidi: BidiHandler


# ---- Server factory --------------------------------------------------------


def create_plugin_server(
    *,
    plugin_id: str,
    version: str,
    handlers: PluginHandlers,
    interceptors: Optional[Iterable[Interceptor]] = None,
) -> PluginRuntimeASGIApplication:
    """Build an ASGI app that serves the PluginRuntime over Connect.

    The returned app handles Connect (HTTP/JSON), gRPC-Web, and (on an HTTP/2
    server like Hypercorn) native gRPC + true full-duplex bidi from one
    handler. Mount it on the ASGI server of your choice:

        from hypercorn.asyncio import serve
        from hypercorn.config import Config
        config = Config()
        config.bind = ["0.0.0.0:8000"]
        asyncio.run(serve(app, config))

    Or mount alongside FastAPI via Starlette:

        from starlette.applications import Starlette
        from starlette.routing import Mount
        app = Starlette(routes=[
            Mount("/legacy", app=fastapi_app),
            Mount("/", app=create_plugin_server(...)),
        ])

    Per-method behaviour:
      - Author MUST supply `execute` (unary). Everything else is opt-in.
      - `execute_server_stream` falls back to wrapping the unary `execute`
        result as one final chunk, so older Connect clients keep working.
      - `execute_client_stream` defaults to draining the input stream and
        calling `execute` on the last request seen.
      - `execute_bidi` defaults to one-response-per-request (unary chain).
      - `health` defaults to returning ok + the registered plugin_id.

    Shared concerns (auth bearer, tenant-scope, allow-list, OTel) are
    bundled via `default_interceptors()` and composed AFTER any
    author-supplied interceptors so author overrides run first.
    """
    if "execute" not in handlers:
        raise ValueError("create_plugin_server: handlers['execute'] is required")

    user_interceptors = list(interceptors or [])
    composed = user_interceptors + default_interceptors()

    impl = _BoundPlugin(plugin_id=plugin_id, version=version, handlers=handlers)
    return PluginRuntimeASGIApplication(impl, interceptors=composed)


# ---- Internal dispatcher ---------------------------------------------------


class _BoundPlugin(_GeneratedPluginProtocol):
    """Adapts a PluginHandlers dict to the connectrpc Protocol the generated
    service expects. Coroutine-or-sync handlers are awaited transparently."""

    def __init__(self, *, plugin_id: str, version: str, handlers: PluginHandlers) -> None:
        self._plugin_id = plugin_id
        self._version = version
        self._handlers = handlers

    async def health(self, req: HealthRequest, ctx: RequestContext) -> HealthResponse:
        author_health = self._handlers.get("health")
        if author_health is not None:
            result = author_health(req, ctx)
            if hasattr(result, "__await__"):
                result = await result  # type: ignore[assignment]
            return result  # type: ignore[return-value]
        return HealthResponse(
            ok=True, plugins=[self._plugin_id], message=f"{self._plugin_id}@{self._version}"
        )

    async def execute(self, req: ExecuteRequest, ctx: RequestContext) -> ExecuteResponse:
        result = self._handlers["execute"](req, ctx)
        if hasattr(result, "__await__"):
            result = await result  # type: ignore[assignment]
        return result  # type: ignore[return-value]

    def execute_server_stream(
        self, req: ExecuteRequest, ctx: RequestContext
    ) -> AsyncIterator[ExecuteChunk]:
        author_stream = self._handlers.get("execute_server_stream")
        if author_stream is not None:
            return author_stream(req, ctx)
        return self._unary_as_stream(req, ctx)

    async def execute_client_stream(
        self, reqs: AsyncIterator[ExecuteRequest], ctx: RequestContext
    ) -> ExecuteResponse:
        author_client = self._handlers.get("execute_client_stream")
        if author_client is not None:
            return await author_client(reqs, ctx)
        # Default: drain input, execute on the LAST request seen.
        last: Optional[ExecuteRequest] = None
        async for r in reqs:
            last = r
        if last is None:
            return ExecuteResponse()
        return await self.execute(last, ctx)

    def execute_bidi(
        self, reqs: AsyncIterator[ExecuteRequest], ctx: RequestContext
    ) -> AsyncIterator[ExecuteChunk]:
        author_bidi = self._handlers.get("execute_bidi")
        if author_bidi is not None:
            return author_bidi(reqs, ctx)
        return self._bidi_unary_chain(reqs, ctx)

    async def _unary_as_stream(
        self, req: ExecuteRequest, ctx: RequestContext
    ) -> AsyncIterator[ExecuteChunk]:
        resp = await self.execute(req, ctx)
        yield ExecuteChunk(final=resp, node_id=req.node_id)

    async def _bidi_unary_chain(
        self, reqs: AsyncIterator[ExecuteRequest], ctx: RequestContext
    ) -> AsyncIterator[ExecuteChunk]:
        async for r in reqs:
            resp = await self.execute(r, ctx)
            yield ExecuteChunk(final=resp, node_id=r.node_id)
