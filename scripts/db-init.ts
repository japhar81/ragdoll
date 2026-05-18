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

main().catch((error) => {
  log("db_init_fatal", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
