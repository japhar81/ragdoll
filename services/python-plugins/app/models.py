"""Pydantic models matching EXTERNAL PLUGIN HTTP CONTRACT v1."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


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
