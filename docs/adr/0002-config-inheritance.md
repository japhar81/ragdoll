# ADR 0002: Explainable Hierarchical Configuration

## Status

Accepted

## Decision

Configuration resolves from global defaults through environment, pipeline, pipeline version, tenant, tenant-pipeline, and runtime scopes. Every value carries an explanation containing its source, lock state, default state, and redaction state.

## Consequences

- Runtime behavior is auditable and explainable.
- Tenant/runtime overrides can be rejected before execution.
- Locked safety or isolation settings cannot be bypassed by lower-trust scopes.
