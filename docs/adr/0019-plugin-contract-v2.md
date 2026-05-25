# ADR 0019: Plugin Contract v2 (Dataset-Aware Plugins)

## Status

Accepted.

## Context

ADR 0001 / 0008 fixed the plugin contract early: a `PluginExecutionInput`
carries `context`, `node`, `inputs`, `config`, `secrets`, and the
plugin returns `{ outputs, metadata?, usage?, artifacts? }`. Every
storage-touching plugin read `config.collection` / `config.index`
directly. That worked but coupled pipelines to raw collection names
(see ADR 0016 for why we needed to fix that).

We need a way for plugins to talk to "the Dataset wired to this node"
without breaking every existing pipeline that names a collection
explicitly.

## Decision

Add a `contract` field to `PluginManifest`:

  contract?: 1 | 2

`undefined` reads as `1` — every legacy plugin keeps its old behavior.

`contract: 2` opts the plugin into Phase 4's Dataset model:

  - `node.dataset = { slug, alias? }` may be set in the spec.
  - The runtime resolves the reference at execute time via the
    Phase 5 `DatasetResolver` (env → tenant → global walk, alias
    defaulting to "stable", falling back to `currentVersionId`).
  - The resolved `ResolvedDataset` arrives on `input.dataset`. v2
    plugins read `input.dataset.backendCollections.<modality>` for
    the physical name and may inspect `dataset.backends.vector.provider`
    to pick a backend implementation.

v1 plugins receive nothing new. Their config + the dataset shim's
splice into `config.collection` / `config.index` makes them work
identically against legacy pipelines AND dataset-bound pipelines.
Specifically:

  applyDatasetShim(contract: 1, config, resolved):
    config.collection ??= resolved.backendCollections.vector
    config.index      ??= resolved.backendCollections.keyword

The shim NEVER overrides an explicit value already in config — that
keeps the legacy pipelines pinning collections explicitly safe
during the migration window.

Phase 7 walks every storage-touching built-in plugin and migrates it
to contract: 2:

  vector_upsert, qdrant_vector_store, qdrant_retriever, qdrant_delete,
  opensearch_input, opensearch_output, opensearch_bm25_retriever,
  opensearch_vector_retriever, opensearch_hybrid_retriever,
  opensearch_delete

All ten use the shared `pickBackendName(input, modality)` helper that
prefers `input.dataset.backendCollections.<modality>` and falls back
to the legacy `config.collection` / `config.index` so a node WITHOUT
a dataset wired keeps working unchanged.

Phase 9 ships the v2-native primitives (`dataset_search`,
`dataset_upsert`) which REQUIRE `node.dataset` and have no legacy
fallback — they're the recommended path for new pipelines.

## Consequences

- The migration window is zero-risk for existing pipelines. They run
  identically until an operator opts in by setting `node.dataset`.
- New plugin authors target contract: 2 from the start. The example
  in `docs/developer/plugin-development.md` will move to v2 in the
  next docs pass.
- The shim adds one runtime branch per node. Measured cost is in the
  noise (a Map lookup + two field reads).
- v1 plugins that don't touch storage (the bulk of `transformer` /
  `control` / `llm` / `prompt_template` plugins) need no change ever.
- `pipeline_call` (Phase 9) requires `contract: 2` because it depends
  on `input.runPipelineByRef` — added in the v2 input shape.

## Alternatives considered

1. **Rewrite every plugin at once.** Risky — touches ~25 plugins, each
   with its own pytest / Vitest suite, and there's no way to roll
   back per-plugin if one regresses. Opt-in via the manifest field
   makes the migration incremental.
2. **Reference the dataset in `config` (`config.datasetSlug` etc.)
   instead of a separate `node.dataset`.** Tempting because it
   doesn't widen the spec schema, but datasets are structural and
   carry their own RBAC; surfacing them at the same level as `plugin`
   / `config` makes that visible at parse time and lets validators
   special-case them (e.g. "this node has no config.collection AND
   no node.dataset → warn").
3. **Inject the dataset via the resolved-config layer
   (`${dataset.kb.collection}` templates).** Would require the resolver
   to understand dataset semantics, which it doesn't today. The
   manifest-versioned approach scopes the change to the plugin
   surface and the runtime executor — clean seam.
