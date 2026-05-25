# 17 — Branch Ready Report

`refactor/datasets-rbac-retrieval` is feature-complete for phases 0
through 13. This is what's on the branch; what to look at first; and
what's left to do later.

## Summary of changes

| Area | Before | After |
| --- | --- | --- |
| RBAC enforcement | 92 REST `enforce()` sites; 0 in worker/runtime/scheduler | 92 + per-event WS filter + worker re-check + scheduler re-check + executor entry check |
| API keys | tenant scope + roles[] snapshot, no env, no expiry | tenant + env scope, expiration, full mint UI |
| Datasets | n/a; pipelines named raw collections | first-class resource with versions, aliases, scoped RBAC; UI; CRUD; migration script |
| Plugin contract | every plugin reads `config.collection` | v1 + v2 with compat shim; all 10 storage plugins migrated to v2 |
| Vector backends | Qdrant or InMemory | Qdrant, InMemory, **pgvector** behind the same VectorStore interface |
| Execution model | batch-only via BullMQ | batch + **synchronous** (`/invoke`, `/stream`) + MCP auto-exposure |
| Retrieval plugins | retrievers + reranker only | + dataset_search/upsert, query_hyde, query_fanout, merge_rrf, rerank_llm, rerank_bge, pipeline_call, conversation_rewrite, topic_shift_detect |
| Dev-auth header trust | opt-in via `RAGDOLL_DEV_AUTH=1` | removed; use the bootstrap admin + API keys |
| Streaming | `/stream` returned `not_enabled` | real chunked SSE delivery via async-iterable bodies |
| Ollama cold-start | 30-60s on first call | warm-model heartbeat keeps designated models resident |

## Commit count + size

20 commits on top of `main@ca776cf`. ~3.5k LoC net add (counts mostly
in tests + new plugin code; runtime changes are surgical).

## Tests

618 / 618 green across all suites:

  unit:       242
  plugins:     65
  functional: 103
  e2e:          8
  security:    31
  cli:          9
  web:        160

## Recommended review order

1. `docs/refactor/00-context-summary.md` — the starting state.
2. `docs/refactor/01-rbac-audit.md` — what the RBAC story looked like
   before, and which gaps Phase 2 closed.
3. ADRs 0016 → 0019 — the four architectural decisions:
   - 0016 Datasets
   - 0017 API keys scoped per tenant + env
   - 0018 Synchronous pipelines + MCP auto-exposure
   - 0019 Plugin contract v2
4. Migration scripts:
   - `scripts/migrate-pipelines-to-datasets.ts` — what existing
     pipelines turned into.
   - `packages/db/migrations/{009,010,011}_*.sql` — the schema
     additions for api-key scoping, Datasets, and pgvector.
5. Runtime + executor:
   - `packages/runtime/src/index.ts` — `applyDatasetShim`, the
     `datasetResolver` hook, and the executor entry check.
   - `apps/api/src/app.ts` — `runSyncPipeline`, `/invoke`, `/stream`.
6. Web:
   - `apps/web/src/components/DatasetsScreen.tsx` — Datasets list +
     detail + inverse-pipeline section.
   - `apps/web/src/components/PipelineBuilder.tsx` — Inspector
     pipeline-kind + Invoke panel + Dataset picker.
   - `apps/web/src/components/PalettePanel.tsx` — kind-aware filter.

## Migration steps for existing deployments

1. `make refresh` (rebuilds api/web/worker images).
2. `docker compose run --rm db-init` (applies migrations 009 / 010 /
   011 — idempotent; safe to run on a populated DB).
3. `node --experimental-strip-types scripts/migrate-pipelines-to-datasets.ts`
   to synthesize a Dataset per existing tenant_pipeline row with a
   storage node. No data moves. Idempotent.
4. `make refresh` again so the API picks up the new dataset rows
   (the Postgres repos are wired but the in-process state needs the
   restart).
5. Optionally: set `OLLAMA_WARM_MODELS=qwen2.5:0.5b,nomic-embed-text`
   (defaults are sensible) and `RAGDOLL_VECTOR_BACKEND=pgvector` if
   you want to run Postgres-only.

## Rollback procedure

This branch is non-destructive — every change is additive:

- All schema migrations have IF NOT EXISTS guards.
- Dataset-aware plugins fall back to legacy `config.collection`.
- `node.dataset` is optional everywhere it appears.
- The dev-auth removal is the ONE breaking change: a deploy that
  depended on `RAGDOLL_DEV_AUTH=1` must mint an API key before
  cutting over. The bootstrap admin (`admin@ragdoll.local`) is
  provisioned on first boot, so this is a one-time setup not a
  rollback hazard.

To roll back: drop the dataset / api_key column additions (annotated
in each migration) and redeploy `main@ca776cf`. The data layer stays
consistent because the new columns are nullable and ignored by the
old code paths.

## Known follow-ups (Phase 14+)

- **Token-by-token provider streaming** through `/stream`. Phase 13
  ships per-frame chunked delivery; token streaming needs a
  provider-layer AsyncIterable threaded into the executor.
- **API key permission intersection** at request time — today's
  snapshot-at-mint behaviour is still in place.
- **Local cross-encoder model loading** for `rerank_bge`. Currently
  hits the HF Inference API.
- **Sample pipelines** in `examples/pipelines/` haven't been migrated
  to `node.dataset` + `executionKind: synchronous`. They work
  through the shim but don't demonstrate the new shape.
- **Dataset detail deep-link** from pipeline pills — needs stable
  `/datasets/:id` routes (currently the detail is rendered alongside
  the list via in-screen state).
- **Strict schema validation** on dataset writes. Today the
  `chunk_schema` is metadata; tightening to "reject writes that
  don't conform" needs a validator pass on every upsert.

## Verification commands

```bash
# Branch state
git log main..HEAD --oneline
npm run test:all
make refresh
docker compose -f infra/docker/docker-compose.yml exec -T postgres \
  psql -U ragdoll -d ragdoll -c "SELECT count(*) FROM datasets;"
docker compose -f infra/docker/docker-compose.yml exec -T postgres \
  psql -U ragdoll -d ragdoll -c "SELECT extname FROM pg_extension WHERE extname='vector';"
```

Branch is not pushed. When ready:

```
git push -u origin refactor/datasets-rbac-retrieval
```
