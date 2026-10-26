"""Pydantic models matching EXTERNAL PLUGIN HTTP CONTRACT v1."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field


class PluginRef(BaseModel):
    model_config = ConfigDict(extra="ignore")

    category: Optional[str] = None
    id: str
    version: Optional[str] = None


class NodeRef(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: Optional[str] = None
    config: Dict[str, Any] = Field(default_factory=dict)
    secrets: Dict[str, Any] = Field(default_factory=dict)


class ResolvedConfigValue(BaseModel):
    model_config = ConfigDict(extra="ignore")

    value: Any = None


class ResolvedConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")

    values: Dict[str, ResolvedConfigValue] = Field(default_factory=dict)


class ExecutionContext(BaseModel):
    model_config = ConfigDict(extra="ignore")

    requestId: Optional[str] = None
    executionId: Optional[str] = None
    tenantId: Optional[str] = None
    pipelineId: Optional[str] = None
    pipelineVersionId: Optional[str] = None
    environment: Optional[str] = None
    deadline: Optional[str] = None
    resolvedConfig: ResolvedConfig = Field(default_factory=ResolvedConfig)


# --------------------------------------------------------------------------- #
# External connection envelope (ADR-0039)
# --------------------------------------------------------------------------- #
# Core now resolves a node's external connection and ships it to the sidecar
# on `ExecuteRequest.connection` (proto field 12, a google.protobuf.Struct).
# The bridge decodes that Struct with MessageToDict, so the dict keys arrive
# EXACTLY as core serialized them — the top-level envelope keys (`slug`,
# `kind`, `options`, `credential`, `refresh`) and the nested credential/refresh
# keys (`value`, `headers`, `query`, `expiresAt`, `options`, `url`, `token`)
# are all camelCase JSON. `expiresAt` is the only multi-word key; we accept the
# snake_case `expires_at` as well via an alias so a future transport that
# round-trips through proto-field-name preservation still binds cleanly.
#
# The sidecar reads `credential` directly; when `credential.expiresAt` is near,
# it POSTs `{"token": refresh.token}` to `refresh.url` and swaps in the new
# credential (see `app/connection_refresh.py` + `ExternalConnection.fresh_credential`).


class ExternalCredential(BaseModel):
    """A materialised credential for an external connection.

    Every field is optional — a connection may carry an opaque bearer
    `value`, pre-baked auth `headers`, signed `query` params, or any
    combination. `expiresAt` (ISO-8601) drives the refresh decision; its
    absence means "static credential, never expires." `options` carries any
    non-secret, credential-scoped extras core attached.
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    value: Optional[str] = None
    headers: Optional[Dict[str, str]] = None
    query: Optional[Dict[str, str]] = None
    expiresAt: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("expiresAt", "expires_at"),
    )
    options: Optional[Dict[str, Any]] = None


class RefreshGrant(BaseModel):
    """A revocable grant that lets the sidecar mint a fresh credential.

    `url` is the core endpoint to POST `{"token": token}` to; the response is
    `{"credential": {<ExternalCredential shape>}}`. The grant is revocable
    server-side and itself may carry an `expiresAt` (after which core will
    reject the token and the sidecar must surface the failure).
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    url: str
    token: str
    expiresAt: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("expiresAt", "expires_at"),
    )


class ExternalConnection(BaseModel):
    """A node's resolved external connection (ADR-0039).

    Shipped by core on `ExecuteRequest.connection`. `credential` is the inline
    materialised credential; `refresh` (when present) is the grant used to
    mint a replacement once the inline credential nears expiry.
    """

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    slug: str
    kind: str
    options: Optional[Dict[str, Any]] = None
    credential: Optional[ExternalCredential] = None
    refresh: Optional[RefreshGrant] = None

    async def fresh_credential(
        self,
        *,
        now: Optional[Any] = None,
        skew_seconds: int = 60,
        client: Optional[Any] = None,
    ) -> Optional[ExternalCredential]:
        """Return a usable credential, refreshing it first if it's near expiry.

        Returns ``self.credential`` unchanged when it has no ``expiresAt`` (a
        static credential) or its expiry is more than ``skew_seconds`` in the
        future. Otherwise — the credential is expired / within the skew window,
        or unparseable, or absent — this POSTs to the refresh grant, replaces
        ``self.credential`` with the minted one, and returns it.

        When there's no ``refresh`` grant there's nothing to refresh, so the
        inline credential (possibly ``None``) is returned as-is. ``now`` and
        ``client`` are injectable so the whole path is unit-testable without a
        clock or a real network (`now` defaults to ``datetime.now(timezone.utc)``;
        `client` to a short-lived ``httpx.AsyncClient``).
        """
        # Lazy import keeps `app.models` free of any httpx dependency at import
        # time — httpx is only pulled in on the default-client refresh path, so
        # importing this module never requires httpx to be installed.
        from app.connection_refresh import needs_refresh, refresh_credential

        if self.refresh is None:
            return self.credential
        cred = self.credential
        expires_at = cred.expiresAt if cred is not None else None
        if cred is not None and not needs_refresh(
            expires_at, now=now, skew_seconds=skew_seconds
        ):
            return cred
        fresh = await refresh_credential(self.refresh, client=client)
        self.credential = ExternalCredential.model_validate(fresh)
        return self.credential


class ExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    plugin: PluginRef
    node: NodeRef = Field(default_factory=NodeRef)
    inputs: Dict[str, Any] = Field(default_factory=dict)
    config: Dict[str, Any] = Field(default_factory=dict)
    secrets: Dict[str, Any] = Field(default_factory=dict)
    # Resolved dataset envelope (ADR-0023). When the calling pipeline
    # node has `dataset.slug` set, the runtime's DatasetResolver
    # serializes the resolved view here so handlers can reach the
    # bound connection (kind / host / port / resolved secret) without
    # a second round-trip. Empty dict when the node has no dataset.
    dataset: Dict[str, Any] = Field(default_factory=dict)
    # Resolved external connection (ADR-0039). Core materialises the node's
    # external connection — a credential + an optional revocable refresh grant
    # — and ships it on `ExecuteRequest.connection` (proto field 12). `None`
    # when the node has no external connection bound. Unlike `dataset`, this is
    # a typed model so handlers can call `request.connection.fresh_credential()`.
    connection: Optional[ExternalConnection] = None
    context: ExecutionContext = Field(default_factory=ExecutionContext)

    def effective_config(self) -> Dict[str, Any]:
        """Merge config sources by precedence.

        Lowest -> highest: node.config, context.resolvedConfig.values[*].value,
        top-level config. The top-level ``config`` wins because it is the
        request-specific override the TS client computed for this call.
        """
        merged: Dict[str, Any] = {}
        merged.update(self.node.config or {})
        for key, rcv in (self.context.resolvedConfig.values or {}).items():
            merged[key] = rcv.value
        merged.update(self.config or {})
        return merged


class Artifact(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: str
    uri: Optional[str] = None
    data: Optional[Any] = None
    sensitive: Optional[bool] = None


class ExecuteSuccess(BaseModel):
    outputs: Dict[str, Any]
    metadata: Optional[Dict[str, Any]] = None
    usage: Optional[Dict[str, Any]] = None
    artifacts: Optional[List[Artifact]] = None


class ExecuteError(BaseModel):
    error: str


class HealthResponse(BaseModel):
    ok: bool
    plugins: List[str]
