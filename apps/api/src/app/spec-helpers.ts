/**
 * Pure helpers used by the routes layer that don't capture createApp's
 * closure state. Kept off app.ts so the main file is closer to "just the
 * routes + the dep wiring."
 */

import { readFile } from "node:fs/promises";
import type {
  PipelineSpec,
  SecretRef
} from "../../../../packages/core/src/index.ts";
import { loadPipelineSpec } from "../../../../packages/pipeline-spec/src/index.ts";
import {
  selectDeployedVersion,
  type PipelineDeployment
} from "../../../../packages/pipeline-spec/src/index.ts";
import type { RegisteredPlugin } from "../../../../packages/plugin-sdk/src/index.ts";
import type { PipelineVersionRow } from "../../../../packages/db/src/index.ts";
import type { AppDeps } from "./types.ts";
import { isObject } from "./http-utils.ts";

/**
 * Reads the narrative markdown doc for a plugin id from `docs/plugins/<id>.md`,
 * resolved relative to this module (works regardless of cwd, and in the
 * container image where `COPY . .` places the repo under /app). Returns
 * `undefined` when the file is absent — a plugin without a narrative doc is
 * not an error. The `id` MUST be pre-validated by the caller.
 */
export async function readPluginDoc(id: string): Promise<string | undefined> {
  try {
    return await readFile(
      new URL(`../../../../docs/plugins/${id}.md`, import.meta.url),
      "utf8"
    );
  } catch {
    return undefined;
  }
}

/**
 * Projects a registered plugin's manifest onto the public shape consumed by
 * the web UI to render schema-driven config/secret forms. This is the single
 * source of truth shared by `GET /api/plugins` and the per-plugin route, so
 * both responses always match the documented contract.
 */
export function projectPlugin(plugin: RegisteredPlugin): {
  id: string;
  name: string;
  version: string;
  category: string;
  contract?: number;
  datasetModalities?: string[];
  requires?: Array<{
    binding?: string;
    kind?: string;
    kindOneOf?: string[];
    modality?: string;
    provider?: string;
  }>;
  description: string;
  mode: string;
  capabilities: string[];
  configSchema?: unknown;
  secretsSchema?: unknown;
  inputPorts?: unknown;
  outputPorts?: unknown;
  dynamicPorts?: { inputsFrom?: string; outputsFrom?: string };
  ui?: {
    icon?: string;
    color?: string;
    formHints?: Record<string, unknown>;
    paletteGroup?: string;
    module?: string;
  };
  /** PLUGIN-ARCH-1: where this plugin's code came from. Present on
   *  every plugin the new loader registers; absent on legacy paths
   *  (the UI tolerates both — the operator just sees no provenance
   *  badge for legacy plugins). */
  source?: {
    repoId: string;
    kind: "local" | "git";
    gitUrl?: string;
    ref?: string;
    commitSha?: string;
    subpath?: string;
    loadedAt?: string;
  };
} {
  const m = plugin.manifest;
  const ui = m.ui
    ? {
        ...(m.ui.icon !== undefined ? { icon: m.ui.icon } : {}),
        ...(m.ui.color !== undefined ? { color: m.ui.color } : {}),
        ...(m.ui.formHints !== undefined ? { formHints: m.ui.formHints } : {}),
        ...(m.ui.paletteGroup !== undefined
          ? { paletteGroup: m.ui.paletteGroup }
          : {}),
        ...(m.ui.module !== undefined ? { module: m.ui.module } : {})
      }
    : undefined;
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    category: m.category,
    // contract version drives the Builder's "needs a Dataset binding"
    // validation rule — v1 plugins still use config.collection, v2 plugins
    // must pin a slug. Without this on the wire, the client treats every
    // plugin as v1 and the badge never lights up.
    ...(m.contract !== undefined ? { contract: m.contract } : {}),
    // ADR-0023: `requires` drives the Builder's compatible-slugs filter
    // and the `dataset_binding_missing` / `dataset_binding_kind_mismatch`
    // validator. Surfaced on the wire so the client-side validator can
    // hint the operator before they hit Run. Legacy
    // `datasetModalities` carried alongside for plugins that still
    // declare it.
    ...(m.requires !== undefined ? { requires: m.requires } : {}),
    ...(m.datasetModalities !== undefined
      ? { datasetModalities: m.datasetModalities }
      : {}),
    description: m.description,
    mode: plugin.mode,
    capabilities: m.capabilities ?? [],
    ...(m.configSchema !== undefined ? { configSchema: m.configSchema } : {}),
    ...(m.secretsSchema !== undefined
      ? { secretsSchema: m.secretsSchema }
      : {}),
    ...(m.inputPorts !== undefined ? { inputPorts: m.inputPorts } : {}),
    ...(m.outputPorts !== undefined ? { outputPorts: m.outputPorts } : {}),
    ...(m.dynamicPorts !== undefined ? { dynamicPorts: m.dynamicPorts } : {}),
    ...(ui !== undefined ? { ui } : {}),
    // PLUGIN-ARCH-1: surface where this plugin's code came from. The
    // /api/plugins client uses it to render a provenance badge + drive
    // the per-source status indicator in the Builder palette.
    ...(plugin.source !== undefined ? { source: { ...plugin.source } } : {})
  };
}

export function parseSpec(input: unknown): PipelineSpec | undefined {
  if (typeof input === "string") {
    try {
      return loadPipelineSpec(input);
    } catch {
      return undefined;
    }
  }
  if (
    isObject(input) &&
    "apiVersion" in input &&
    "kind" in input &&
    "spec" in input
  ) {
    return input as unknown as PipelineSpec;
  }
  return undefined;
}

export function buildSecretRef(
  body: Record<string, unknown>,
  fallbackTenant: string | undefined
): SecretRef {
  const scope = (
    typeof body.scope === "string" ? body.scope : "tenant"
  ) as SecretRef["scope"];
  return {
    provider: "database_encrypted",
    scope,
    tenantId:
      typeof body.tenantId === "string"
        ? body.tenantId
        : scope === "tenant" ||
            scope === "tenant_provider" ||
            scope === "datasource"
          ? fallbackTenant
          : undefined,
    environment:
      typeof body.environment === "string" ? body.environment : undefined,
    key: body.key as string,
    version: typeof body.version === "string" ? body.version : undefined
  };
}

export async function resolveDeployedVersion(
  deps: AppDeps,
  pipelineId: string,
  environment: string,
  tenantId: string
): Promise<PipelineVersionRow | undefined> {
  // Prefer the repository's active-deployment lookup (tenant-scoped first).
  const tenantDeployment = await deps.deployments.getActiveDeployment(
    pipelineId,
    environment,
    tenantId
  );
  const envDeployment =
    tenantDeployment ??
    (await deps.deployments.getActiveDeployment(pipelineId, environment, null));

  let versionId = envDeployment?.pipelineVersionId;

  if (!versionId) {
    // Fall back to the pipeline-spec selector over the full deployment list.
    const all = await deps.deployments.listByPipeline(pipelineId);
    const deployments: PipelineDeployment[] = all
      .filter((row) => row.status === "active")
      .map((row) => ({
        pipelineId: row.pipelineId,
        environment: row.environment,
        version: row.pipelineVersionId,
        tenantId: row.tenantId ?? undefined
      }));
    const selected = selectDeployedVersion(deployments, {
      environment,
      tenantId,
      pipelineId
    });
    versionId = selected?.version;
  }

  if (!versionId) return undefined;
  return deps.pipelineVersions.get(versionId);
}
