# ADR 0003: Pipeline Specs Store Secret References Only

## Status

Accepted

## Decision

Pipeline specs and exported artifacts may include logical secret references, never plaintext secrets. Runtime resolves references through a `SecretProvider`.

## Consequences

- Pipeline specs can be safely stored in Git.
- Secrets can rotate without changing pipeline versions.
- Secret providers can evolve from encrypted Postgres to Vault, Kubernetes Secrets, or cloud secret managers.
