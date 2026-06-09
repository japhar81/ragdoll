/**
 * Shared DatasetResolver builder for the API + worker code paths.
 *
 * Both stacks need the SAME resolution logic — slug cascade, alias
 * lookup, per-binding connection injection, per-binding namespace
 * policy, pipeline binding override consultation. Duplicating it
 * was the source of a class of bugs where one stack saw old-shape
 * datasets and the other didn't.
 *
 * This module is the single source of truth for "given a (slug,
 * tenant, env, pipeline), what concrete dataset (with resolved
 * binding connections + collections) should the runtime hand the
 * plugin?". Add caching / metrics / tracing here, not in every
 * caller.
 *
 * ADR-0023: bindings are the only shape. The legacy `backends.<modality>`
 * block is gone — both the database column (migration 021) and the
 * resolver output.
 */
import type {
  DatasetNamespacePolicy,
  DatasetResolver,
  ResolvedDatasetBinding
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
  /** Optional. When set, every `bindings[name].connection` slug
   *  resolves through the unified registry to a real connection row,
   *  injected onto the binding so plugins see kind / host / port. */
  connections?: ConnectionRepository;
  /** Optional. When set + pipelineId passed to resolve(), the binding
   *  cascade beats the default slug resolution. */
  pipelineDatasetBindings?: PipelineDatasetBindingRepository;
  /** Optional. When set + a binding declares a `namespace` policy
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
      // Pipeline binding override beats the default slug cascade.
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

      // Namespace policy expansion — same lookup cache for every binding,
      // most resolves are `shared` and pay nothing extra.
      let tenantSlugCache: string | undefined;
      let envNameCache: string | undefined;
      let tenantLookupTried = false;
      let envLookupTried = false;
      const expandNamespace = async (
        base: string,
        policy: DatasetNamespacePolicy | undefined
      ): Promise<string> => {
        if (!policy || policy === "shared") return base;
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
        return applyNamespacePolicy({
          baseName: base,
          policy,
          tenantSlug: tenantSlugCache,
          environmentName: envNameCache
        });
      };

      // Build the resolved bindings map. For each binding declared on
      // the dataset:
      //  - resolve the connection slug through the unified registry
      //    (env → tenant → global) using the CALLER's tenant/env, so a
      //    global dataset resolves to per-tenant connections,
      //  - default `collection` to the version's
      //    `backendCollections[<bindingName>]` when the binding doesn't
      //    override it (every chunk a plugin reads / writes still goes
      //    to the right place even if the dataset author leaves
      //    collection blank — the version owns the canonical name),
      //  - expand the namespace policy onto the effective collection.
      const versionCollections = (ver.backendCollections ?? {}) as Record<string, string>;
      const declaredBindings = (ds.bindings ?? {}) as Record<
        string,
        { connection?: string; collection?: string; namespace?: string } | undefined
      >;
      const bindings: Record<string, ResolvedDatasetBinding> = {};
      for (const [name, raw] of Object.entries(declaredBindings)) {
        if (!raw) continue;
        const policy =
          typeof raw.namespace === "string"
            ? (raw.namespace as DatasetNamespacePolicy)
            : undefined;
        const base =
          (typeof raw.collection === "string" && raw.collection) ||
          versionCollections[name] ||
          undefined;
        const effectiveCollection = base
          ? await expandNamespace(base, policy)
          : undefined;

        let connection: ResolvedDatasetBinding["connection"];
        let connectionKind: string | undefined;
        let connectionHost: string | undefined;
        let connectionPort: number | undefined;
        let cascadeReason: ResolvedDatasetBinding["cascadeReason"];
        if (raw.connection && deps.connections && args.tenantId) {
          const conn = await deps.connections.resolveSlug({
            slug: raw.connection,
            tenantId: args.tenantId,
            environmentId: args.environmentId
          });
          if (conn) {
            const cfg = (conn.config ?? {}) as { host?: unknown; port?: unknown };
            connectionKind = conn.kind;
            connectionHost = typeof cfg.host === "string" ? cfg.host : undefined;
            connectionPort = typeof cfg.port === "number" ? cfg.port : undefined;
            cascadeReason =
              conn.scope === "environment"
                ? "environment"
                : conn.scope === "tenant"
                  ? "tenant"
                  : "global";
            connection = {
              id: conn.id,
              slug: conn.slug,
              kind: conn.kind,
              secret: undefined, // resolved at acquireClient time, not here
              options: conn.config ?? {},
              cascadeReason
            };
          }
        }

        bindings[name] = {
          connectionSlug: raw.connection,
          connectionKind,
          connectionHost,
          connectionPort,
          collection: effectiveCollection,
          namespace: policy,
          cascadeReason,
          ...(connection ? { connection } : {})
        };
      }

      return {
        id: ds.id,
        slug: ds.slug,
        scope: ds.scope,
        tenantId: ds.tenantId ?? undefined,
        environmentId: ds.environmentId ?? undefined,
        embeddingProfile: ds.embeddingProfile,
        chunkSchema: ds.chunkSchema,
        version: {
          id: ver.id,
          versionLabel: ver.versionLabel,
          status: ver.status
        },
        bindings
      };
    }
  };
}
