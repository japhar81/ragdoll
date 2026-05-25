# RAGdoll: the 3-minute concepts read

A pitch-deck-grade map of how the pieces fit. If you've never opened
the UI before, this is the order to learn the words.

## Tenants and environments

A **tenant** is the unit of isolation — usually a customer, a team, or
an internal product line. Every row that matters is scoped to a
tenant: secrets, deployments, datasets, executions, audit. Deleting a
tenant cleans up everything it owned (cascade).

A tenant can have multiple **environments** (`dev`, `staging`, `prod`,
whatever you name them). Environments let the same pipeline run with
different config / secrets / datasets without forking the pipeline
itself.

```
Acme Corp (tenant)
├── dev      (environment)
├── staging
└── prod
```

## Pipelines and versions

A **pipeline** is a directed graph of plugin nodes — visualized in the
Builder. You build it once, version it forever. Each `Save` mints a
draft version; `Publish` makes one immutable; `Deploy` activates a
published version for a (tenant, environment) target.

```
Pipeline "support-rag" v1.0.0   (published, immutable)
                      v1.0.1   (draft, editable)
```

The platform default per-pipeline timeout is **60 minutes**, editable
in the Builder's Details menu. A platform sweep kills any run that
exceeds it.

## Datasets

A **dataset** is a named, schema'd corpus — the *what* a pipeline
reads from or writes to. Pipelines pin a **slug** (`code_indexer`,
`support_kb`); the runtime resolves the slug + a (tenant, env) into a
concrete dataset row with backend collections. Same slug can route to
different physical indexes per environment — that's how `prod` writes
to a real Qdrant while `dev` writes to in-memory.

Datasets declare **modalities** — which backend slots they carry:
`vector` (Qdrant / pgvector), `text` (OpenSearch), or both for hybrid
retrieval. The Builder picker filters slugs by what each plugin
needs, so wiring an OpenSearch sink to a vector-only dataset is
caught at edit time, not at runtime.

## Plugins

Pipelines are made of **plugins**. Each plugin declares its inputs,
outputs, config schema, secrets, and (for storage plugins) which
dataset modality it needs. Plugins can be **in-process** (TypeScript,
loaded into the worker) or **external** (HTTP, served by a sidecar —
e.g. Python crawlers).

You don't need to write plugins to use the platform. ~25 built-ins
cover the common RAG path: filesystem source → chunker → embedder →
vector store → retriever → reranker → prompt → LLM.

## Secrets

API keys and passwords live in **secrets**, not in pipeline specs.
Pipelines reference secrets by `(scope, key)` — `{scope: "tenant",
key: "llm.api_key"}` — and the runtime injects the value at execute
time. Values are encrypted at rest (AES-256-GCM), redacted on read,
and never round-trip back through the API.

## Schedules and triggers

A pipeline runs when:
- a user clicks **Run** in the Builder,
- a cron-style **schedule** fires (`/scheduler`),
- a **webhook trigger** receives a POST,
- the **CLI** or **MCP** invokes it,
- another pipeline calls `pipeline_call`.

The platform also ships two un-deletable system schedules:
`stale_exec_sweep` (every 5 min, kills timed-out runs) and
`retention_sweep` (hourly, prunes old history).

## Executions and observability

Every run becomes an **execution** row with a per-node trace.
**Usage** records per-(execution, provider, model) token counters
and costs. **Audit** records every write that mutated state.

All three screens use virtual scroll + cursor pagination — they stay
fast no matter how much history you accumulate. The footer reads
"N of M" so you always know how big the result set actually is.

## RBAC and access

Users get **grants** (`viewer`, `pipeline_admin`, `platform_admin`, …)
at any scope: global → tenant → environment → pipeline. Effective
permissions are the union of all grants. A platform admin can do
anything; a tenant admin can do anything inside one tenant; a
pipeline editor can edit a single pipeline.

API keys can be scoped the same way and can be revoked
independently. Plaintext is shown once at mint time and never again.

## Retention

The **Retention** screen sets per-resource caps (executions, usage,
audit) by row count or age in days. The hourly sweep enforces them,
so old history doesn't pile up forever.

---

### Where to go next

- **Run something**: [`docs/recipes/codebase-rag.md`](recipes/codebase-rag.md)
- **Build your own plugin**: [`docs/developer/plugin-development.md`](developer/plugin-development.md)
- **Wire SSO + roles**: [`docs/admin/access-control.md`](admin/access-control.md)
- **The full architecture**: [`docs/architecture/runtime.md`](architecture/runtime.md)
