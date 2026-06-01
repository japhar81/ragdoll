"""Shared concerns interceptors: auth + tenant-scope + allow-list + OTel.

Mirror of the Node `defaultInterceptors()` in
`packages/plugin-sdk/src/author.ts`. Authors get the four interceptors
for free via `create_plugin_server`; they compose with author-supplied
interceptors (author runs first, defaults run second).

All four are implemented as `MetadataInterceptor` so a single instance
applies uniformly to every RPC kind (unary + the three streaming variants).
Tenant-scope is checked via the `x-ragdoll-tenant` request header rather
than the proto body, which keeps the check cross-protocol-uniform and
the Node runtime sets the same header on every external plugin call.

Configuration is environment-variable driven so the same code path works
across docker compose, Kubernetes, and ad-hoc test runs. All interceptors
DEGRADE TO NO-OP when their controlling env is unset — the local dev stack
runs without configuration; production deployments opt in by setting the
env vars on the plugin container.

  RAGDOLL_PLUGIN_TOKEN         — shared bearer required on every RPC.
                                  Sent by the runtime as
                                  `authorization: Bearer <token>`.
  RAGDOLL_PLUGIN_REQUIRE_TENANT — when set to "1", every RPC must carry
                                  a non-empty `x-ragdoll-tenant` header.
  RAGDOLL_PLUGIN_HOST_ALLOWLIST — comma-separated list of allowed origin
                                  hostnames (matched against the
                                  `x-forwarded-host` header / the request's
                                  authority). Defense-in-depth — the
                                  runtime allow-list is the primary gate.

OpenTelemetry traceparent propagation is best-effort: if
`opentelemetry-api` is installed (the `[otel]` extra), incoming
`traceparent` is extracted and set as the active span context for the
handler; otherwise the interceptor is a no-op.
"""
from __future__ import annotations

import os
from typing import Any, List, Optional

from connectrpc.code import Code
from connectrpc.errors import ConnectError
from connectrpc.interceptor import Interceptor, MetadataInterceptor
from connectrpc.request import RequestContext


def default_interceptors() -> List[Interceptor]:
    """Compose the four shared-concerns interceptors in the standard order.

    Order matters: auth gates first (reject unauthenticated calls before
    spending any work), tenant + allow-list run against an authenticated
    principal, OTel wraps everything so spans cover the full handler.
    """
    return [
        _AuthInterceptor(),
        _TenantScopeInterceptor(),
        _HostAllowlistInterceptor(),
        _OtelInterceptor(),
    ]


def _header(ctx: RequestContext, key: str) -> Optional[str]:
    """Case-insensitive header lookup."""
    try:
        headers = ctx.request_headers()
    except Exception:
        return None
    if not headers:
        return None
    value = headers.get(key)
    return value if isinstance(value, str) else None


# ---- AuthInterceptor -------------------------------------------------------


class _AuthInterceptor(MetadataInterceptor):
    """Bearer-token auth. Compares against RAGDOLL_PLUGIN_TOKEN; no-op when unset."""

    def __init__(self) -> None:
        self._expected = os.environ.get("RAGDOLL_PLUGIN_TOKEN")

    async def on_start(self, ctx: RequestContext) -> None:
        if not self._expected:
            return None
        auth = _header(ctx, "authorization") or ""
        if not auth.startswith("Bearer "):
            raise ConnectError(Code.UNAUTHENTICATED, "missing or malformed bearer token")
        if auth[len("Bearer "):] != self._expected:
            raise ConnectError(Code.UNAUTHENTICATED, "bearer token mismatch")
        return None

    async def on_end(
        self, token: Any, ctx: RequestContext, error: Optional[Exception]
    ) -> None:
        return None


# ---- TenantScopeInterceptor ------------------------------------------------


class _TenantScopeInterceptor(MetadataInterceptor):
    """Reject calls without `x-ragdoll-tenant` when RAGDOLL_PLUGIN_REQUIRE_TENANT=1.

    The header is the cross-protocol equivalent of the runtime's tenant
    context: every external plugin call originating from the runtime sets
    it, so its absence on a real production call indicates either a
    misconfigured caller or an injection attempt.
    """

    def __init__(self) -> None:
        self._enabled = os.environ.get("RAGDOLL_PLUGIN_REQUIRE_TENANT") == "1"

    async def on_start(self, ctx: RequestContext) -> None:
        if not self._enabled:
            return None
        tenant = _header(ctx, "x-ragdoll-tenant")
        if not tenant:
            raise ConnectError(
                Code.INVALID_ARGUMENT, "x-ragdoll-tenant header is required"
            )
        return None

    async def on_end(
        self, token: Any, ctx: RequestContext, error: Optional[Exception]
    ) -> None:
        return None


# ---- HostAllowlistInterceptor ---------------------------------------------


class _HostAllowlistInterceptor(MetadataInterceptor):
    """Defense-in-depth: x-forwarded-host must be on the operator-configured allowlist.

    The runtime's allow-listed-hosts enforcement is the primary control.
    This catches misrouting or a proxy bypass that lets traffic in from
    an unexpected ingress.
    """

    def __init__(self) -> None:
        raw = os.environ.get("RAGDOLL_PLUGIN_HOST_ALLOWLIST") or ""
        self._hosts = [h.strip().lower() for h in raw.split(",") if h.strip()]

    async def on_start(self, ctx: RequestContext) -> None:
        if not self._hosts:
            return None
        host = (_header(ctx, "x-forwarded-host") or _header(ctx, "host") or "").lower()
        host = host.split(":", 1)[0]  # strip port suffix
        if host not in self._hosts:
            raise ConnectError(Code.PERMISSION_DENIED, f"host '{host}' not in allowlist")
        return None

    async def on_end(
        self, token: Any, ctx: RequestContext, error: Optional[Exception]
    ) -> None:
        return None


# ---- OtelInterceptor -------------------------------------------------------


class _OtelInterceptor(MetadataInterceptor):
    """Best-effort OpenTelemetry traceparent propagation.

    Lazy-imports `opentelemetry-api` so the SDK installs cleanly without the
    [otel] extra. When the extra is absent, both hooks are no-ops.
    Attaches the extracted context in `on_start`, detaches in `on_end`
    using the token returned from attach (the standard OTel idiom).
    """

    def __init__(self) -> None:
        try:
            from opentelemetry import context as _ctx, propagate as _prop  # noqa: F401
            self._enabled = True
        except Exception:
            self._enabled = False

    async def on_start(self, ctx: RequestContext):  # type: ignore[override]
        if not self._enabled:
            return None
        from opentelemetry import context as otel_ctx
        from opentelemetry.propagate import extract
        carrier = {}
        try:
            headers = ctx.request_headers()
            if headers:
                for k, v in headers.items():
                    if isinstance(v, str):
                        carrier[k.lower()] = v
        except Exception:
            pass
        return otel_ctx.attach(extract(carrier))

    async def on_end(
        self, token: Any, ctx: RequestContext, error: Optional[Exception]
    ) -> None:
        if not self._enabled or token is None:
            return None
        from opentelemetry import context as otel_ctx
        otel_ctx.detach(token)
        return None
