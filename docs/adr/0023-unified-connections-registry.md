# ADR 0023: Unified Connections Registry

## Status

**Accepted.** Supersedes ADR-0021 (External Connections Registry) in
favour of a single unified registry, and rewrites the binding side of
ADR-0016 (Datasets) so backends are referenced via plugin-declared
slots instead of platform-defined modalities.

Companion ADR: [0024 — Connection Drivers as Plugins](./0024-connection-drivers-as-plugins.md).

## Context

Today the platform has TWO connection registries living side-by-side:

1. **`datasource_connections`** (ADR-0020-era) — per-tenant rows
   referenced by Datasets through `backends.<modality>.connectionName`.
   Cascade resolution (env → tenant → global) is rendered in the UI
   as "inherited rows + Override here" affordances.
2. **`external_connections`** (ADR-0021) — flat list referenced by
   pipeline nodes directly via `node.connection: { slug }`.

There is no architectural reason for two registries. The split is
historical (0020 came before 0021) and overlaps on `kind = "postgres"`
(pgvector via Dataset vs `postgres_query` as a direct tool).

Compounding this, the Dataset schema carries a `modalities: string[]`
field AND `backends.<modality>.{provider, config, connectionName}`,
where the modality label was supposed to enable cross-backend
substitutability ("any vector store"). In practice that substitutability
never materialised — every storage plugin is wire-protocol-specific
(qdrant_retriever, opensearch_vector_retriever, etc.). The modality
abstraction encoded compat metadata that the plugin manifest already
captures via `requires: [{modality, provider}]`. The platform pays UI
and schema cost for a concept that the operator never actually reasons
in.

Operators reason in two terms: **"what database / cluster is this"**
(the connection) and **"what slot does this plugin need filled"** (the
binding). Modality fell between the two and confused both.

## Proposal

### 1. One `connections` table

Collapse `datasource_connections` + `external_connections` into a
single `connections` table:

```sql
CREATE TABLE connections (
  id              uuid PRIMARY KEY,
  scope           text NOT NULL CHECK (scope IN ('global','tenant','environment')),
  tenant_id       uuid REFERENCES tenants(id) ON DELETE CASCADE,
  environment_id  text,
  slug            text NOT NULL,
  display_name    text NOT NULL,
  description     text,
  kind            text NOT NULL,             -- 'qdrant' | 'opensearch' | 'neo4j' | 'postgres' | …
  config          jsonb NOT NULL DEFAULT '{}',  -- per-kind, schema lives on the driver plugin
  secret_ref_id   uuid,                       -- pointer into managed secrets
  last_probed_at  timestamptz,
  last_probe_ok   boolean,
  last_probe_error text,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connections_scope_shape CHECK (
    (scope='global'      AND tenant_id IS NULL     AND environment_id IS NULL) OR
    (scope='tenant'      AND tenant_id IS NOT NULL AND environment_id IS NULL) OR
    (scope='environment' AND tenant_id IS NOT NULL AND environment_id IS NOT NULL)
  )
);
-- Three partial unique indexes on slug per scope (same pattern as
-- datasets / external_connections today). Resolution walks
-- env -> tenant -> global, first match wins.
```

**Key changes from today**:
- No `modalities` field. Modality information lives on plugin manifests
  (see §3) and is computed at picker time.
- `kind` is open-ended text. The driver plugin (ADR-0024) declares the
  config schema. The static "known kinds" map in code goes away.
- `config` carries the kind-specific non-secret config. Whatever the
  driver plugin's manifest schema requires.

### 2. Datasets become a thin layer of bindings

The dataset's `backends.<modality>.{provider, collection, connectionName, …}`
shape is removed. Datasets become:

```yaml
apiVersion: rag-platform/v1
kind: Dataset
metadata:
  slug: kb
  scope: tenant
spec:
  bindings:
    vectors:                          # binding NAME (free, plugin-defined)
      connection: opensearch-prod     # slug, env -> tenant -> global cascade
      collection: kb_vectors_v1       # optional; defaults to {slug}_{binding}_v{n}
    keywords:
      connection: opensearch-prod     # same connection, different binding
      collection: kb_keywords_v1
    graph:
      connection: neo4j-prod
```

**Properties**:
- Multiple bindings per dataset (the OpenSearch dual-purpose case is
  natural — same connection, two binding entries with different
  collection names).
- Binding NAMES are free text chosen by the dataset author. The
  plugins that consume the dataset declare which binding NAME they
  need (§3).
- `collection` is optional; the platform defaults it to
  `${dataset-slug}_${binding-name}_v${version}` so operators don't
  hand-type collection names in the common case.
- No `modalities` field. Plugin manifests describe their requirements;
  picker UIs filter accordingly.

### 3. Plugin manifests declare required bindings

Replace `requires: [{modality, provider}]` with:

```ts
interface PluginRequirement {
  /** Free-text binding name the plugin needs from the dataset. */
  binding: string;
  /** Acceptable connection kinds for that binding. Single string is
   *  sugar for a 1-element kindOneOf. */
  kind?: string;
  kindOneOf?: string[];
}

interface PluginManifest {
  // …
  requires?: PluginRequirement[];
}
```

Examples:
```yaml
# Vector retriever — needs an opensearch connection in the dataset's "vectors" slot.
id: opensearch_vector_retriever
requires: [{ binding: vectors, kind: opensearch }]

# Hypothetical multi-kind retriever — works against qdrant OR pgvector.
id: vector_retriever
requires: [{ binding: vectors, kindOneOf: [qdrant, postgres] }]

# Tool plugins that don't go through a Dataset — no `binding`, just `kind`.
id: clickhouse_query
requires: [{ kind: clickhouse }]
```

### 4. Pipeline-level bindings

A pipeline declares its bindings up front; nodes reference them by
name. This is the canonical shape for the user-facing "3 graphs in one
pipeline" workflow.

```yaml
spec:
  bindings:
    - id: people
      dataset: people-kg
    - id: company
      dataset: company-kg
    - id: concepts
      dataset: concept-map
    - id: analytics
      connection: warehouse        # connection-direct binding, no Dataset
  nodes:
    - { id: q1, plugin: neo4j_query,      binding: people }
    - { id: q2, plugin: neo4j_query,      binding: company }
    - { id: q3, plugin: dgraph_query,     binding: concepts }
    - { id: q4, plugin: clickhouse_query, binding: analytics }
```

**Properties**:
- Multiple bindings of any cardinality. Three graphs, five connections,
  one dataset + two ad-hoc connections — all fine.
- The builder's top-level inspector renders/edits the `bindings` block.
  Nodes pick from the declared list.
- A node with the legacy inline shape (`dataset: { slug: "x" }` or
  `connection: { slug: "y" }`) desugars to an anonymous binding at
  spec-load time. Existing pipelines keep working unchanged.
- Per-(tenant, env) **binding overrides** live in
  `pipeline_dataset_bindings` (already exists, just generalised — same
  table, the `dataset_id` column becomes `target_id` with a
  `target_type` discriminator for dataset vs connection).

### 5. Picker UX

The dataset's binding picker (`+ Add binding`) shows:
- A binding-name input (free text, defaults to the plugin's requirement
  name when the dataset is being built around a known plugin).
- A connection dropdown filtered to connections visible at the
  dataset's scope.
- An optional collection-name override (placeholder shows the default).

The pipeline node's binding picker shows:
- The pipeline's declared bindings filtered to those whose underlying
  connection matches the plugin's `requires` (`kind` or `kindOneOf`).
- `+ New binding` opens a modal that pre-fills from the plugin's
  requirement and adds an entry to the pipeline's `bindings:` block.

The Connections screen does not show binding/modality information at
all. It's the ODBC-of-RAGdoll: a flat list of named DB pointers with a
test button and a status badge.

### 6. Single permission family

Both `external_connection:{read,admin,use}` and the implicit
`dataset:admin`-derived connection access collapse into
`connection:{read,admin,use}`. RBAC scoping unchanged
(global/tenant/env). The `connection:use` check fires at executor
entry whenever a node resolves a binding to a connection, regardless
of whether the binding pointed at a dataset or directly at a
connection.

### 7. Probe + status

The existing `connection_probe_sweep` worker job (ADR-0021 follow-up)
keeps running every 10 minutes against every non-archived row in the
unified table. The Connections UI surfaces:
- **Cached badge** from `last_probe_ok` (no per-minute polling).
- **"Test now" button** that runs a one-shot probe and updates the
  badge immediately.
- **WebSocket push** when the sweep records a probe result, so the
  badge changes live without a page refresh.

### 8. "Used by" back-references

The Connections grid carries a `Used by` column with two cells:
`N datasets / M pipelines`. Click for the list. Archive is gated by
the count — the dialog enumerates the references and either offers to
re-bind them OR refuses if `M > 0`. Without this, archive is a "what
just broke?" mystery.

## Migration

Single migration (`019_unified_connections.sql`) + a one-time spec
backfill script:

1. **Create `connections`** with the schema above.
2. **Copy `external_connections` rows verbatim** (column names
   already match modulo renames).
3. **Copy `datasource_connections` rows** — translate the
   `datasourceType` field to `kind`, `config` jsonb to `config` jsonb,
   `secretRefId` to `secret_ref_id`. Slugs preserved exactly so
   existing dataset specs keep resolving.
4. **Backfill the `bindings:` shape** on existing datasets:
   `backends.vector.{collection, connectionName}` →
   `bindings.vector.{connection, collection}`. Binding name defaults to
   the modality name for back-compat (so `backends.vector.collection`
   becomes `bindings.vector.collection`).
5. **Drop `datasource_connections` + `external_connections`** AFTER a
   one-version overlap (release N keeps both tables in sync via
   triggers; release N+1 drops the old tables).
6. **Permission migration**: `external_connection:*` grants rewritten
   to `connection:*`. The old strings continue to be accepted as
   aliases for one release.

## Backwards compatibility

- **Dataset specs** referencing `backends.<modality>.*` continue to load
  via a spec-load shim that translates to the new `bindings:` shape on
  the fly. No spec rewrites required.
- **Plugin specs** with the inline `node.dataset: { slug }` or
  `node.connection: { slug }` forms continue to work — desugared to
  anonymous pipeline-level bindings at spec-load time.
- **Plugin manifests** with the legacy `requires: [{modality,
  provider}]` shape are translated to the new
  `[{binding, kind}]` shape at load time (modality → binding,
  provider → kind). New plugins should use the new shape.
- **Old REST surfaces**: `/api/external-connections` and
  `/api/connections` continue to respond, both backed by the unified
  table, for one release. New work targets `/api/connections` (which
  becomes the unified surface).

## Alternatives considered

1. **Keep two registries forever.** Today's state. Operationally
   confusing; we shipped both side-by-side and immediately heard
   "what's the difference?" from the user. Rejected.

2. **Promote `dataset` to cover external connections too.** Tempting
   surface symmetry, but datasets carry semantics (embedding profile,
   chunk schema, version timeline, alias pointers) that a raw
   ClickHouse query target doesn't have. A connection is a strictly
   simpler resource; making it inherit dataset complexity is the wrong
   direction. Rejected.

3. **Keep modality on the connection schema.** Considered then
   rejected after the design conversation: modality was never doing
   compat work in practice (every storage plugin is wire-protocol-
   specific) and the operator never reasons in modality terms. Plugin
   manifests already encode the compat metadata via `requires`.

4. **Compute pipeline-level bindings from nodes (no new spec field).**
   Would avoid adding the `bindings:` block but lose declarative
   listing of what a pipeline depends on. Rejected because the user
   explicitly wants the builder's top-level inspector to be the
   editor.

## Consequences

- Operators see **one Connections screen** instead of two. The current
  scope-cascade UI is preserved; the global-scope-is-editable bug from
  yesterday's batch is moot under the unified screen.
- Dataset authoring becomes **a name + a binding list**; collection
  names default sensibly.
- Pipeline authoring gets **pipeline-level binding inspection**
  matching the user's mental model. The builder's existing top inspector
  edits the `bindings:` block; nodes pick from it.
- Plugin authors declare requirements in terms of `(binding, kind)` —
  more flexible than `(modality, provider)`, and substitutable kinds
  (`kindOneOf: [postgres, clickhouse]`) become first-class.
- One permission family, one audit surface, one probe job, one
  "Used by" graph.
- Migration is bounded: one schema migration + one spec-shim release +
  a one-version overlap before the old tables drop.

## References

- ADR 0016 — Datasets (binding shape replaced).
- ADR 0020 — External-database plugins (per-tenant connection registry).
- ADR 0021 — External Connections Registry (superseded by this ADR).
- ADR 0024 — Connection Drivers as Plugins (companion).
