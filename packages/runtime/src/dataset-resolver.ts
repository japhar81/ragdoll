/**
 * Shared DatasetResolver builder for the API + worker code paths.
 *
 * Both stacks need the SAME resolution logic — slug cascade, alias
 * lookup, per-modality backend block, connection injection, and
 * pipeline binding override consultation. Duplicating it once led
 * to PR1-3 silently shipping a worker that resolved old-shape
 * datasets with no `backends` field; the plugins then hard-failed
 * because requireBackendConnection found no connection.
 *
 * This module is the single source of truth for "given a (slug,
 * tenant, env, pipeline), what concrete dataset (with resolved
 * backend connections) should the runtime hand the plugin?". Add
 * caching / metrics / tracing here, not in every caller.
 */
import type {
  DatasetResolver,
  ResolvedDatasetBackend
} from "../../plugin-sdk/src/index.ts";
import type {
  DatasetRepository,
  DatasetVersionRepository,
  DatasetAliasRepository,
  DatasourceConnectionRepository,
  PipelineDatasetBindingRepository,
  DatasetRow
} from "../../db/src/index.ts";

export interface DatasetResolverDeps {
  datasets: DatasetRepository;
  datasetVersions: DatasetVersionRepository;
  datasetAliases: DatasetAliasRepository;
  /** Optional. When set, `backends[m].connectionName` resolves to a
   *  per-(tenant, env) connection row injected onto the backend block. */
  datasources?: DatasourceConnectionRepository;
  /** Optional. When set + pipelineId passed to resolve(), the binding
   *  cascade beats the default slug resolution. */
  pipelineDatasetBindings?: PipelineDatasetBindingRepository;
}

export function buildDatasetResolver(deps: DatasetResolverDeps): DatasetResolver {
  return {
    async resolve(args) {
      // PR3: pipeline binding override beats the default slug cascade.
      let ds: DatasetRow | undefined;
      if (deps.pipelineDatasetBindings && args.pipelineId && args.tenantId) {
        const binding = await deps.pipelineDatasetBindings.resolveBinding({
          pipelineId: args.pipelineId,
          tenantId: args.tenantId,
          environmentId: args.environmentId,
          sourceSlug: args.ref.slug
        });
        if (binding) {
          ds = await deps.datasets.get(binding.targetDatasetId);
        }
      }
      if (!ds) {
        ds = await deps.datasets.resolveSlug({
          slug: args.ref.slug,
          tenantId: args.tenantId,
          environmentId: args.environmentId
        });
      }
      if (!ds) return undefined;

      const aliasName = args.ref.alias ?? "stable";
      const aliasRow = await deps.datasetAliases.resolve(ds.id, aliasName);
      const versionId = aliasRow?.versionId ?? ds.currentVersionId;
      if (!versionId) return undefined;
      const ver = await deps.datasetVersions.get(versionId);
      if (!ver) return undefined;

      // PR2: per-modality backend block + injected connection. Lookup
      // ALWAYS uses the caller's tenant context, not the dataset's, so
      // a global-scope dataset resolves to per-tenant connections.
      const backends: Record<string, Record<string, unknown>> = {};
      for (const [modality, raw] of Object.entries(ds.backends ?? {})) {
        if (!raw || typeof raw !== "object") continue;
        const block: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
        const connName =
          typeof block.connectionName === "string" ? block.connectionName : undefined;
        if (connName && deps.datasources && args.tenantId) {
          const conn = await deps.datasources.resolveForEnv(
            args.tenantId,
            args.environmentId,
            connName
          );
          if (conn) {
            const cfg = conn.configRedacted as { host?: unknown; port?: unknown };
            block.connection = {
              name: conn.name,
              type: conn.datasourceType,
              host: typeof cfg.host === "string" ? cfg.host : undefined,
              port: typeof cfg.port === "number" ? cfg.port : undefined,
              secretRefId: conn.secretRefId ?? null,
              config: conn.configRedacted,
              cascadeReason: conn.environmentId ? "env_specific" : "tenant_fallback"
            };
          }
        }
        backends[modality] = block;
      }

      return {
        id: ds.id,
        slug: ds.slug,
        scope: ds.scope,
        tenantId: ds.tenantId ?? undefined,
        environmentId: ds.environmentId ?? undefined,
        modalities: ds.modalities,
        embeddingProfile: ds.embeddingProfile,
        chunkSchema: ds.chunkSchema,
        version: {
          id: ver.id,
          versionLabel: ver.versionLabel,
          status: ver.status
        },
        backendCollections: ver.backendCollections,
        backends: backends as Record<string, ResolvedDatasetBackend>
      };
    }
  };
}
