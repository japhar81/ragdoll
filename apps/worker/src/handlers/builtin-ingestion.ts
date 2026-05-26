/**
 * Pure helpers the `ingest_datasource` job leans on:
 *
 *  - `defaultIngestionSpec` — the spec the job falls back to when the
 *    pipeline version doesn't ship an explicit ingestion graph.
 *  - `chunkDocuments` — basic fixed-window chunker for the no-plugin path.
 *  - `defaultCollectionName` — Qdrant collection naming convention used
 *    when the operator didn't pin one.
 *  - `syntheticConfig` — a minimal ResolvedConfig built from runtime
 *    overrides for offline ingestion without seeded config_definitions.
 *
 * Kept in one file because they're all small, all stateless, and all
 * fire from the same call site inside createWorker. Splitting further
 * would obscure their shared purpose.
 */

import {
  sanitizeSlug,
  stableHash
} from "../../../../packages/core/src/index.ts";
import type {
  PipelineSpec,
  ResolvedConfig
} from "../../../../packages/core/src/index.ts";

/**
 * Built-in load → chunk → embed → upsert spec used by ingest when the
 * pipeline version has no explicit ingestion graph. Uses the builtin-rag
 * plugins that ship with the platform.
 */
export function defaultIngestionSpec(): PipelineSpec {
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "builtin-ingestion" },
    spec: {
      nodes: [
        { id: "input", type: "input" },
        {
          id: "chunk",
          plugin: { category: "chunker", id: "basic_text_chunker", version: "1.0.0" },
          config: {
            chunkSize: "${config.chunking.chunk_size}",
            overlap: "${config.chunking.overlap}"
          }
        },
        {
          id: "embed",
          plugin: { category: "embedder", id: "provider_embeddings", version: "1.0.0" }
        },
        {
          id: "upsert",
          plugin: { category: "sink", id: "vector_upsert", version: "1.0.0" },
          config: {
            collection: "${config.vector.collection}",
            distance: "${config.vector.distance}"
          }
        },
        { id: "output", type: "output" }
      ],
      edges: [
        { from: "input", to: "chunk" },
        { from: "chunk", to: "embed" },
        { from: "embed", to: "upsert" },
        { from: "upsert", to: "output" }
      ]
    }
  };
}

export function chunkDocuments(
  documents: Array<{ id?: string; text: string; metadata?: Record<string, unknown> }>,
  chunkConfig?: { chunkSize?: number; overlap?: number }
): Array<{ text: string; index: number } & Record<string, unknown>> {
  const chunkSize = chunkConfig?.chunkSize ?? 1000;
  const overlap = chunkConfig?.overlap ?? 100;
  const chunks: Array<{ text: string; index: number } & Record<string, unknown>> = [];
  for (const document of documents) {
    const text = document.text ?? "";
    for (
      let start = 0;
      start < Math.max(text.length, 1);
      start += Math.max(1, chunkSize - overlap)
    ) {
      chunks.push({
        text: text.slice(start, start + chunkSize),
        index: chunks.length,
        ...(document.metadata ?? {})
      });
      if (text.length === 0) break;
    }
  }
  return chunks;
}

export function defaultCollectionName(
  environment: string,
  tenantId: string,
  pipelineId: string,
  profile: { provider: string; model: string; dimensions: number }
): string {
  return [
    "rag",
    sanitizeSlug(environment),
    sanitizeSlug(tenantId),
    sanitizeSlug(pipelineId),
    stableHash(profile)
  ].join("_");
}

/**
 * Minimal ResolvedConfig used when no config definitions exist (e.g. offline
 * ingestion with only runtime overrides). Mirrors the resolver's runtime
 * scope so `${config.*}` templates still resolve.
 */
export function syntheticConfig(
  pipelineId: string,
  pipelineVersionId: string,
  tenantId: string,
  environment: string,
  runtimeOverrides: Record<string, unknown>
): ResolvedConfig {
  const values: ResolvedConfig["values"] = {};
  for (const [key, value] of Object.entries(runtimeOverrides)) {
    values[key] = {
      value,
      sourceScope: "runtime",
      defaulted: false,
      locked: false,
      secret: false,
      sensitive: false,
      redacted: false,
      inherited: false
    };
  }
  return {
    pipelineId,
    pipelineVersionId,
    tenantId,
    environment,
    values,
    violations: []
  };
}
