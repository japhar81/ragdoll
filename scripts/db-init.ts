/**
 * One-shot database initializer for the local Docker stack.
 *
 * Runs every pending migration, then applies every `packages/db/seeds/*.sql`
 * file in sorted (alphabetical) order. Idempotent: migrations are tracked in
 * `schema_migrations`, and every seed uses `ON CONFLICT DO NOTHING`, so this
 * is safe to re-run on `docker compose up --build`.
 *
 * Replaces the old `/docker-entrypoint-initdb.d/{migrations,seeds}` bind
 * mounts (Postgres does not recurse subdirectories, so those never applied).
 *
 * This runs inside the api image (deps installed), so a normal `pg` path via
 * `createPool` is fine. JSON logs to stdout.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import {
  createPool,
  runMigrations,
  defaultMigrationsDir
} from "../packages/db/src/index.ts";

function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n"
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    log("db_init_error", { error: "DATABASE_URL is not set" });
    process.exit(1);
  }

  const pool = await createPool({ connectionString: databaseUrl });
  try {
    // issues-log #2: heal libc collation-version drift before anything
    // touches indexes. A postgres-data volume that crossed an image
    // rebuild with a different glibc keeps its original
    // `datcollversion` stamp; once the running libc diverges, the
    // server returns SQLSTATE 01000 ("collation version mismatch") on
    // every handshake — which blocks JDBC IDE clients. No-op once the
    // versions agree, so it's safe on every boot.
    await refreshCollationIfDrifted(pool);

    const migrationsDir = defaultMigrationsDir();
    const migration = await runMigrations(pool, migrationsDir);
    log("migrations_applied", {
      applied: migration.applied,
      skipped: migration.skipped.length
    });

    // seeds dir is a sibling of migrations: packages/db/seeds
    const seedsDir = join(dirname(migrationsDir), "seeds");
    const seedFiles = (await readdir(seedsDir))
      .filter((name) => name.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b));

    for (const file of seedFiles) {
      const sql = await readFile(join(seedsDir, file), "utf8");
      // Seeds are multi-statement; the pg driver runs a multi-statement
      // string as a single simple-query batch.
      await pool.query(sql);
      log("seed_applied", { file });
    }

    log("db_init_complete", {
      migrations: migration.applied.length,
      seeds: seedFiles.length
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * Detect + heal glibc collation-version drift across the databases this
 * deployment touches (`ragdoll`, plus the cluster-default `template1` /
 * `postgres` so a future `createdb` inherits the corrected stamp).
 *
 * For each database whose recorded `datcollversion` no longer matches
 * the version the running OS provides, REINDEX it (rebuild indexes that
 * were sorted under the old collation — only meaningful for the
 * connected `ragdoll` db) then `ALTER DATABASE ... REFRESH COLLATION
 * VERSION` to clear the stamp + the handshake warning. Best-effort and
 * idempotent: a no-op when versions agree, and a per-database failure
 * (e.g. not owner of `postgres`) is logged but never fatal — the
 * `ragdoll` db is the one that matters.
 */
async function refreshCollationIfDrifted(
  pool: Awaited<ReturnType<typeof createPool>>
): Promise<void> {
  let rows: Array<{
    datname: string;
    datcollversion: string | null;
    actual: string | null;
  }>;
  try {
    const res = await pool.query<{
      datname: string;
      datcollversion: string | null;
      actual: string | null;
    }>(
      `SELECT datname,
              datcollversion,
              pg_database_collation_actual_version(oid) AS actual
         FROM pg_database
        WHERE datname IN ('ragdoll', 'template1', 'postgres')`
    );
    rows = res.rows;
  } catch (error) {
    // `pg_database_collation_actual_version` is Postgres 15+. Older
    // servers don't expose it → there's nothing we can detect here.
    log("collation_check_skipped", {
      reason: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  for (const row of rows) {
    const drifted =
      row.actual != null &&
      row.datcollversion != null &&
      row.actual !== row.datcollversion;
    if (!drifted) continue;
    log("collation_drift_detected", {
      db: row.datname,
      recorded: row.datcollversion,
      actual: row.actual
    });
    try {
      // REINDEX only the connected db (REINDEX DATABASE targets the
      // current connection). template1/postgres just get the stamp
      // refreshed — they hold no app indexes worth rebuilding here.
      if (row.datname === "ragdoll") {
        await pool.query("REINDEX DATABASE ragdoll");
      }
      // datname is whitelisted by the IN clause above → safe to inline.
      await pool.query(
        `ALTER DATABASE ${row.datname} REFRESH COLLATION VERSION`
      );
      log("collation_refreshed", { db: row.datname });
    } catch (error) {
      log("collation_refresh_failed", {
        db: row.datname,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

main().catch((error) => {
  log("db_init_fatal", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
