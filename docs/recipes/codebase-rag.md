# Recipe: ingest a codebase into RAGdoll

This recipe wires the five new ingest plugins into two sibling pipelines —
one for **code** (symbol-aware chunks → Qdrant), one for **docs**
(paragraph chunks → OpenSearch). First run is a cold start that embeds
everything; subsequent runs only touch new / modified / deleted files.

## The pieces

- **`filesystem_source`** ([docs](../plugins/filesystem_source.md)) —
  walks a directory tree on the worker filesystem.
- **`path_classifier`** ([docs](../plugins/path_classifier.md)) — optional;
  use it inside one pipeline if you want a single fs walk feeding two
  branches.
- **`delta_filter`** ([docs](../plugins/delta_filter.md)) — three output
  ports (`new`, `modified`, `deleted`) driven by per-doc state persisted
  in the `ingest_state` table.
- **`code_chunker`** ([docs](../plugins/code_chunker.md)) — splits code at
  top-level construct boundaries per detected language.
- **`basic_text_chunker`** — narrative-friendly chunker for markdown.
- **`qdrant_delete`** ([docs](../plugins/qdrant_delete.md)) /
  **`opensearch_delete`** ([docs](../plugins/opensearch_delete.md)) —
  remove rows when source files disappear.

## Why two pipelines, not one

Two sibling pipelines keep concerns clean: each has its own chunker, its
own sink, its own state bucket (`stateKey: code` vs `stateKey: docs`),
and an independent schedule. You can re-run one without disturbing the
other. If you'd rather have a single mega-pipeline, `path_classifier`
makes that wiring viable; the sample YAMLs go the two-pipeline route
because it's the easier mental model.

## Sample YAMLs

- [`codebase-ingest-code.yaml`](../../examples/pipelines/codebase-ingest-code.yaml)
- [`codebase-ingest-docs.yaml`](../../examples/pipelines/codebase-ingest-docs.yaml)

Both are seeded into the database for `tenant-local` / `dev` (see
`packages/db/seeds/zzzz-codebase-ingest.sql`) so they show up in the
Pipelines view out of the box. **Two requirements before they run
cleanly** — neither is wired automatically:

### 1. Mount your codebase at `/workspace`

Both pipelines walk `rootPath: /workspace`. The worker container doesn't
mount your repo there by default. Add a volume under the `worker` service
in `infra/docker/docker-compose.yml` (read-only is fine):

```yaml
services:
  worker:
    volumes:
      - /Users/you/path/to/your-codebase:/workspace:ro
```

Without this the pipeline fails at the `fs` node with an empty document
list (or ENOENT, depending on the host path).

### 2. Switching to a paid provider (optional)

The seeded specs and the YAMLs ship **without** `secrets:` blocks so the
demo runs cleanly against the in-stack Ollama embedder + dev
Qdrant/OpenSearch (no auth). If you swap in a paid embedder or a
production Qdrant/OpenSearch that needs credentials, re-add the secret
refs on the relevant nodes from the Builder:

| Secret key            | Goes on…                                     |
|-----------------------|----------------------------------------------|
| `embedding.api_key`   | `provider_embeddings`                        |
| `qdrant.api_key`      | `qdrant_vector_store` + `qdrant_delete`      |
| `opensearch.username` | `opensearch_output` + `opensearch_delete`    |
| `opensearch.password` | `opensearch_output` + `opensearch_delete`    |

Then create the corresponding secrets at tenant scope via `PUT
/api/secrets` (or the Secrets screen).

## Steady-state runs

After the first cold start:

1. Author edits a few files. Each save bumps the file's mtime.
2. The scheduled pipeline fires. `filesystem_source` re-walks the tree,
   `delta_filter` compares mtimes against state — most files match and
   land on `unchanged` (unwired). Edited files land on `modified`.
3. Only the modified subset flows down chunk → embed → upsert. Cost is
   linear in **changed** files, not the corpus size.
4. Files that have been deleted on disk land on `deleted`; the delete
   sink removes their vectors. State is updated to reflect the new set.

## Picking `compareBy`

| Mode          | Use when                                                   |
|---------------|-----------------------------------------------------------|
| `mtime`       | Default. Cheap. Good unless you branch-swap often.        |
| `hash`        | You need precise diff and don't mind hashing every file.   |
| `mtime+hash`  | You branch-swap or use mtime-preserving sync (rsync `-t`). |

See [`delta_filter` docs](../plugins/delta_filter.md) for the trade-off
table.

## Scheduling

Both pipelines are good candidates for the cron scheduler:

```yaml
schedule:
  cron: "*/15 * * * *"   # every 15 minutes
  tenantId: <uuid>
  pipelineId: codebase-ingest-code
```

15 minutes is a reasonable starting cadence — fast enough that retrieval
is fresh, slow enough that you're not embedding a partially-saved file.
Drop it to 5 minutes if you have a tight inner loop, raise it to hourly
if your corpus is huge.

## What's NOT in the sample

- **No tenant isolation on the index name**. The samples use a fixed
  `codebase` collection / `codebase-docs` index — fine for single-tenant
  dev. For multi-tenant, parameterise the names from
  `${config.vector.collection}` etc.
- **No filter on binaries**. The default exclude list strips heavy
  directories, but `filesystem_source` will still try to read e.g. a
  `.bin` file. `maxFileSize` is your second-line defence; tune it.
- **No incremental concurrency**. The pipeline executes node-by-node,
  one document set at a time. For very large first-pass runs, that's
  embed-bound (provider rate limits). Future: `foreach` could grow a
  `concurrency` knob.
