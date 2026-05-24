/**
 * One-off helper that walks every `packages/db/seeds/*.sql` file, finds each
 * `'{json}'::jsonb` blob followed by an 8-hex checksum, applies the shared
 * `autoLayoutSpec` so left-to-right positions land on every node, then
 * updates the JSON blob AND the checksum in place. Idempotent — re-running
 * on already-positioned seeds is a no-op.
 *
 * Run with `node --experimental-strip-types scripts/relayout-seeds.ts`.
 *
 * The seed SQL is one of the few places we hand-encode a spec; the API
 * `save_pipeline_version` path applies the same `autoLayoutSpec` on the
 * fly so any other entry point (MCP / CLI / hand-written YAML) gets a
 * tidy LR layout automatically.
 */
import { readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  autoLayoutSpec,
  loadPipelineSpec,
  specChecksum,
  stringifyYaml
} from "../packages/pipeline-spec/src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const seedsDir = path.resolve(here, "..", "packages", "db", "seeds");

const files = [
  "demo.sql",
  "zz-local-demo.sql",
  "zzz-crawl-demo.sql",
  "zzzz-codebase-ingest.sql",
  "zzzzz-transform-demos.sql"
];

// SQL escapes a single quote as `''`. JSON literals don't carry raw `'`
// characters under normal use, but escape anyway for safety.
function sqlEscapeJson(json: string): string {
  return json.replace(/'/g, "''");
}
function sqlUnescapeJson(json: string): string {
  return json.replace(/''/g, "'");
}

interface Replacement {
  start: number;
  end: number;
  next: string;
}

async function relayoutFile(file: string): Promise<{ changed: number }> {
  const fullPath = path.join(seedsDir, file);
  const raw = await readFile(fullPath, "utf8");

  const replacements: Replacement[] = [];
  // Match each spec literal followed by a checksum literal. The
  // `[\s\S]*?` consumes the whitespace + comma between them.
  const pattern = /'(\{[\s\S]*?\})'::jsonb([\s\S]*?)'([0-9a-f]{8})'/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(raw)) !== null) {
    const fullMatch = m[0];
    const jsonText = m[1];
    const between = m[2];
    const oldChecksum = m[3];
    let spec: ReturnType<typeof autoLayoutSpec>;
    try {
      spec = JSON.parse(sqlUnescapeJson(jsonText)) as ReturnType<
        typeof autoLayoutSpec
      >;
    } catch {
      // Skip non-spec jsonb blobs (e.g. config_values).
      continue;
    }
    if (!spec || typeof spec !== "object" || (spec as Record<string, unknown>).kind !== "Pipeline") {
      continue;
    }
    const laidOut = autoLayoutSpec(spec);
    const newChecksum = specChecksum(laidOut).slice(0, 8);
    const newJson = sqlEscapeJson(JSON.stringify(laidOut));
    const nextMatch =
      "'" + newJson + "'::jsonb" + between + "'" + newChecksum + "'";
    if (nextMatch === fullMatch) continue;
    replacements.push({
      start: m.index,
      end: m.index + fullMatch.length,
      next: nextMatch
    });
    // eslint-disable-next-line no-console
    console.log(
      `  ${path.basename(file)}: relayout ${oldChecksum} -> ${newChecksum}`
    );
  }

  if (replacements.length === 0) return { changed: 0 };
  // Apply in reverse so earlier indexes stay valid.
  let out = raw;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    out = out.slice(0, r.start) + r.next + out.slice(r.end);
  }
  await writeFile(fullPath, out);
  return { changed: replacements.length };
}

/** Apply auto-layout to each example pipeline YAML so the human-
 *  readable canonical matches the seeded SQL byte-for-byte (modulo
 *  ordering). The e2e tests assert `specChecksum(yaml) === checksum in
 *  SQL`, so the two have to stay in sync. */
async function relayoutExamples(): Promise<{ changed: number }> {
  const examplesDir = path.resolve(here, "..", "examples", "pipelines");
  let changed = 0;
  for (const entry of await readdir(examplesDir)) {
    if (!entry.endsWith(".yaml")) continue;
    const filePath = path.join(examplesDir, entry);
    const text = await readFile(filePath, "utf8");
    let spec;
    try {
      spec = loadPipelineSpec(text);
    } catch {
      continue;
    }
    const laidOut = autoLayoutSpec(spec);
    if (laidOut === spec) continue;
    await writeFile(filePath, stringifyYaml(laidOut));
    // eslint-disable-next-line no-console
    console.log(`  ${entry}: relayout`);
    changed += 1;
  }
  return { changed };
}

async function main(): Promise<void> {
  let total = 0;
  for (const file of files) {
    // eslint-disable-next-line no-console
    console.log(`scanning ${file}`);
    const { changed } = await relayoutFile(file);
    total += changed;
  }
  // eslint-disable-next-line no-console
  console.log("scanning examples/pipelines/*.yaml");
  const { changed } = await relayoutExamples();
  total += changed;
  // eslint-disable-next-line no-console
  console.log(`done — ${total} spec(s) relaid out`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
