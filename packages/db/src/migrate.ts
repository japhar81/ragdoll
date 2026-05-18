import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolLike } from "./pool.ts";
import { withTransaction } from "./pool.ts";

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** Absolute path to the migrations directory shipped with this package. */
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL("../migrations", import.meta.url));
}

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/**
 * Applies every `*.sql` file in `dir` (sorted by filename) that has not yet
 * been recorded in `schema_migrations`. Each migration runs in its own
 * transaction so a failure leaves prior migrations intact.
 */
export async function runMigrations(
  pool: PoolLike,
  dir: string = defaultMigrationsDir()
): Promise<MigrationResult> {
  await pool.query(SCHEMA_MIGRATIONS_DDL);

  const entries = (await readdir(dir))
    .filter((name: string) => name.endsWith(".sql"))
    .sort((a: string, b: string) => a.localeCompare(b));

  const appliedRows = await pool.query<{ filename: string }>(
    "SELECT filename FROM schema_migrations"
  );
  const already = new Set(appliedRows.rows.map((row) => row.filename));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const filename of entries) {
    if (already.has(filename)) {
      skipped.push(filename);
      continue;
    }
    const sql = await readFile(join(dir, filename), "utf8");
    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
    });
    applied.push(filename);
  }

  return { applied, skipped };
}
