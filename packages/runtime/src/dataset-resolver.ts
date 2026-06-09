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
  DatasetNamespacePolicy,
  DatasetResolver,
  ResolvedDatasetBackend
} from "../../plugin-sdk/src/index.ts";
import type {
  DatasetRepository,
  DatasetVersionRepository,
  DatasetAliasRepository,
  ConnectionRepository,
  PipelineDatasetBindingRepository,
  DatasetRow,
  TenantRepository,
  EnvironmentRepository
} from "../../db/src/index.ts";
import { applyNamespacePolicy } from "./dataset-namespace.ts";

export interface DatasetResolverDeps {
  datasets: DatasetRepository;
  datasetVersions: DatasetVersionRepository;
  datasetAliases: DatasetAliasRepository;
  /** Optional. When set, `backends[m].connectionName` resolves to a
   *  per-(tenant, env) connection row injected onto the backend block. */
  connections?: ConnectionRepository;
  /** Optional. When set + pipelineId passed to resolve(), the binding
   *  cascade beats the default slug resolution. */
  pipelineDatasetBindings?: PipelineDatasetBindingRepository;
  /** Optional. When set + a backend block declares a `namespace` policy
   *  other than `shared`, the resolver looks up the tenant slug here
   *  to compute the per-tenant collection suffix. Without it, any
   *  `by-tenant*` policy degrades silently to `shared`. */
  tenants?: TenantRepository;
  /** Optional, same rationale as `tenants` — required to expand
   *  `by-tenant-env` / `by-env` policies. */
  environments?: EnvironmentRepository;
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
        if (connName && deps.connections && args.tenantId) {
          // ADR-0023: unified connection registry. Slug resolution walks
          // env → tenant → global (datasets stop at tenant in the old
          // model, but the unified resolver naturally handles globals
          // too, so a global dataset referencing a global connection
          // works without special-casing).
          const conn = await deps.connections.resolveSlug({
            slug: connName,
            tenantId: args.tenantId,
            environmentId: args.environmentId
          });
          if (conn) {
            const cfg = (conn.config ?? {}) as { host?: unknown; port?: unknown };
            block.connection = {
              name: conn.slug,
              type: conn.kind,
              host: typeof cfg.host === "string" ? cfg.host : undefined,
              port: typeof cfg.port === "number" ? cfg.port : undefined,
              secretRefId: conn.secretRefId ?? null,
              config: conn.config,
              cascadeReason: conn.environmentId
                ? "env_specific"
                : "tenant_fallback"
            };
          }
        }
        backends[modality] = block;
      }

      // PR6: namespace policy. The base collection name lives on the
      // version (`backend_collections.<modality>`); the policy lives on
      // the dataset's per-modality backend block. Apply the suffix HERE
      // so every plugin reads the effective collection name from
      // `backendCollections` without knowing the policy exists.
      //
      // Tenant slug / env name are looked up lazily — most resolves are
      // shared-namespace and pay nothing. When `namespace !== "shared"`
      // we pay one extra SELECT to fetch the slug. The lookup uses the
      // CALLER's tenant/env so a global dataset's namespace expands per
      // caller, matching how connection injection already works.
      const baseCollections = (ver.backendCollections ?? {}) as Record<string, string>;
      const effectiveCollections: Record<string, string> = {};
      let tenantSlugCache: string | undefined;
      let envNameCache: string | undefined;
      let tenantLookupTried = false;
      let envLookupTried = false;
      for (const [modality, base] of Object.entries(baseCollections)) {
        const block = backends[modality];
        const policy =
          block && typeof block.namespace === "string"
            ? (block.namespace as DatasetNamespacePolicy)
            : undefined;
        if (!policy || policy === "shared") {
          effectiveCollections[modality] = base;
          continue;
        }
        if (
          !tenantLookupTried &&
          deps.tenants &&
          args.tenantId &&
          (policy === "by-tenant" || policy === "by-tenant-env")
        ) {
          tenantLookupTried = true;
          const t = await deps.tenants.get(args.tenantId);
          tenantSlugCache = t?.slug;
        }
        if (
          !envLookupTried &&
          deps.environments &&
          args.environmentId &&
          (policy === "by-env" || policy === "by-tenant-env")
        ) {
          envLookupTried = true;
          const e = await deps.environments.get(args.environmentId);
          envNameCache = e?.name;
        }
        effectiveCollections[modality] = applyNamespacePolicy({
          baseName: base,
          policy,
          tenantSlug: tenantSlugCache,
          environmentName: envNameCache
        });
      }

      // ADR-0023: build the `bindings` view alongside `backends`. For
      // datasets with an explicit `bindings:` block, use it. For legacy
      // datasets (only `backends` populated), derive each binding from
      // the matching backend block — the migration backfill normally
      // populates `bindings`, but synthesise here too so in-memory test
      // datasets without a backfill still surface bindings.
      const bindings: Record<
        string,
        { connectionSlug?: string; collection?: string }
      > = {};
      const bindingsSource = (ds.bindings ?? {}) as Record<
        string,
        { connection?: string; collection?: string } | undefined
      >;
      const allBindingNames = new Set<string>([
        ...Object.keys(bindingsSource),
        ...Object.keys(backends)
      ]);
      for (const name of allBindingNames) {
        const explicit = bindingsSource[name];
        const legacyBlock = backends[name] as Record<string, unknown> | undefined;
        const connectionSlug =
          explicit?.connection ??
          (legacyBlock?.connectionName as string | undefined);
        const collection =
          explicit?.collection ??
          (legacyBlock?.collection as string | undefined) ??
          effectiveCollections[name];
        bindings[name] = { connectionSlug, collection };
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
        backendCollections: effectiveCollections,
        backends: backends as Record<string, ResolvedDatasetBackend>,
        bindings
      };
    }
  };
}
