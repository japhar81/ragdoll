/**
 * One-off migration: walk every `pipeline_versions` row in the running
 * database, run the shared `autoLayoutSpec`, and write back the laid-out
 * spec + recomputed checksum when (and only when) positions changed.
 * Rows whose spec already carries positions on every node are skipped.
 *
 * Bypasses the API's published-version immutability check on purpose —
 * this is a layout-only migration; the runtime semantics of every spec
 * are unchanged (only `ui.position` fields are added). Run with:
 *
 *   DATABASE_URL=postgres://ragdoll:ragdoll@localhost:5432/ragdoll \
 *     node --experimental-strip-types scripts/relayout-existing-pipelines.ts
 *
 * Optional `SKIP_SLUGS=code_indexer,foo` (or `SKIP_IDS=...`) leaves
 * those pipelines untouched.
 */
import { Pool } from "pg";
import {
  autoLayoutSpec,
  specChecksum
} from "../packages/pipeline-spec/src/index.ts";

interface VersionRow {
  id: string;
  pipeline_id: string;
  version: string;
  status: string;
  spec: unknown;
  checksum: string;
}

interface PipelineRow {
  id: string;
  slug: string;
  name: string;
}

function csv(env: string | undefined): Set<string> {
  return new Set(
    (env ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

async function main(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://ragdoll:ragdoll@localhost:5432/ragdoll";
  const skipSlugs = csv(process.env.SKIP_SLUGS);
  const skipIds = csv(process.env.SKIP_IDS);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const pipelines = await pool.query<PipelineRow>(
      "SELECT id, slug, name FROM pipelines"
    );
    const bySlug = new Map(pipelines.rows.map((p) => [p.id, p.slug]));
    const byName = new Map(pipelines.rows.map((p) => [p.id, p.name]));

    const versions = await pool.query<VersionRow>(
      "SELECT id, pipeline_id, version, status, spec, checksum FROM pipeline_versions ORDER BY pipeline_id, version"
    );
    // eslint-disable-next-line no-console
    console.log(
      `${versions.rows.length} pipeline_versions across ${pipelines.rows.length} pipelines`
    );

    let touched = 0;
    let skipped = 0;
    let unchanged = 0;
    for (const row of versions.rows) {
      const slug = bySlug.get(row.pipeline_id) ?? row.pipeline_id;
      const name = byName.get(row.pipeline_id) ?? slug;
      const tag = `${slug} v${row.version} (${row.status})`;
      if (skipSlugs.has(slug) || skipIds.has(row.pipeline_id)) {
        // eslint-disable-next-line no-console
        console.log(`  ${tag}: skip (per SKIP_SLUGS/SKIP_IDS)`);
        skipped += 1;
        continue;
      }
      // The DB carries `spec` as jsonb so pg returns it as a parsed
      // object already. Validate shape defensively.
      if (
        !row.spec ||
        typeof row.spec !== "object" ||
        (row.spec as Record<string, unknown>).kind !== "Pipeline"
      ) {
        // eslint-disable-next-line no-console
        console.log(`  ${tag}: skip (spec is not a Pipeline)`);
        skipped += 1;
        continue;
      }
      const before = row.spec as Parameters<typeof autoLayoutSpec>[0];
      const after = autoLayoutSpec(before);
      if (after === before) {
        unchanged += 1;
        continue;
      }
      const newChecksum = specChecksum(after).slice(0, row.checksum.length || 8);
      await pool.query(
        "UPDATE pipeline_versions SET spec = $1, checksum = $2 WHERE id = $3",
        [after, newChecksum, row.id]
      );
      // eslint-disable-next-line no-console
      console.log(
        `  ${tag}: ${row.checksum} -> ${newChecksum} (${name})`
      );
      touched += 1;
    }
    // eslint-disable-next-line no-console
    console.log(`\ndone — ${touched} updated, ${unchanged} already laid out, ${skipped} skipped`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
