/**
 * Phase 4d of the dataset/RBAC/retrieval refactor: synthesize a Dataset
 * per (tenant, pipeline, environment) row that has a storage-touching
 * node in its current pipeline_version spec AND pin
 * `node.dataset = { slug, alias: "stable" }` onto every storage-touching
 * node in the spec itself.
 *
 * Why this script exists: before Datasets, every pipeline directly named
 * a Qdrant collection / OpenSearch index in its spec. That coupled
 * ingestion and retrieval one-to-one. To start consolidating, we mint a
 * Dataset for every existing pipeline-env binding that ALREADY writes
 * somewhere, recording the existing physical collection in the
 * Dataset's v1.backend_collections. NO DATA MOVES; the script only adds
 * metadata.
 *
 * After Phase 4d, contract-v2 storage nodes also need an explicit
 * `node.dataset` pin so the validator's `missing_required_dataset` check
 * doesn't block Run/Deploy on pre-existing pipelines. The script writes
 * the pin in-place on the spec JSON of the latest version per pipeline
 * (one updated row per pipeline_id; older versions are left alone since
 * they're immutable history). The slug used for the pin matches the
 * pipeline slug so the global dataset created here is the one that
 * resolves at run time.
 *
 * Idempotent: re-running skips datasets whose (scope, tenant_id,
 * environment_id, slug) already exists, skips versions whose
 * (dataset_id, version_label) already exists, and re-pins specs only
 * when a storage node is currently missing `node.dataset`.
 *
 * Run with:
 *   DATABASE_URL=postgres://ragdoll:ragdoll@localhost:5432/ragdoll \
 *     node --experimental-strip-types scripts/migrate-pipelines-to-datasets.ts
 *
 * Optional flags via env:
 *   DRY_RUN=1       — print proposed inserts, do not execute
 *   SKIP_SLUGS=...  — comma-separated pipeline slugs to leave untouched
 */
import { Pool } from "pg";
import { randomUUID } from "node:crypto";

interface PipelineRow {
  id: string;
  slug: string;
  name: string;
  latestVersionId: string | null;
}

interface VersionRow {
  id: string;
  pipelineId: string;
  status: string;
  spec: Record<string, unknown>;
}

interface TenantPipelineRow {
  tenantId: string;
  pipelineId: string;
  environment: string;
}

interface NodeRef {
  id: string;
  plugin?: { category?: string; id?: string };
  config?: Record<string, unknown>;
}

/** Storage-touching plugin ids that name a collection / index in their
 *  config. Mirrors what's in plugins/builtin-rag for the v1 contract. */
const VECTOR_PLUGINS = new Set([
  "vector_upsert",
  "qdrant_vector_store",
  "qdrant_retriever",
  "qdrant_delete"
]);
const KEYWORD_PLUGINS = new Set([
  "opensearch_output",
  "opensearch_input",
  "opensearch_bm25_retriever",
  "opensearch_vector_retriever",
  "opensearch_hybrid_retriever",
  "opensearch_delete"
]);

interface ExtractedStorage {
  vectorCollection?: string;
  keywordIndex?: string;
  embeddingProfile: Record<string, unknown>;
}

function extractStorage(spec: Record<string, unknown>): ExtractedStorage | undefined {
  const nodes = ((spec.spec as { nodes?: NodeRef[] } | undefined)?.nodes ?? []) as NodeRef[];
  let vectorCollection: string | undefined;
  let keywordIndex: string | undefined;
  let embeddingModel: string | undefined;
  let embeddingProvider: string | undefined;
  for (const node of nodes) {
    const pid = node.plugin?.id;
    if (!pid) continue;
    const cfg = (node.config ?? {}) as Record<string, unknown>;
    if (VECTOR_PLUGINS.has(pid)) {
      const c = typeof cfg.collection === "string" ? cfg.collection : undefined;
      if (c && !c.startsWith("${")) vectorCollection = c;
    }
    if (KEYWORD_PLUGINS.has(pid)) {
      const idx = typeof cfg.index === "string" ? cfg.index : undefined;
      if (idx && !idx.startsWith("${")) keywordIndex = idx;
    }
    if (pid === "provider_embeddings") {
      if (typeof cfg.model === "string") embeddingModel = cfg.model;
      if (typeof cfg.provider === "string") embeddingProvider = cfg.provider;
    }
  }
  if (!vectorCollection && !keywordIndex) return undefined;
  return {
    vectorCollection,
    keywordIndex,
    embeddingProfile: {
      provider: embeddingProvider ?? "ollama",
      model: embeddingModel ?? "nomic-embed-text",
      // Dimensions / distance default; this is metadata for display, not
      // a runtime constraint at migration time.
      dimensions: 768,
      distance: "cosine"
    }
  };
}

function csv(env: string | undefined): Set<string> {
  return new Set(
    (env ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/** Plugin ids whose `manifest.contract` is 2 (dataset-aware contract).
 *  Mirrors the explicit datasetModalities tags in plugins/builtin-rag —
 *  if a node uses one of these AND has no `node.dataset.slug`, the
 *  validator now refuses to Run/Publish/Deploy. The migration pins each
 *  matched node to a slug = the pipeline slug so the resulting global
 *  Dataset auto-resolves on a fresh stack. */
const V2_STORAGE_PLUGINS = new Set([
  "qdrant_retriever",
  "qdrant_vector_store",
  "qdrant_delete",
  "vector_upsert",
  "opensearch_output",
  "opensearch_bm25_retriever",
  "opensearch_vector_retriever",
  "opensearch_hybrid_retriever",
  "opensearch_delete"
]);

interface SpecNodeWithDataset extends NodeRef {
  dataset?: { slug?: string; alias?: string };
}

/** Returns a new spec object with `node.dataset = { slug, alias: "stable" }`
 *  written onto every storage-touching v2 node that doesn't already have
 *  one. Returns `undefined` when no change is needed (idempotent re-run). */
function pinDatasetOnSpec(
  spec: Record<string, unknown>,
  slug: string
): Record<string, unknown> | undefined {
  const inner = spec.spec as { nodes?: SpecNodeWithDataset[] } | undefined;
  if (!inner?.nodes) return undefined;
  let mutated = false;
  const nextNodes: SpecNodeWithDataset[] = inner.nodes.map((node) => {
    const pid = node.plugin?.id;
    if (!pid || !V2_STORAGE_PLUGINS.has(pid)) return node;
    if (node.dataset?.slug) return node;
    mutated = true;
    return { ...node, dataset: { slug, alias: "stable" } };
  });
  if (!mutated) return undefined;
  return { ...spec, spec: { ...inner, nodes: nextNodes } };
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://ragdoll:ragdoll@localhost:5432/ragdoll";
  const dryRun = process.env.DRY_RUN === "1";
  const skipSlugs = csv(process.env.SKIP_SLUGS);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const pipelines = (
      await pool.query<PipelineRow>(
        `SELECT id, slug, name, latest_version_id AS "latestVersionId" FROM pipelines`
      )
    ).rows;
    const bySlug = new Map<string, string>(
      pipelines.map((p: PipelineRow) => [p.id, p.slug])
    );
    const byName = new Map<string, string>(
      pipelines.map((p: PipelineRow) => [p.id, p.name])
    );
    const byLatest = new Map<string, string>();
    for (const p of pipelines) {
      if (p.latestVersionId) byLatest.set(p.id, p.latestVersionId);
    }
    if (pipelines.length === 0) {
      console.log("no pipelines — nothing to migrate");
      return;
    }
    const tenantPipelines = (
      await pool.query<TenantPipelineRow>(
        `SELECT tenant_id AS "tenantId",
                pipeline_id AS "pipelineId",
                environment
         FROM tenant_pipelines
         ORDER BY tenant_id, pipeline_id, environment`
      )
    ).rows;

    let created = 0;
    let skipped = 0;
    let unchanged = 0;

    for (const tp of tenantPipelines) {
      const slug = bySlug.get(tp.pipelineId);
      if (!slug) continue;
      if (skipSlugs.has(slug)) {
        console.log(`  ${slug} @ ${tp.environment}: skip (per SKIP_SLUGS)`);
        skipped += 1;
        continue;
      }
      // Fetch the latest published version's spec — or the latest of any
      // status if no published one exists.
      const latestId = byLatest.get(tp.pipelineId);
      let versionRow: VersionRow | undefined;
      if (latestId) {
        versionRow = (
          await pool.query<VersionRow>(
            `SELECT id, pipeline_id AS "pipelineId", status, spec
             FROM pipeline_versions WHERE id = $1`,
            [latestId]
          )
        ).rows[0];
      }
      if (!versionRow) {
        versionRow = (
          await pool.query<VersionRow>(
            `SELECT id, pipeline_id AS "pipelineId", status, spec
             FROM pipeline_versions
             WHERE pipeline_id = $1
             ORDER BY status = 'published' DESC, created_at DESC
             LIMIT 1`,
            [tp.pipelineId]
          )
        ).rows[0];
      }
      if (!versionRow) {
        console.log(`  ${slug} @ ${tp.environment}: skip (no versions)`);
        skipped += 1;
        continue;
      }
      const storage = extractStorage(versionRow.spec);
      if (!storage) {
        console.log(`  ${slug} @ ${tp.environment}: skip (no storage nodes)`);
        skipped += 1;
        continue;
      }
      // Idempotency: skip if a dataset at (env, tenant, slug) already exists.
      const existing = (
        await pool.query<{ id: string }>(
          `SELECT id FROM datasets
           WHERE scope = 'environment'
             AND tenant_id = $1 AND environment_id = $2 AND slug = $3`,
          [tp.tenantId, tp.environment, slug]
        )
      ).rows[0];
      if (existing) {
        console.log(
          `  ${slug} @ ${tp.environment}: exists (${existing.id}) — skip`
        );
        unchanged += 1;
        continue;
      }

      const datasetId = randomUUID();
      const versionId = randomUUID();
      const aliasId = randomUUID();
      const now = new Date().toISOString();
      const modalities: string[] = [];
      if (storage.vectorCollection) modalities.push("vector");
      if (storage.keywordIndex) modalities.push("keyword");
      const backendCollections: Record<string, string> = {};
      if (storage.vectorCollection) {
        backendCollections.vector = storage.vectorCollection;
      }
      if (storage.keywordIndex) {
        backendCollections.keyword = storage.keywordIndex;
      }

      const sqlPlan = [
        `INSERT datasets ${slug} env=${tp.environment} tenant=${tp.tenantId.slice(0, 8)}…`,
        `  modalities=${JSON.stringify(modalities)}`,
        `  backendCollections=${JSON.stringify(backendCollections)}`,
        `  v1 alias=stable`
      ].join("\n");
      console.log(`  ${slug} @ ${tp.environment}: create\n${sqlPlan}`);
      if (dryRun) {
        created += 1;
        continue;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO datasets
             (id, scope, tenant_id, environment_id, slug, display_name,
              description, embedding_profile, chunk_schema, modalities,
              backends, created_at, updated_at)
           VALUES ($1, 'environment', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
          [
            datasetId,
            tp.tenantId,
            tp.environment,
            slug,
            byName.get(tp.pipelineId) ?? slug,
            `Migrated from pipeline ${slug}`,
            JSON.stringify(storage.embeddingProfile),
            JSON.stringify({}),
            modalities,
            JSON.stringify({
              ...(storage.vectorCollection
                ? { vector: { provider: "qdrant" } }
                : {}),
              ...(storage.keywordIndex
                ? { keyword: { provider: "opensearch" } }
                : {})
            }),
            now
          ]
        );
        await client.query(
          `INSERT INTO dataset_versions
             (id, dataset_id, version_label, schema_spec, backend_collections,
              status, doc_count, size_bytes, created_at, ready_at)
           VALUES ($1, $2, 'v1', $3, $4, 'ready', 0, 0, $5, $5)`,
          [versionId, datasetId, JSON.stringify({}), JSON.stringify(backendCollections), now]
        );
        await client.query(
          `UPDATE datasets SET current_version_id = $1 WHERE id = $2`,
          [versionId, datasetId]
        );
        await client.query(
          `INSERT INTO dataset_aliases
             (id, dataset_id, alias, version_id, updated_at)
           VALUES ($1, $2, 'stable', $3, $4)`,
          [aliasId, datasetId, versionId, now]
        );
        await client.query("COMMIT");
        created += 1;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

    console.log(
      `\ndatasets: ${created} created, ${unchanged} already existed, ${skipped} skipped` +
        (dryRun ? " (DRY_RUN: nothing was written)" : "")
    );

    // ---- second pass: pin node.dataset on every pipeline's latest spec ----
    // Walk each pipeline once (slug is the dataset slug — same as the
    // pipeline's slug). For each pipeline_versions row we'd otherwise
    // leave alone, check whether any storage v2 node lacks a dataset
    // pin; if so, write back the patched spec.
    let pinned = 0;
    let pinSkipped = 0;
    for (const p of pipelines) {
      if (skipSlugs.has(p.slug)) {
        pinSkipped += 1;
        continue;
      }
      // We rewrite ALL versions of the pipeline that contain a storage
      // node missing a slug pin — not just the latest — because the
      // worker may run an older version via `resolveRunVersion` (pinned
      // activation, explicit pipelineVersionId), and the validator
      // rejects any of them.
      const versions = (
        await pool.query<VersionRow>(
          `SELECT id, pipeline_id AS "pipelineId", status, spec
           FROM pipeline_versions WHERE pipeline_id = $1`,
          [p.id]
        )
      ).rows;
      for (const v of versions) {
        const patched = pinDatasetOnSpec(v.spec, p.slug);
        if (!patched) {
          pinSkipped += 1;
          continue;
        }
        console.log(`  ${p.slug} v=${v.id.slice(0, 8)}…: pin dataset slug "${p.slug}"`);
        if (dryRun) {
          pinned += 1;
          continue;
        }
        await pool.query(
          `UPDATE pipeline_versions SET spec = $1 WHERE id = $2`,
          [JSON.stringify(patched), v.id]
        );
        pinned += 1;
      }
    }

    console.log(
      `\nspecs:    ${pinned} pinned, ${pinSkipped} already pinned / skipped` +
        (dryRun ? " (DRY_RUN: nothing was written)" : "")
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
