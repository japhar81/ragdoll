# Upgrade and Migrations

## Migration model

Schema migrations are plain `*.sql` files in `packages/db/migrations`, applied
by `runMigrations` (`packages/db/src/migrate.ts`):

- Files are applied in filename sort order.
- Each file runs in its own transaction; a failure leaves prior migrations
  intact.
- Applied filenames are recorded in `schema_migrations (filename,
  applied_at)`, which is created if missing.
- Already-recorded files are skipped, so `runMigrations` is idempotent and
  safe to run on every API start.

## Current ordering

> Hand-maintained list — run `ls packages/db/migrations/` for the
> authoritative ordering. The runner skips anything not matching
> `^\d+_.+\.sql$`.

1. `001_initial_schema.sql` — core schema: users/roles, tenants, environments,
   pipelines, pipeline_versions, pipeline_deployments, plugins/providers,
   config definitions/values, secret_refs/encrypted_secrets, executions,
   audit_logs, usage_records, vector_collections, and supporting indexes.
2. `002_auth.sql` — `api_keys` and `sessions` tables plus their indexes.
3. `003_org_and_scheduler.sql` — folders + activations + tenant_pipelines +
   schedules; rbac_grants for fine-grained role grants.
4. `004_tenant_environments.sql` — per-tenant environments catalog table.
5. `005_rbac_identity.sql` — `rbac_policies`, `user_identities`,
   `identity_providers`, `auth_settings`, `roles` registry.
6. `006_pipeline_metadata.sql` — pipeline-version metadata + checksum.
7. `007_tenant_git_storage.sql` — per-tenant git-backed storage config.
8. `008_ingest_state.sql` — per-pipeline ingest state for `delta_filter`.
9. `009_api_key_scoping.sql` — per-tenant / per-env API key scope columns.
10. `010_datasets.sql` — datasets, dataset_versions, dataset_aliases (ADR-0016).
11. `011_pgvector.sql` — pgvector backend collection rows.
12. `012_system_schedules_and_retention.sql` — `job_type` + `system` + `params`
    on `schedules`; new `retention_settings` table; seeds the two
    un-deletable platform schedules (stale_exec_sweep every 5min,
    retention_sweep hourly).
13. `013_tenant_delete_cascades.sql` — adds `ON DELETE CASCADE` to
    `audit_logs.tenant_id`, `usage_records.tenant_id`,
    `executions.tenant_id` (+ matching `pipeline_id` FKs) so
    `DELETE /api/tenants/:id` actually cleans up its rows.

Filenames are zero-padded so lexical sort equals intended order.

## Adding a migration

1. Create the next sequential file, e.g. `003_<change>.sql`, keeping the
   zero-padded numeric prefix.
2. Write forward-only DDL; one file is one atomic change set (it runs in a
   single transaction).
3. Do not edit a migration that has shipped — published databases already
   recorded it in `schema_migrations`. Add a new file to amend.
4. Verify locally against a Postgres started via
   `infra/docker/docker-compose.yml`, then confirm the
   `migrations_applied` log line lists the new file once.

## Zero-downtime notes

- The API applies migrations at startup before serving. For multi-replica
  rollouts, run migrations once out-of-band (call `runMigrations(pool)`
  against the target database) before rolling pods, or accept that the first
  new pod applies them while old pods keep serving.
- Use expand/contract: ship additive DDL (new nullable columns, new tables)
  in one release that both old and new code tolerate; remove or tighten in a
  later release after all replicas run the new code.
- Avoid long-locking statements in a single migration file; large backfills
  or index builds should be split out and run as controlled operational steps.
- Published pipeline versions are immutable, so schema upgrades never rewrite
  historical specs; rollback is deploying the prior image.
