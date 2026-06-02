"""Build the Connect ASGI app over the per-plugin HANDLERS dict.

Each handler in `HANDLERS` (declared in `app/main.py`) is a sync function
that accepts a pydantic `ExecuteRequest` (`app/models.py`) and returns a
dict shaped `{outputs, metadata?, usage?, artifacts?}`. This module:

  1. Receives a proto `ExecuteRequest` on the Connect wire,
  2. Decodes its `google.protobuf.Struct` fields into plain Python dicts,
  3. Wraps them in the pydantic `ExecuteRequest` the handler expects,
  4. Wraps the handler's dict result back into a proto `ExecuteResponse`.

Streaming RPCs (server-stream, client-stream, bidi) are NOT implemented
explicitly — all three Python plugins are unary. `create_plugin_server`
in `ragdoll_plugin_py` falls back to wrapping the unary result as a
single `final` chunk for clients that call ExecuteServerStream.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List

from connectrpc.code import Code
from connectrpc.errors import ConnectError
from connectrpc.request import RequestContext
from google.protobuf.json_format import MessageToDict
from google.protobuf.struct_pb2 import Struct
from ragdoll_plugin_py import create_plugin_server
from ragdoll_plugin_py.proto.plugin_pb2 import (
    ExecuteRequest as ProtoExecuteRequest,
    ExecuteResponse as ProtoExecuteResponse,
    HealthRequest as ProtoHealthRequest,
    HealthResponse as ProtoHealthResponse,
    Usage as ProtoUsage,
    Artifact as ProtoArtifact,
)

from app.models import (
    ExecuteRequest,
    ExecutionContext,
    NodeRef,
    PluginRef,
    ResolvedConfig,
)


logger = logging.getLogger("ragdoll.python-plugins.connect")


def _struct_to_dict(struct: Struct | None) -> Dict[str, Any]:
    """Proto Struct -> plain Python dict.

    Uses MessageToDict so we get native JSON-compatible values (str / int /
    float / bool / None / list / dict) without the wrapper-class noise.
    """
    if struct is None:
        return {}
    return MessageToDict(struct, preserving_proto_field_name=True) or {}


def _dict_to_struct(value: Dict[str, Any] | None) -> Struct:
    """Plain dict -> proto Struct."""
    s = Struct()
    if value:
        s.update(value)
    return s


def _proto_to_pydantic(req: ProtoExecuteRequest) -> ExecuteRequest:
    """Decode the proto request into the pydantic shape the handlers accept.

    Field mapping:
      proto.plugin / proto.version  -> pydantic.plugin (PluginRef)
      proto.node_id                  -> pydantic.node.id
      proto.config                   -> pydantic.config (Struct -> dict)
      proto.inputs                   -> pydantic.inputs
      proto.secrets                  -> pydantic.secrets
      proto.tenant_id / .environment / .request_id -> pydantic.context.*

    Dataset is dropped on the floor for these three plugins (none of them
    bind a dataset slot). When the proto carries a dataset for a future
    plugin, extend this translator.
    """
    return ExecuteRequest(
        plugin=PluginRef(id=req.plugin, version=req.version or None),
        node=NodeRef(id=req.node_id or None),
        inputs=_struct_to_dict(req.inputs) if req.HasField("inputs") else {},
        config=_struct_to_dict(req.config) if req.HasField("config") else {},
        secrets=_struct_to_dict(req.secrets) if req.HasField("secrets") else {},
        context=ExecutionContext(
            requestId=req.request_id or None,
            tenantId=req.tenant_id or None,
            environment=req.environment or None,
            resolvedConfig=ResolvedConfig(),
        ),
    )


def _result_to_proto(result: Dict[str, Any]) -> ProtoExecuteResponse:
    """Wrap a plugin's dict result into a proto ExecuteResponse."""
    response = ProtoExecuteResponse(
        outputs=_dict_to_struct(result.get("outputs", {})),
        metadata=_dict_to_struct(result.get("metadata") or {}),
    )
    usage = result.get("usage")
    if isinstance(usage, dict):
        response.usage.CopyFrom(
            ProtoUsage(
                provider=str(usage.get("provider") or ""),
                model=str(usage.get("model") or ""),
                input_tokens=int(usage.get("inputTokens") or usage.get("input_tokens") or 0),
                output_tokens=int(usage.get("outputTokens") or usage.get("output_tokens") or 0),
                embedding_tokens=int(usage.get("embeddingTokens") or usage.get("embedding_tokens") or 0),
                estimated_cost_usd=float(usage.get("estimatedCostUsd") or usage.get("estimated_cost_usd") or 0.0),
            )
        )
    artifacts = result.get("artifacts")
    if isinstance(artifacts, list):
        for a in artifacts:
            if not isinstance(a, dict):
                continue
            data = a.get("data")
            response.artifacts.append(
                ProtoArtifact(
                    kind=str(a.get("kind") or ""),
                    uri=str(a.get("uri") or ""),
                    data=data if isinstance(data, (bytes, bytearray)) else b"",
                    sensitive=bool(a.get("sensitive") or False),
                )
            )
    return response


def build_connect_app(
    handlers: Dict[str, Callable[[ExecuteRequest], Dict[str, Any]]],
    plugin_ids: List[str],
):
    """Construct the Connect ASGI app that fronts the existing HANDLERS dict.

    The plugin_id used by the server is the literal string "ragdoll-python-plugins"
    (this is a multi-plugin sidecar, not a single-plugin host). Health
    reports the full list of registered plugin ids.
    """

    async def execute(req: ProtoExecuteRequest, ctx: RequestContext) -> ProtoExecuteResponse:
        handler = handlers.get(req.plugin)
        if handler is None:
            raise ConnectError(Code.UNIMPLEMENTED, f"unknown plugin {req.plugin}")
        pydantic_req = _proto_to_pydantic(req)
        try:
            result = handler(pydantic_req)
        except ValueError as exc:
            # Maps SSRFError (a ValueError subclass) + bad-config errors to
            # a client error rather than an internal one.
            raise ConnectError(Code.INVALID_ARGUMENT, str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            logger.exception("unhandled error in plugin %s (connect path)", req.plugin)
            raise ConnectError(Code.INTERNAL, f"internal error: {exc}") from exc
        return _result_to_proto(result)

    async def health(_req: ProtoHealthRequest, _ctx: RequestContext) -> ProtoHealthResponse:
        return ProtoHealthResponse(ok=True, plugins=plugin_ids, message="")

    return create_plugin_server(
        plugin_id="ragdoll-python-plugins",
        version="1.0.0",
        handlers={"execute": execute, "health": health},
    )
