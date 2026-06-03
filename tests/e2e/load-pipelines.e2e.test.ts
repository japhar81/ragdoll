/**
 * Offline proof that every YAML under examples/load/pipelines/ is:
 *   1. structurally valid against the real builtin plugin registry (no
 *      missing plugins, no edge/port errors),
 *   2. executable end-to-end through `DagExecutor` with NO external services
 *      (no Ollama, no Qdrant, no DB) — the whole point of the load corpus is
 *      to exercise platform overhead with side-effect-free plugins,
 *   3. byte-stable with the generated seed SQL: specChecksum(YAML) must equal
 *      the checksum string embedded in zzzzzzz-load-test-pipelines.sql so a
 *      forgotten `npm run build:load-seeds` after a YAML edit fails CI loudly.
 *
 * Fully offline / install-free: node:test + --experimental-strip-types. No
 * network, no pg, no docker — the same constraint as the k6 load harness's
 * payload, just executed in-process so a stack-free CI catches drift.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  loadPipelineSpec,
  specChecksum,
  validatePipelineSpec
} from "../../packages/pipeline-spec/src/index.ts";
import { loadPluginRegistry } from "../../packages/plugin-loader/src/index.ts";
import { DagExecutor, InMemoryExecutionStore } from "../../packages/runtime/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../packages/secrets/src/index.ts";
import type { RuntimeContext } from "../../packages/core/src/index.ts";

const PIPELINES_DIR = fileURLToPath(
  new URL("../../examples/load/pipelines/", import.meta.url)
);
const SEED_SQL = fileURLToPath(
  new URL(
    "../../packages/db/seeds/zzzzzzz-load-test-pipelines.sql",
    import.meta.url
  )
);

async function loadAllYaml(): Promise<Array<{ slug: string; text: string }>> {
  const entries = (await readdir(PIPELINES_DIR))
    .filter((n) => n.endsWith(".yaml"))
    .sort();
  const out: Array<{ slug: string; text: string }> = [];
  for (const entry of entries) {
    const text = await readFile(`${PIPELINES_DIR}${entry}`, "utf8");
    out.push({ slug: entry.replace(/\.yaml$/, ""), text });
  }
  return out;
}

/** Pulls the checksum literal that the build-load-seeds generator embeds
 *  immediately after each pipeline's jsonb spec, keyed on the spec's name. */
function seededChecksumFor(sql: string, name: string): string {
  const re = new RegExp(
    `"name":"${name}"[\\s\\S]*?'::jsonb,\\s*\\n\\s*'([0-9a-f]+)'`
  );
  const m = sql.match(re);
  if (!m) {
    throw new Error(
      `checksum for '${name}' not found in zzzzzzz-load-test-pipelines.sql — did you forget \`npm run build:load-seeds\`?`
    );
  }
  return m[1];
}

test("every load pipeline YAML is valid against the real registry", async () => {
  const registry = loadPluginRegistry();
  const yamls = await loadAllYaml();
  assert.ok(yamls.length >= 4, "expected at least 4 load pipelines");
  for (const { slug, text } of yamls) {
    const spec = loadPipelineSpec(text);
    const result = validatePipelineSpec(spec, registry);
    assert.equal(
      result.valid,
      true,
      `${slug}: expected valid; errors: ${JSON.stringify(result.errors)}`
    );
    assert.equal(
      result.missingPlugins.length,
      0,
      `${slug}: unexpected missing plugins: ${result.missingPlugins.join(", ")}`
    );
    assert.equal(
      result.requiredConfig.length,
      0,
      `${slug}: load pipelines must NOT depend on resolved config (keeps the k6 harness stack-state-independent); got: ${result.requiredConfig.join(", ")}`
    );
  }
});

test("every load pipeline YAML matches the seeded SQL checksum", async () => {
  const sql = await readFile(SEED_SQL, "utf8");
  const yamls = await loadAllYaml();
  for (const { slug, text } of yamls) {
    const spec = loadPipelineSpec(text);
    const expected = seededChecksumFor(sql, slug);
    assert.equal(
      specChecksum(spec).slice(0, 8),
      expected,
      `${slug}: YAML checksum drifted from seed SQL — run \`npm run build:load-seeds\``
    );
  }
});

test("every load pipeline executes end-to-end with no external services", async () => {
  const registry = loadPluginRegistry();
  const yamls = await loadAllYaml();
  for (const { slug, text } of yamls) {
    const spec = loadPipelineSpec(text);
    const store = new InMemoryExecutionStore();
    const executor = new DagExecutor({
      pluginRegistry: registry,
      secretProvider: new DatabaseEncryptedSecretProvider(
        new InMemorySecretRepository(),
        new StaticKeyProvider("load-test-key")
      ),
      store,
      maxRetries: 0
    });

    const context: RuntimeContext = {
      requestId: `req-${slug}`,
      executionId: `exec-${slug}`,
      tenantId: "tenant-local",
      pipelineId: slug,
      pipelineVersionId: "1.0.0",
      environment: "dev",
      resolvedConfig: {
        pipelineId: slug,
        tenantId: "tenant-local",
        environment: "dev",
        values: {},
        violations: []
      }
    };

    // Pass an empty bag to confirm the seeded input.config.default kicks in —
    // that's the same code path the k6 harness uses when it POSTs an empty
    // body (the simplest possible call shape).
    const output = await executor.execute({ spec, context, input: {} });
    assert.ok(output, `${slug}: expected non-empty terminal output`);
    const exec = store.executions.find((e) => e.executionId === `exec-${slug}`);
    assert.equal(exec?.status, "succeeded", `${slug}: ${exec?.error ?? ""}`);
  }
});
