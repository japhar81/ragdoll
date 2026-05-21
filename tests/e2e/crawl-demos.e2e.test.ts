/**
 * Offline proof that the two out-of-the-box crawler demo pipelines
 * (examples/pipelines/web-crawl-demo.yaml and crawl-summarize-demo.yaml) are
 * structurally valid AND that the seed (packages/db/seeds/zzz-crawl-demo.sql)
 * stays byte/checksum in sync with the YAML. It:
 *
 *   1. loads each YAML via the pipeline-spec loader,
 *   2. validates DAG shape/edges with validatePipelineSpec WITHOUT a registry
 *      (the `crawl4ai_crawler` plugin is EXTERNAL and only registered when
 *      PYTHON_PLUGIN_URL is set, so a registry validation would flag it as a
 *      missing plugin; we assert structure instead),
 *   3. asserts apiVersion/kind/metadata.name, node ids, edges, and that the
 *      crawl node references plugin id `crawl4ai_crawler`,
 *   4. asserts specChecksum(loaded) equals the checksum string embedded in
 *      zzz-crawl-demo.sql so the seed and YAML can never silently drift.
 *
 * Fully offline / install-free: node:test + --experimental-strip-types. No
 * network, no pg, no docker. The orchestrator live-runs the real crawl.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  loadPipelineSpec,
  validatePipelineSpec,
  specChecksum
} from "../../packages/pipeline-spec/src/index.ts";
import type { PipelineSpec } from "../../packages/core/src/index.ts";

const SEED_SQL = fileURLToPath(
  new URL("../../packages/db/seeds/zzz-crawl-demo.sql", import.meta.url)
);

function yamlPath(name: string): string {
  return fileURLToPath(
    new URL(`../../examples/pipelines/${name}.yaml`, import.meta.url)
  );
}

/**
 * Pulls the `checksum` literal out of the pipeline_versions INSERT whose
 * jsonb spec carries `"name":"<pipelineName>"`. Mirrors how the seed embeds
 * the spec JSON immediately followed by the checksum string.
 */
async function seededChecksum(pipelineName: string): Promise<string> {
  const sql = await readFile(SEED_SQL, "utf8");
  const re = new RegExp(
    `"name":"${pipelineName}"[\\s\\S]*?'::jsonb,\\s*\\n\\s*'([0-9a-f]+)'`
  );
  const match = sql.match(re);
  assert.ok(match, `checksum for ${pipelineName} not found in zzz-crawl-demo.sql`);
  return match![1];
}

function nodeIds(spec: PipelineSpec): string[] {
  return spec.spec.nodes.map((n) => n.id);
}

function edgePairs(spec: PipelineSpec): string[] {
  return spec.spec.edges.map((e) => `${e.from}->${e.to}`);
}

test("web-crawl-demo.yaml is a valid crawler DAG and matches its seed checksum", async () => {
  const spec = loadPipelineSpec(await readFile(yamlPath("web-crawl-demo"), "utf8"));

  assert.equal(spec.apiVersion, "rag-platform/v1");
  assert.equal(spec.kind, "Pipeline");
  assert.equal(spec.metadata.name, "web-crawl-demo");

  // Structural validation WITHOUT a registry (the external crawler plugin is
  // only registered when PYTHON_PLUGIN_URL is set).
  const result = validatePipelineSpec(spec);
  assert.equal(
    result.valid,
    true,
    `expected valid; errors: ${JSON.stringify(result.errors)}`
  );
  assert.equal(result.missingPlugins.length, 0);

  assert.deepEqual(nodeIds(spec), ["input", "crawl", "output"]);
  assert.deepEqual(edgePairs(spec), ["input->crawl", "crawl->output"]);

  const crawl = spec.spec.nodes.find((n) => n.id === "crawl");
  assert.equal(crawl?.plugin?.category, "datasource");
  assert.equal(crawl?.plugin?.id, "crawl4ai_crawler");
  assert.equal(crawl?.plugin?.version, "1.0.0");
  assert.equal((crawl?.config as { url?: string })?.url, "https://www.cnn.com");

  // input/output are explicit graph nodes (no warnings about missing them).
  assert.equal(spec.spec.nodes.find((n) => n.id === "input")?.type, "input");
  assert.equal(spec.spec.nodes.find((n) => n.id === "output")?.type, "output");

  assert.equal(specChecksum(spec), await seededChecksum("web-crawl-demo"));
});

test("crawl-summarize-demo.yaml is a valid crawl->prompt->llm DAG and matches its seed checksum", async () => {
  const spec = loadPipelineSpec(
    await readFile(yamlPath("crawl-summarize-demo"), "utf8")
  );

  assert.equal(spec.apiVersion, "rag-platform/v1");
  assert.equal(spec.kind, "Pipeline");
  assert.equal(spec.metadata.name, "crawl-summarize-demo");

  const result = validatePipelineSpec(spec);
  assert.equal(
    result.valid,
    true,
    `expected valid; errors: ${JSON.stringify(result.errors)}`
  );
  assert.equal(result.missingPlugins.length, 0);

  assert.deepEqual(nodeIds(spec), [
    "input",
    "retrieve",
    "prompt",
    "llm",
    "output"
  ]);
  assert.deepEqual(edgePairs(spec), [
    "input->prompt",
    "input->retrieve",
    "retrieve->prompt",
    "prompt->llm",
    "llm->output"
  ]);

  // Crawl node id "retrieve" feeds `documents` via an explicit port edge into
  // basic_rag_prompt's `documents` port; the question forks separately from
  // the framework input node into the prompt's `question` port.
  const retrieve = spec.spec.nodes.find((n) => n.id === "retrieve");
  assert.equal(retrieve?.plugin?.category, "datasource");
  assert.equal(retrieve?.plugin?.id, "crawl4ai_crawler");
  assert.equal(retrieve?.plugin?.version, "1.0.0");

  const prompt = spec.spec.nodes.find((n) => n.id === "prompt");
  assert.equal(prompt?.plugin?.id, "basic_rag_prompt");

  const llm = spec.spec.nodes.find((n) => n.id === "llm");
  assert.equal(llm?.plugin?.id, "provider_chat");
  // Reuses tenant-local's seeded Ollama config like local-demo.
  assert.equal(
    (llm?.config as { provider?: string })?.provider,
    "${config.llm.provider}"
  );

  // The crawl-summarize spec requires exactly the llm.* config the
  // zz-local-demo seed already provides for tenant-local.
  assert.deepEqual(result.requiredConfig.sort(), [
    "llm.base_url",
    "llm.model",
    "llm.provider"
  ]);

  assert.equal(
    specChecksum(spec),
    await seededChecksum("crawl-summarize-demo")
  );
});
