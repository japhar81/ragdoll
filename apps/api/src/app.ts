/**
 * Framework-agnostic RAGdoll control-plane application.
 *
 * `createApp(deps)` returns an object with a pure `handle(request)` router.
 * NOTHING in this file imports fastify or any HTTP framework, so it can be
 * exercised directly by `node:test` functional tests with InMemory deps and
 * zero install.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  redactValue,
  type ConfigDefinition,
  type ConfigValue,
  type PipelineSpec,
  type PluginRef,
  type SecretRef
} from "../../../packages/core/src/index.ts";
import {
  AuthResolver,
  ApiKeyService,
  enforce,
  UnauthorizedError,
  InvalidCredentialsError,
  TokenInvalidError,
  TokenExpiredError,
  Authorizer,
  AccountService,
  SessionTokenService,
  PasswordService,
  OidcProvider,
  SamlProvider,
  randomToken,
  SignupDisabledError,
  AccountDisabledError,
  EmailInUseError,
  WebhookTokenService,
  InvalidWebhookTokenError,
  type SsoIdentity,
  type Permission,
  type Principal,
  type ApiKeyRecord
} from "../../../packages/auth/src/index.ts";
import {
  AuthorizationError,
  ALL_PERMISSIONS,
  ALL_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  parseScope,
  scopeToString,
  scopeCovers,
  type ScopeInput
} from "../../../packages/authz/src/index.ts";
import { ConfigResolver } from "../../../packages/config-resolver/src/index.ts";
import {
  validatePipelineSpec,
  autoLayoutSpec,
  loadPipelineSpec,
  exportSpec,
  specChecksum,
  publishVersion,
  archiveVersion,
  selectDeployedVersion,
  nextVersionOnSave,
  rollbackPointer,
  resolveActivation,
  effectiveVersionId,
  ImmutableVersionError,
  VersionNotFoundError,
  ActivationResolutionError,
  type PipelineVersionRecord,
  type PipelineDeployment
} from "../../../packages/pipeline-spec/src/index.ts";
import { parseCron, nextAfter, CronParseError } from "../../../packages/cron/src/index.ts";
import {
  NotFoundError,
  ConflictError,
  InMemoryPipelineFolderRepository,
  InMemoryPipelineActivationRepository,
  InMemoryScheduleRepository,
  InMemoryTenantPipelineRepository,
  InMemoryEnvironmentRepository,
  InMemoryDatasetRepository,
  InMemoryDatasetVersionRepository,
  InMemoryDatasetAliasRepository,
  InMemoryRetentionSettingsRepository,
  type DatasetRepository,
  type DatasetRow,
  type DatasetVersionRepository,
  type DatasetVersionRow,
  type DatasetAliasRepository,
  type DatasetAliasRow,
  InMemoryUserRepository,
  InMemoryUserIdentityRepository,
  InMemoryIdentityProviderRepository,
  InMemoryRbacPolicyRepository,
  InMemoryAuthSettingsRepository,
  InMemoryRoleRepository,
  InMemoryWebhookTriggerRepository,
  InMemoryApiKeyRepository,
  type WebhookTriggerRepository,
  type WebhookTriggerRow,
  type UserRepository,
  type UserIdentityRepository,
  type IdentityProviderRepository,
  type RbacPolicyRepository,
  type AuthSettingsRepository,
  type RoleRepository,
  type UserRow,
  type IdentityProviderRow,
  type RbacGrantRow,
  type SignupMode,
  type TenantRepository,
  type EnvironmentRepository,
  type PipelineRepository,
  type PipelineVersionRepository,
  type PipelineDeploymentRepository,
  type PipelineFolderRepository,
  type PipelineActivationRepository,
  type ScheduleRepository,
  type TenantGitConfigRepository,
  type TenantPipelineRepository,
  type ConfigDefinitionRepository,
  type ConfigValueRepository,
  type AuditLogRepository,
  type UsageRecordRepository,
  type RetentionSettingsRepository,
  type PluginRepository,
  type ProviderRepository,
  type DatasourceConnectionRepository,
  type VectorCollectionRepository,
  type TenantRow,
  type EnvironmentRow,
  type PipelineRow,
  type PipelineVersionRow,
  type PipelineDeploymentRow,
  type PipelineFolderRow,
  type PipelineActivationRow,
  type ScheduleRow,
  type TenantPipelineRow,
  type ConfigDefinitionRow,
  type ConfigValueRow
} from "../../../packages/db/src/index.ts";
import type {
  ExecutionStore,
  ExecutionRecord,
  ExecutionNodeRecord
} from "../../../packages/runtime/src/index.ts";
import { DagExecutor } from "../../../packages/runtime/src/index.ts";
import type { DatasetResolver } from "../../../packages/plugin-sdk/src/index.ts";
import type { SecretProvider } from "../../../packages/secrets/src/index.ts";
import { SecretNotFoundError, SecretAccessDeniedError } from "../../../packages/secrets/src/index.ts";
import type {
  PluginRegistry,
  RegisteredPlugin
} from "../../../packages/plugin-sdk/src/index.ts";
import type { ProviderRegistry } from "../../../packages/providers/src/index.ts";
import type { StructuredLogger } from "../../../packages/observability/src/index.ts";
import type { QueuePort, QueueJob } from "../../../apps/worker/src/index.ts";
import {
  InMemoryChangeBus,
  type ChangeBus
} from "../../../packages/events/src/index.ts";

// Types (AppRequest, AppResponse, CursorPage, ReadableExecutionStore,
// AppDeps, App) live in ./app/types.ts. Re-exported below so callers
// importing from `apps/api/src/app.ts` keep working. The
// framework-agnostic shape lets the route closures below stay tightly
// scoped to deps without dragging the type bodies through this file.
export type {
  AppRequest,
  AppResponse,
  CursorPage,
  ReadableExecutionStore,
  AppDeps,
  App,
  ApiQueueJobType,
  ApiQueueJob
} from "./app/types.ts";
import type {
  AppRequest,
  AppResponse,
  CursorPage,
  ReadableExecutionStore,
  AppDeps,
  App,
  ApiQueueJob
} from "./app/types.ts";
export {
  decodeCursor,
  encodeCursor
} from "./app/http-utils.ts";
import {
  JSON_HEADERS,
  ok,
  error,
  headerValue,
  isObject,
  nowIso,
  isUuid,
  isInvalidTextRepresentation,
  decodeCursor,
  encodeCursor,
  compile,
  matchRoute
} from "./app/http-utils.ts";
import {
  readPluginDoc,
  projectPlugin,
  parseSpec,
  buildSecretRef,
  resolveDeployedVersion
} from "./app/spec-helpers.ts";
import { registerObservabilityRoutes } from "./app/routes/observability.ts";
import { registerHealthRoutes } from "./app/routes/health.ts";
import { registerPluginsProvidersRoutes } from "./app/routes/plugins-providers.ts";
import { registerSecretsRoutes } from "./app/routes/secrets.ts";
import { registerExecutionsRoutes } from "./app/routes/executions.ts";
import { registerTenantsRoutes } from "./app/routes/tenants.ts";

// `Handler` + `Route` + `RouteContext` close over `Principal` (per-request
// authenticated user) and `AppDeps` (the deps bundle createApp receives),
// so they stay local — extracting them would force every caller to import
// a Principal type just to read a route signature.
type Handler = (ctx: RouteContext) => Promise<AppResponse>;
interface Route {
  method: string;
  /** Pattern segments; `:name` captures a path param. */
  segments: string[];
  handler: Handler;
}
interface RouteContext {
  request: AppRequest;
  params: Record<string, string>;
  principal: Principal;
  deps: AppDeps;
}

export function createApp(deps: AppDeps): App {
  const routes: Route[] = [];
  const route = (method: string, pattern: string, handler: Handler): void => {
    routes.push({ method, segments: compile(pattern), handler });
  };

  // Resolve optional Wave-B repositories to concrete instances once. Harnesses
  // that omit them get fresh InMemory stores so folder/activation/schedule
  // routes work without the caller having to wire anything new.
  const pipelineFolders: PipelineFolderRepository =
    deps.pipelineFolders ?? new InMemoryPipelineFolderRepository();
  const pipelineActivations: PipelineActivationRepository =
    deps.pipelineActivations ?? new InMemoryPipelineActivationRepository();
  const schedules: ScheduleRepository =
    deps.schedules ?? new InMemoryScheduleRepository();
  const tenantPipelines: TenantPipelineRepository =
    deps.tenantPipelines ?? new InMemoryTenantPipelineRepository();
  const environments: EnvironmentRepository =
    deps.environments ?? new InMemoryEnvironmentRepository();
  const datasets: DatasetRepository =
    deps.datasets ?? new InMemoryDatasetRepository();
  const datasetVersions: DatasetVersionRepository =
    deps.datasetVersions ?? new InMemoryDatasetVersionRepository();
  const datasetAliases: DatasetAliasRepository =
    deps.datasetAliases ?? new InMemoryDatasetAliasRepository();
  const retentionSettings: RetentionSettingsRepository =
    deps.retentionSettings ?? new InMemoryRetentionSettingsRepository();

  // ---- auth / RBAC stores -------------------------------------------------
  const users: UserRepository =
    deps.users ?? new InMemoryUserRepository();
  const userIdentities: UserIdentityRepository =
    deps.userIdentities ?? new InMemoryUserIdentityRepository();
  const identityProviders: IdentityProviderRepository =
    deps.identityProviders ?? new InMemoryIdentityProviderRepository();
  const rbacPolicies: RbacPolicyRepository =
    deps.rbacPolicies ?? new InMemoryRbacPolicyRepository();
  const authSettings: AuthSettingsRepository =
    deps.authSettings ?? new InMemoryAuthSettingsRepository();
  const roleCatalog: RoleRepository =
    deps.roles ?? new InMemoryRoleRepository();
  const webhookTriggers: WebhookTriggerRepository =
    deps.webhookTriggers ?? new InMemoryWebhookTriggerRepository();
  const apiKeys: ApiKeyService =
    deps.apiKeys ?? new ApiKeyService(new InMemoryApiKeyRepository());
  const changeBus: ChangeBus =
    deps.changeBus ?? new InMemoryChangeBus({ logger: deps.logger });
  // The authorizer is the scoped, default-deny decision point. When omitted
  // (legacy harnesses) route `enforce(...)` keeps using the flat role map.
  const authorizer: Authorizer | undefined = deps.authorizer;
  const accounts: AccountService | undefined =
    deps.accounts ??
    (deps.sessions
      ? new AccountService({
          users,
          identities: userIdentities,
          grants: rbacPolicies,
          settings: authSettings,
          sessions: deps.sessions
        })
      : undefined);
  const passwords = new PasswordService();
  // Pending SSO logins: state -> {slug,nonce,redirectUri}. In-process with a
  // short TTL; multi-replica SSO needs a shared store (documented in the ADR).
  const ssoStates = new Map<
    string,
    { slug: string; nonce: string; redirectUri: string; at: number }
  >();
  const SSO_STATE_TTL_MS = 10 * 60 * 1000;

  // ---- audit helper -------------------------------------------------------
  /**
   * Per-action permission required to receive the live `ChangeEvent` for
   * that action. The WebSocket fan-out drops tagged events for subscribers
   * that lack the permission at the event's tenant scope, so a tenant
   * `viewer` no longer sees `secret.*` rotations or `user.grants.*`
   * mutations even though those events ARE published into the bus. The
   * audit row itself is unaffected — system-of-record records every
   * mutation regardless of subscriber visibility. Untagged actions remain
   * visible to every subscriber the tenant filter admits (the bulk of
   * `pipeline.*` / `execution.*` traffic).
   */
  const SENSITIVE_ACTIONS: Record<string, string> = {
    "secret.create": "secret:manage_tenant",
    "secret.rotate": "secret:manage_tenant",
    "secret.delete": "secret:manage_tenant",
    "user.create": "user:manage",
    "user.update": "user:manage",
    "user.delete": "user:manage",
    "user.grant": "user:manage",
    "user.revoke": "user:manage",
    "role.create": "role:manage",
    "role.delete": "role:manage",
    "role.set_permissions": "role:manage",
    "idp.create": "idp:manage",
    "idp.update": "idp:manage",
    "idp.delete": "idp:manage",
    "auth_settings.update": "auth:settings"
  };

  async function audit(
    ctx: RouteContext,
    action: string,
    targetType: string,
    targetId: string,
    before: unknown,
    after: unknown
  ): Promise<void> {
    const at = nowIso();
    const tenantId = ctx.principal.tenantId ?? null;
    const actorId = ctx.principal.id ?? null;
    await deps.auditLogs.append({
      actorId,
      tenantId,
      pipelineId: null,
      action,
      targetType,
      targetId,
      beforeRedacted: before === undefined ? undefined : redactValue(before),
      afterRedacted: after === undefined ? undefined : redactValue(after),
      requestId: headerValue(ctx.request.headers, "x-request-id") ?? null,
      sourceIp: headerValue(ctx.request.headers, "x-forwarded-for") ?? null,
      userAgent: headerValue(ctx.request.headers, "user-agent") ?? null,
      createdAt: at
    });
    // Best-effort live broadcast: a transient bus failure must NEVER block a
    // mutation or roll back an audit row. The audit table is the system of
    // record; the bus is the "live UI" channel on top.
    try {
      const requiredPermission = SENSITIVE_ACTIONS[action];
      await changeBus.publish({
        id: randomUUID(),
        action,
        targetType,
        targetId,
        tenantId,
        actorId,
        at,
        ...(requiredPermission ? { requiredPermission } : {}),
        payload:
          after === undefined
            ? undefined
            : { after: redactValue(after) as Record<string, unknown> }
      });
    } catch (e) {
      deps.logger.warn?.("change_bus_publish_failed", {
        action,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  /** Tenant scope from explicit header, falling back to the principal. */
  function tenantScope(ctx: RouteContext): string | undefined {
    return headerValue(ctx.request.headers, "x-tenant-id") ?? ctx.principal.tenantId;
  }

  /**
   * Record which folder a pipeline lives in so a non-empty folder delete
   * raises 409. The InMemory folder repo exposes a `trackPipelineFolder`
   * hook; a Postgres-backed repo derives emptiness from the pipelines table
   * via its own FK so the call is a no-op there.
   */
  function trackFolder(pipelineId: string, folderId: string | null): void {
    const repo = pipelineFolders as unknown as {
      trackPipelineFolder?: (p: string, f: string | null) => void;
    };
    repo.trackPipelineFolder?.(pipelineId, folderId);
  }

  /**
   * Resolve a pipeline `:id` path param that may be EITHER a UUID or a
   * slug/name. The web builder POSTs `/api/pipelines/<slug>/run`, so a route
   * that blindly fed `:id` into a Postgres `uuid` query would throw
   * `invalid input syntax for type uuid` and surface as a 500.
   *
   * Strategy: if the param looks like a UUID, try `pipelines.get` first; if
   * that misses (or the param is not a UUID) fall back to
   * `pipelines.findBySlug`. A non-UUID is never passed to `.get` (which would
   * hit a uuid column). Returns the resolved row, or an `error(404,
   * "pipeline_not_found")` response the caller should return as-is. Callers
   * MUST use the returned `pipeline.id` (the real UUID) for every downstream
   * lookup (versions/deployments/activations).
   */
  async function resolvePipelineRef(
    ref: string
  ): Promise<PipelineRow | AppResponse> {
    let pipeline: PipelineRow | undefined;
    if (isUuid(ref)) {
      pipeline = await deps.pipelines.get(ref);
    }
    if (!pipeline) {
      pipeline = await deps.pipelines.findBySlug(ref);
    }
    if (!pipeline) {
      return error(404, "pipeline_not_found", {
        message: `no pipeline with id or slug '${ref}'`
      });
    }
    return pipeline;
  }

  /** Narrow the union returned by `resolvePipelineRef`. */
  function isAppResponse(v: PipelineRow | AppResponse): v is AppResponse {
    return (
      typeof (v as AppResponse).status === "number" &&
      "headers" in (v as AppResponse)
    );
  }

  /**
   * Shared "resolve a runnable version → enqueue → seed execution" pipeline,
   * called from both the auth'd `POST /api/pipelines/:id/run` and the public
   * `POST /api/triggers/webhook/:token`. Returns an {@link AppResponse} on
   * resolution failure so the caller can return it directly.
   */
  async function enqueuePipelineRun(args: {
    tenantId: string;
    pipeline: PipelineRow;
    environment: string;
    activationLabel?: string;
    input: unknown;
  }): Promise<
    | {
        ok: true;
        executionId: string;
        jobId: string;
        versionId: string;
        version: string;
        resolvedVia: "activation" | "deployment";
        activationLabel?: string;
      }
    | { ok: false; response: AppResponse }
  > {
    const { tenantId, pipeline, environment, activationLabel, input } = args;
    const pipelineId = pipeline.id;
    let resolved: PipelineVersionRow | undefined;
    let resolvedVia: "activation" | "deployment" = "deployment";
    let resolvedLabel: string | undefined;

    const activations = await pipelineActivations.listByTenantPipelineEnv(
      tenantId,
      pipelineId,
      environment
    );
    if (activations.length > 0) {
      resolvedVia = "activation";
      let chosen: PipelineActivationRow;
      try {
        chosen = resolveActivation(activations, activationLabel);
      } catch (e) {
        if (e instanceof ActivationResolutionError) {
          return {
            ok: false,
            response: error(409, "activation_unresolved", { message: e.message })
          };
        }
        throw e;
      }
      let versionId: string;
      try {
        versionId = effectiveVersionId(
          {
            trackLatest: chosen.trackLatest,
            pipelineVersionId: chosen.pipelineVersionId ?? null
          },
          pipeline.latestVersionId ?? null
        );
      } catch (e) {
        if (e instanceof ActivationResolutionError) {
          return {
            ok: false,
            response: error(409, "activation_unresolved", { message: e.message })
          };
        }
        throw e;
      }
      resolvedLabel = chosen.label;
      resolved = await deps.pipelineVersions.get(versionId);
      if (!resolved) {
        return {
          ok: false,
          response: error(409, "activation_unresolved", {
            message: `activation "${chosen.label}" resolves to unknown version ${versionId}`
          })
        };
      }
    } else {
      resolved = await resolveDeployedVersion(
        deps,
        pipelineId,
        environment,
        tenantId
      );
      if (!resolved) {
        return {
          ok: false,
          response: error(409, "no_active_deployment", {
            message: `no active deployment for pipeline ${pipelineId} in ${environment}`
          })
        };
      }
    }

    const validation = validatePipelineSpec(
      resolved.spec as PipelineSpec,
      deps.pluginRegistry
    );
    if (!validation.valid) {
      return {
        ok: false,
        response: error(422, "validation_failed", { issues: validation.errors })
      };
    }

    const executionId = randomUUID();
    const jobId = randomUUID();
    const job: ApiQueueJob<{
      tenantId: string;
      pipelineId: string;
      pipelineVersionId: string;
      environment: string;
      executionId: string;
      input: unknown;
      activationLabel?: string;
    }> = {
      id: jobId,
      type: "run_pipeline",
      // Pipeline runs MUST NOT silently retry: nodes like `delta_filter`
      // persist state on each attempt, so a failed first attempt that wrote
      // state turns retry #2 into a no-op (all docs "unchanged"). One shot;
      // surface failures immediately. Per-node retries inside the
      // DagExecutor remain controlled by WORKER_MAX_RETRIES.
      attempts: 1,
      payload: {
        tenantId,
        pipelineId,
        pipelineVersionId: resolved.id,
        environment,
        executionId,
        input,
        ...(resolvedLabel !== undefined ? { activationLabel: resolvedLabel } : {})
      }
    };
    await deps.queue.enqueue(job as unknown as QueueJob);
    await deps.executionStore.start({
      executionId,
      tenantId,
      pipelineId,
      pipelineVersionId: resolved.id,
      status: "running",
      startedAt: nowIso(),
      input: redactValue(input)
    });

    return {
      ok: true,
      executionId,
      jobId,
      versionId: resolved.id,
      version: resolved.version,
      resolvedVia,
      ...(resolvedLabel !== undefined ? { activationLabel: resolvedLabel } : {})
    };
  }

  // ---- Phase 8: synchronous in-process execution -------------------------
  // The DatasetResolver mirrors what the worker wires up but lives inside
  // the API process so synchronous /invoke runs don't need a worker hop.
  // When any of the three repositories is missing (e.g. legacy harness)
  // we leave the resolver undefined and the executor falls back to
  // plain config.collection / config.index — same v1 path the shim
  // protects.
  const apiDatasetResolver: DatasetResolver | undefined =
    deps.datasets && deps.datasetVersions && deps.datasetAliases
      ? {
          async resolve(args) {
            const ds = await datasets.resolveSlug({
              slug: args.ref.slug,
              tenantId: args.tenantId,
              environmentId: args.environmentId
            });
            if (!ds) return undefined;
            const aliasName = args.ref.alias ?? "stable";
            const aliasRow = await datasetAliases.resolve(ds.id, aliasName);
            const versionId = aliasRow?.versionId ?? ds.currentVersionId;
            if (!versionId) return undefined;
            const ver = await datasetVersions.get(versionId);
            if (!ver) return undefined;
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
              backendCollections: ver.backendCollections
            };
          }
        }
      : undefined;

  /**
   * Run a pipeline version in-process and return its terminal output.
   * Skips the queue entirely — the API pod does the whole DAG execution
   * itself, so chat-style retrieval can return in one HTTP round-trip.
   *
   * Reuses the same DagExecutor the worker uses, including the Phase 5
   * dataset resolver, so v2 plugins behave identically on both paths.
   * Per-node usage records + execution lifecycle events still flow
   * through the shared executionStore + changeBus so observability is
   * uniform.
   */
  /**
   * Max depth for synchronous pipeline_call chains. Pipeline A → B → A
   * deadlocks otherwise; a hard cap of 8 is conservative for real RAG
   * compositions (you'd normally see 2-3 levels: planner → retriever
   * → answer-shaper) and trips fast on accidental cycles.
   */
  const MAX_SYNC_DEPTH = 8;

  async function runSyncPipeline(args: {
    tenantId: string;
    pipeline: PipelineRow;
    versionRow: PipelineVersionRow;
    environment: string;
    input: unknown;
    actorId?: string;
    requestId?: string;
    deadlineMs?: number;
    /** Slugs already on the call stack — propagated by nested invocations. */
    callStack?: string[];
    /** Phase 13 token streaming. When set, the executor passes it to
     *  streaming-capable plugins (provider_chat etc.) which call it
     *  per emitted token. /stream forwards each token as an SSE frame. */
    onToken?: (event: { nodeId: string; token: string }) => void;
  }): Promise<{ executionId: string; output: Record<string, unknown> }> {
    const { tenantId, pipeline, versionRow, environment, input } = args;
    const callStack = args.callStack ?? [];
    if (callStack.length >= MAX_SYNC_DEPTH) {
      throw new Error(
        `pipeline_call depth limit (${MAX_SYNC_DEPTH}) exceeded: ${callStack.join(" → ")} → ${pipeline.slug}`
      );
    }
    if (callStack.includes(pipeline.slug)) {
      throw new Error(
        `pipeline_call cycle detected: ${callStack.join(" → ")} → ${pipeline.slug}`
      );
    }
    // Resolve config (provides ${config.*} template expansion in node
    // configs + secret references through the same precedence the worker
    // uses).
    const definitionRows = await deps.configDefinitions.list();
    const valueRows = await deps.configValues.listConfigValues();
    const resolver = new ConfigResolver(
      definitionRows.map((row) => ({
        key: row.key,
        type: row.type,
        defaultValue: row.defaultValue,
        allowedScopes: row.allowedScopes,
        required: row.required,
        secret: row.secret,
        sensitive: row.sensitive,
        overridable: row.overridable,
        inherited: row.inherited,
        nullable: row.nullable,
        tenantOverridable: row.tenantOverridable,
        runtimeOverridable: row.runtimeOverridable,
        description: row.description ?? undefined
      }))
    );
    const values: ConfigValue[] = valueRows.map((row) => ({
      key: row.key,
      value: row.value,
      scope: row.scope,
      scopeId: row.scopeId ?? undefined,
      locked: row.locked,
      createdBy: row.createdBy ?? undefined,
      createdAt: row.createdAt
    }));
    const resolvedConfig = resolver.resolve(
      {
        pipelineId: pipeline.id,
        pipelineVersionId: versionRow.id,
        tenantId,
        environment,
        values
      },
      { redactSecrets: false }
    );
    const executionId = randomUUID();
    // Phase 9 Round 2: nested sync invocations. The closure captures
    // tenantId + the call stack so cycle detection works across
    // arbitrary depths, and the target pipeline's deployment lookup
    // is done at the moment of the call (so a target redeployed
    // mid-run picks up the new version on the next nested call).
    const runPipelineByRef = async (sub: {
      slug: string;
      input: unknown;
      environment?: string;
    }): Promise<{ output: Record<string, unknown> }> => {
      const target = await deps.pipelines.findBySlug(sub.slug);
      if (!target) {
        throw new Error(`pipeline_call: unknown pipeline slug "${sub.slug}"`);
      }
      const subEnv = sub.environment ?? environment;
      const subVersion = await resolveDeployedVersion(
        deps,
        target.id,
        subEnv,
        tenantId
      );
      if (!subVersion) {
        throw new Error(
          `pipeline_call: pipeline "${sub.slug}" has no active deployment in ${subEnv}`
        );
      }
      const nested = await runSyncPipeline({
        tenantId,
        pipeline: target,
        versionRow: subVersion,
        environment: subEnv,
        input: sub.input,
        actorId: args.actorId,
        requestId: args.requestId,
        callStack: [...callStack, pipeline.slug]
      });
      return { output: nested.output };
    };
    const executor = new DagExecutor({
      pluginRegistry: deps.pluginRegistry,
      secretProvider: deps.secretProvider,
      store: deps.executionStore,
      datasetResolver: apiDatasetResolver,
      runPipelineByRef,
      onToken: args.onToken,
      maxRetries: 1
    });
    const output = await executor.execute({
      spec: versionRow.spec as PipelineSpec,
      context: {
        requestId: args.requestId ?? randomUUID(),
        executionId,
        tenantId,
        pipelineId: pipeline.id,
        pipelineVersionId: versionRow.id,
        environment,
        resolvedConfig,
        actor: args.actorId
          ? { id: args.actorId, type: "user" }
          : undefined,
        deadline: args.deadlineMs ? new Date(args.deadlineMs) : undefined
      },
      input: (isObject(input) ? input : {}) as Record<string, unknown>
    });
    return { executionId, output };
  }

  registerHealthRoutes({ route });

  registerTenantsRoutes({ route }, { deps, audit, environments });

  // ---- pipelines ----------------------------------------------------------
  route("GET", "/api/pipelines", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    return ok({ pipelines: await deps.pipelines.list() });
  });

  route("GET", "/api/pipelines/:id", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const resolved = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(resolved)) return resolved;
    return ok({ pipeline: resolved });
  });

  route("POST", "/api/pipelines", async (ctx) => {
    enforce(ctx.principal, "pipeline:create");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.slug !== "string" || typeof body.name !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "slug|name", message: "slug and name are required strings" }]
      });
    }
    const existing = await deps.pipelines.findBySlug(body.slug);
    if (existing) return error(409, "conflict", { message: "slug already exists" });
    const folderId =
      typeof body.folderId === "string" ? body.folderId : null;
    if (folderId !== null && !(await pipelineFolders.get(folderId))) {
      return error(404, "not_found", { message: "folder not found" });
    }
    const row: PipelineRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      slug: body.slug,
      name: body.name,
      description: typeof body.description === "string" ? body.description : null,
      labels: isObject(body.labels) ? (body.labels as Record<string, string>) : {},
      folderId,
      latestVersionId: null,
      createdBy: ctx.principal.id,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    const created = await deps.pipelines.create(row);
    if (folderId !== null) trackFolder(created.id, folderId);
    await audit(ctx, "pipeline.create", "pipeline", created.id, undefined, created);
    return ok({ pipeline: created }, 201);
  });

  route("PUT", "/api/pipelines/:id", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const before = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(before)) return before;
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<PipelineRow> = { updatedAt: nowIso() };
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.description === "string") patch.description = body.description;
    if (isObject(body.labels)) patch.labels = body.labels as Record<string, string>;
    const updated = await deps.pipelines.update(before.id, patch);
    await audit(ctx, "pipeline.update", "pipeline", updated.id, before, updated);
    return ok({ pipeline: updated });
  });

  route("DELETE", "/api/pipelines/:id", async (ctx) => {
    enforce(ctx.principal, "pipeline:delete");
    const before = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(before)) return before;
    await deps.pipelines.delete(before.id);
    await audit(ctx, "pipeline.delete", "pipeline", before.id, before, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- pipeline folders ---------------------------------------------------
  route("GET", "/api/folders", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    return ok({ folders: await pipelineFolders.tree() });
  });

  route("POST", "/api/folders", async (ctx) => {
    enforce(ctx.principal, "pipeline:create");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.name !== "string" || body.name.length === 0) {
      return error(422, "validation_failed", {
        issues: [{ path: "name", message: "name is required" }]
      });
    }
    const parentId = typeof body.parentId === "string" ? body.parentId : null;
    if (parentId !== null && !(await pipelineFolders.get(parentId))) {
      return error(404, "not_found", { message: "parent folder not found" });
    }
    const row: PipelineFolderRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      parentId,
      name: body.name,
      createdAt: nowIso()
    };
    const created = await pipelineFolders.create(row);
    await audit(ctx, "pipeline_folder.create", "pipeline_folder", created.id, undefined, created);
    return ok({ folder: created }, 201);
  });

  route("PUT", "/api/folders/:id", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const before = await pipelineFolders.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    let updated = before;
    if (typeof body.name === "string" && body.name.length > 0) {
      updated = await pipelineFolders.rename(ctx.params.id, body.name);
    }
    if ("parentId" in body) {
      const parentId =
        typeof body.parentId === "string" ? body.parentId : null;
      if (parentId === ctx.params.id) {
        return error(422, "validation_failed", {
          issues: [{ path: "parentId", message: "folder cannot be its own parent" }]
        });
      }
      if (parentId !== null && !(await pipelineFolders.get(parentId))) {
        return error(404, "not_found", { message: "parent folder not found" });
      }
      updated = await pipelineFolders.update(ctx.params.id, {
        parentId
      } as Partial<PipelineFolderRow>);
    }
    await audit(ctx, "pipeline_folder.update", "pipeline_folder", updated.id, before, updated);
    return ok({ folder: updated });
  });

  route("DELETE", "/api/folders/:id", async (ctx) => {
    enforce(ctx.principal, "pipeline:delete");
    const before = await pipelineFolders.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    // Repo throws ConflictError when the folder still has children/pipelines;
    // the global handler maps that to 409 conflict.
    await pipelineFolders.delete(ctx.params.id);
    await audit(ctx, "pipeline_folder.delete", "pipeline_folder", ctx.params.id, before, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  route("PUT", "/api/pipelines/:id/folder", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const body = ctx.request.body;
    if (!isObject(body) || !("folderId" in body)) {
      return error(422, "validation_failed", {
        issues: [{ path: "folderId", message: "folderId is required (string or null)" }]
      });
    }
    const folderId = typeof body.folderId === "string" ? body.folderId : null;
    if (folderId !== null && !(await pipelineFolders.get(folderId))) {
      return error(404, "not_found", { message: "folder not found" });
    }
    const updated = await deps.pipelines.setFolder(pipeline.id, folderId);
    trackFolder(pipeline.id, folderId);
    await audit(ctx, "pipeline.set_folder", "pipeline", updated.id, pipeline, updated);
    return ok({ pipeline: updated });
  });

  // ---- pipeline spec validation ------------------------------------------
  route("POST", "/api/pipelines/validate", async (ctx) => {
    enforce(ctx.principal, "pipeline:create");
    const spec = parseSpec(ctx.request.body);
    if (!spec) return error(422, "validation_failed", { issues: [{ message: "invalid spec" }] });
    return ok(validatePipelineSpec(spec, deps.pluginRegistry));
  });

  // ---- pipeline versions --------------------------------------------------
  route("GET", "/api/pipelines/:id/versions", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const rows = await deps.pipelineVersions.listByPipeline(pipeline.id);
    const latestId = pipeline.latestVersionId ?? null;
    const versions = rows.map((row) => ({
      ...row,
      parentVersionId: row.parentVersionId ?? null,
      isLatest: row.id === latestId
    }));
    return ok({ versions, latestVersionId: latestId });
  });

  route("POST", "/api/pipelines/:id/versions", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.version !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "version", message: "version is required" }]
      });
    }
    const spec = parseSpec(body.spec);
    if (!spec) {
      return error(422, "validation_failed", {
        issues: [{ path: "spec", message: "spec is missing or invalid" }]
      });
    }
    const validation = validatePipelineSpec(spec, deps.pluginRegistry);
    if (!validation.valid) {
      return error(422, "validation_failed", { issues: validation.errors });
    }
    // Auto-layout specs that arrived without per-node positions (CLI /
    // MCP / hand-written YAML / older seeds). A spec that already has
    // positions on every node is left untouched. See
    // packages/pipeline-spec/src/index.ts → autoLayoutSpec.
    const laidOut = autoLayoutSpec(spec);

    const publish = body.publish === true;
    const existingRows = await deps.pipelineVersions.listByPipeline(pipelineId);
    const existingRecords: PipelineVersionRecord[] = existingRows.map((row) => ({
      pipelineId: row.pipelineId,
      version: row.version,
      status: row.status,
      spec: row.spec as PipelineSpec,
      checksum: row.checksum,
      createdAt: row.createdAt,
      publishedAt: row.publishedAt ?? undefined
    }));

    if (publish) {
      let record: PipelineVersionRecord;
      try {
        record = publishVersion(existingRecords, laidOut, body.version, {
          pipelineId
        });
      } catch (e) {
        if (e instanceof ImmutableVersionError) {
          return error(409, "immutable_version", { message: e.message });
        }
        throw e;
      }
      const priorRow = existingRows.find(
        (row) => row.version === body.version && row.status === "published"
      );
      if (priorRow) {
        // Idempotent republish of identical content.
        return ok({ version: priorRow }, 200);
      }
      const versionRow: PipelineVersionRow = {
        id: randomUUID(),
        pipelineId,
        version: record.version,
        status: "published",
        spec: record.spec,
        checksum: record.checksum,
        createdBy: ctx.principal.id,
        createdAt: record.createdAt,
        publishedAt: record.publishedAt ?? nowIso()
      };
      const created = await deps.pipelineVersions.create(versionRow);
      await audit(ctx, "pipeline_version.publish", "pipeline_version", created.id, undefined, {
        version: created.version,
        checksum: created.checksum
      });
      return ok({ version: created }, 201);
    }

    // Draft save (mutable). Overwrite an existing draft with the same version.
    const existingDraft = existingRows.find(
      (row) => row.version === body.version && row.status === "draft"
    );
    if (existingDraft) {
      const updated = await deps.pipelineVersions.update(existingDraft.id, {
        spec: laidOut,
        checksum: specChecksum(laidOut)
      });
      await audit(ctx, "pipeline_version.save_draft", "pipeline_version", updated.id, existingDraft, {
        version: updated.version
      });
      return ok({ version: updated }, 200);
    }
    const blockingPublished = existingRows.find(
      (row) => row.version === body.version && row.status === "published"
    );
    if (blockingPublished) {
      return error(409, "immutable_version", {
        message: `version ${body.version} is already published`
      });
    }
    const draftRow: PipelineVersionRow = {
      id: randomUUID(),
      pipelineId,
      version: body.version,
      status: "draft",
      spec: laidOut,
      checksum: specChecksum(laidOut),
      createdBy: ctx.principal.id,
      createdAt: nowIso(),
      publishedAt: null
    };
    const created = await deps.pipelineVersions.create(draftRow);
    await audit(ctx, "pipeline_version.save_draft", "pipeline_version", created.id, undefined, {
      version: created.version
    });
    return ok({ version: created }, 201);
  });

  // ---- save (auto-version) + rollback ------------------------------------
  route("POST", "/api/pipelines/:id/save", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    const body = ctx.request.body;
    if (!isObject(body)) {
      return error(422, "validation_failed", { issues: [{ message: "body required" }] });
    }
    const spec = parseSpec(body.spec);
    if (!spec) {
      return error(422, "validation_failed", {
        issues: [{ path: "spec", message: "spec is missing or invalid" }]
      });
    }
    const validation = validatePipelineSpec(spec, deps.pluginRegistry);
    if (!validation.valid) {
      return error(422, "validation_failed", { issues: validation.errors });
    }
    // Auto-layout (LR) when positions are missing so a save from the
    // CLI, MCP, or a hand-written YAML lands in storage with positions
    // already baked in. A spec that already carries positions on every
    // node is left untouched, so a Builder save preserves the user's
    // arrangement.
    const laidOutSave = autoLayoutSpec(spec);
    const level =
      body.level === "minor" || body.level === "major" || body.level === "patch"
        ? (body.level as "patch" | "minor" | "major")
        : "patch";

    const rows = await deps.pipelineVersions.listByPipeline(pipelineId);
    const toRecord = (row: PipelineVersionRow): PipelineVersionRecord => ({
      id: row.id,
      pipelineId: row.pipelineId,
      version: row.version,
      status: row.status,
      spec: row.spec as PipelineSpec,
      checksum: row.checksum,
      parentVersionId: row.parentVersionId ?? null,
      createdAt: row.createdAt,
      publishedAt: row.publishedAt ?? undefined
    });
    const existingVersions = rows.map(toRecord);
    const latestRow = pipeline.latestVersionId
      ? rows.find((row) => row.id === pipeline.latestVersionId)
      : undefined;

    const result = nextVersionOnSave({
      existingVersions,
      latest: latestRow ? toRecord(latestRow) : undefined,
      spec: laidOutSave,
      level,
      pipelineId
    });

    if (result.kind === "idempotent") {
      // Identical spec as the current latest: no new row, pointer unchanged.
      const unchanged = rows.find((row) => row.id === result.version.id);
      return ok({ version: unchanged, created: false });
    }

    const versionRow: PipelineVersionRow = {
      id: randomUUID(),
      pipelineId,
      version: result.record.version,
      status: "published",
      spec: result.record.spec,
      checksum: result.record.checksum,
      parentVersionId: result.record.parentVersionId ?? null,
      createdBy: ctx.principal.id,
      createdAt: result.record.createdAt,
      publishedAt: result.record.publishedAt ?? nowIso()
    };
    const created = await deps.pipelineVersions.create(versionRow);
    const updatedPipeline = await deps.pipelines.setLatestVersion(
      pipelineId,
      created.id
    );
    await audit(ctx, "pipeline_version.save", "pipeline_version", created.id, undefined, {
      version: created.version,
      checksum: created.checksum,
      parentVersionId: created.parentVersionId,
      latestVersionId: updatedPipeline.latestVersionId
    });
    return ok({ version: created, created: true }, 201);
  });

  route("POST", "/api/pipelines/:id/rollback", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.versionId !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "versionId", message: "versionId is required" }]
      });
    }
    const rows = await deps.pipelineVersions.listByPipeline(pipelineId);
    let targetId: string;
    try {
      targetId = rollbackPointer(
        rows.map((row) => ({
          id: row.id,
          pipelineId: row.pipelineId,
          version: row.version,
          status: row.status,
          spec: row.spec as PipelineSpec,
          checksum: row.checksum,
          createdAt: row.createdAt
        })),
        body.versionId
      );
    } catch (e) {
      if (e instanceof VersionNotFoundError) {
        return error(404, "not_found", { message: e.message });
      }
      throw e;
    }
    const updated = await deps.pipelines.setLatestVersion(pipelineId, targetId);
    await audit(ctx, "pipeline_version.rollback", "pipeline", pipelineId, pipeline, {
      latestVersionId: updated.latestVersionId
    });
    return ok({ pipeline: updated, latestVersionId: updated.latestVersionId });
  });

  route("POST", "/api/pipelines/:id/versions/:version/archive", async (ctx) => {
    enforce(ctx.principal, "pipeline:update");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const found = await deps.pipelineVersions.findByVersion(pipeline.id, ctx.params.version);
    if (!found) return error(404, "not_found");
    const archived = archiveVersion({
      pipelineId: found.pipelineId,
      version: found.version,
      status: found.status,
      spec: found.spec as PipelineSpec,
      checksum: found.checksum,
      createdAt: found.createdAt,
      publishedAt: found.publishedAt ?? undefined
    });
    const updated = await deps.pipelineVersions.update(found.id, { status: archived.status });
    await audit(ctx, "pipeline_version.archive", "pipeline_version", updated.id, found, updated);
    return ok({ version: updated });
  });

  route("GET", "/api/pipelines/:id/versions/:version/export", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const found = await deps.pipelineVersions.findByVersion(pipeline.id, ctx.params.version);
    if (!found) return error(404, "not_found");
    const format = ctx.request.query.format === "yaml" ? "yaml" : "json";
    const text = exportSpec(found.spec as PipelineSpec, format);
    return {
      status: 200,
      body: text,
      headers: { "content-type": format === "yaml" ? "application/yaml" : "application/json" }
    };
  });

  // ---- deployments --------------------------------------------------------
  route("GET", "/api/pipelines/:id/deployments", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    return ok({ deployments: await deps.deployments.listByPipeline(pipeline.id) });
  });

  route("POST", "/api/pipelines/:id/deployments", async (ctx) => {
    enforce(ctx.principal, "pipeline:deploy");
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.version !== "string" ||
      typeof body.environment !== "string"
    ) {
      return error(422, "validation_failed", {
        issues: [{ message: "version and environment are required" }]
      });
    }
    const version = await deps.pipelineVersions.findByVersion(pipelineId, body.version);
    if (!version) return error(404, "not_found", { message: "pipeline version not found" });
    if (version.status !== "published") {
      return error(422, "validation_failed", {
        issues: [{ message: "only published versions can be deployed" }]
      });
    }
    const deploymentRow: PipelineDeploymentRow = {
      id: randomUUID(),
      pipelineId,
      pipelineVersionId: version.id,
      environment: body.environment,
      tenantId: typeof body.tenantId === "string" ? body.tenantId : null,
      status: "active",
      deployedBy: ctx.principal.id,
      deployedAt: nowIso()
    };
    // Upsert keyed on (pipeline_id, environment, tenant_id) — the unique
    // index. Re-deploying the same pipeline to the same env/tenant must
    // swap the active version in place; a plain INSERT here would always
    // 409 on the second deploy.
    const saved = await deps.deployments.upsertActive(deploymentRow);
    await audit(ctx, "pipeline.deploy", "pipeline_deployment", saved.id, undefined, saved);
    return ok({ deployment: saved }, 201);
  });

  // ---- tenant <-> pipeline associations + activations ---------------------
  function activationEnv(ctx: RouteContext, body: unknown): string {
    if (isObject(body) && typeof body.environment === "string" && body.environment) {
      return body.environment;
    }
    return ctx.request.query.environment ?? "dev";
  }

  function projectActivation(
    row: PipelineActivationRow,
    pipelineLatestVersionId: string | null
  ): Record<string, unknown> {
    let effective: string | null = null;
    try {
      effective = effectiveVersionId(
        { trackLatest: row.trackLatest, pipelineVersionId: row.pipelineVersionId ?? null },
        pipelineLatestVersionId
      );
    } catch {
      effective = null;
    }
    return {
      id: row.id,
      label: row.label,
      environment: row.environment,
      pipelineVersionId: row.pipelineVersionId ?? null,
      trackLatest: row.trackLatest,
      enabled: row.enabled,
      effectiveVersionId: effective
    };
  }

  route("GET", "/api/tenants/:id/pipelines", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs", { tenantId: ctx.params.id });
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId &&
      ctx.principal.tenantId !== ctx.params.id
    ) {
      return error(403, "forbidden");
    }
    const associations = await tenantPipelines.listByTenant(ctx.params.id);
    const activations = await pipelineActivations.listByTenant(ctx.params.id);
    // Activations are bucketed by (pipelineId, environment) so a row that
    // represents the "dev" association only carries the dev activations,
    // not every activation across every env for that pipeline. The
    // composite key matches the tenant_pipelines composite PK.
    const byPipelineEnv = new Map<string, PipelineActivationRow[]>();
    const envKey = (pipelineId: string, environment: string): string =>
      `${pipelineId}::${environment}`;
    for (const act of activations) {
      const k = envKey(act.pipelineId, act.environment);
      const bucket = byPipelineEnv.get(k) ?? [];
      bucket.push(act);
      byPipelineEnv.set(k, bucket);
    }
    // Build the union of (pipelineId, environment) pairs across both
    // associations and activations so an activation-only env still surfaces.
    const seen = new Set<string>();
    const pairs: Array<{ pipelineId: string; environment: string }> = [];
    for (const a of associations) {
      const k = envKey(a.pipelineId, a.environment);
      if (!seen.has(k)) {
        seen.add(k);
        pairs.push({ pipelineId: a.pipelineId, environment: a.environment });
      }
    }
    for (const a of activations) {
      const k = envKey(a.pipelineId, a.environment);
      if (!seen.has(k)) {
        seen.add(k);
        pairs.push({ pipelineId: a.pipelineId, environment: a.environment });
      }
    }
    const out: Array<Record<string, unknown>> = [];
    for (const { pipelineId, environment } of pairs) {
      const pipeline = await deps.pipelines.get(pipelineId);
      const assoc = associations.find(
        (a) => a.pipelineId === pipelineId && a.environment === environment
      );
      out.push({
        pipelineId,
        environment,
        enabled: assoc ? assoc.enabled : false,
        activations: (byPipelineEnv.get(envKey(pipelineId, environment)) ?? []).map((row) =>
          projectActivation(row, pipeline?.latestVersionId ?? null)
        )
      });
    }
    return ok({ pipelines: out });
  });

  route("POST", "/api/tenants/:id/pipelines", async (ctx) => {
    enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.pipelineId !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "pipelineId", message: "pipelineId is required" }]
      });
    }
    const pipeline = await deps.pipelines.get(body.pipelineId);
    if (!pipeline) return error(404, "not_found", { message: "pipeline not found" });
    const environment =
      typeof body.environment === "string" && body.environment
        ? body.environment
        : "dev";
    const row: TenantPipelineRow = {
      tenantId: ctx.params.id,
      pipelineId: body.pipelineId,
      environment,
      enabled: true,
      vectorIsolation: isObject(body.vectorIsolation) ? body.vectorIsolation : {},
      providerPolicy: isObject(body.providerPolicy) ? body.providerPolicy : {},
      rateLimitPolicy: isObject(body.rateLimitPolicy) ? body.rateLimitPolicy : {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    const saved = await tenantPipelines.upsert(row);
    await audit(ctx, "tenant_pipeline.associate", "tenant_pipeline", `${ctx.params.id}:${body.pipelineId}`, undefined, saved);
    return ok({ association: saved }, 201);
  });

  route("PATCH", "/api/tenants/:id/pipelines/:pid", async (ctx) => {
    enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.enabled !== "boolean") {
      return error(422, "validation_failed", {
        issues: [{ path: "enabled", message: "enabled (boolean) is required" }]
      });
    }
    const environment =
      typeof body.environment === "string" && body.environment
        ? body.environment
        : "dev";
    const existing = await tenantPipelines.get({
      tenantId: ctx.params.id,
      pipelineId: ctx.params.pid,
      environment
    });
    if (!existing) return error(404, "not_found", { message: "association not found" });
    const saved = await tenantPipelines.upsert({
      ...existing,
      enabled: body.enabled,
      updatedAt: nowIso()
    });
    await audit(ctx, "tenant_pipeline.update", "tenant_pipeline", `${ctx.params.id}:${ctx.params.pid}`, existing, saved);
    return ok({ association: saved });
  });

  route("GET", "/api/tenants/:id/pipelines/:pid/activations", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs", { tenantId: ctx.params.id });
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId &&
      ctx.principal.tenantId !== ctx.params.id
    ) {
      return error(403, "forbidden");
    }
    const pipeline = await resolvePipelineRef(ctx.params.pid);
    if (isAppResponse(pipeline)) return pipeline;
    const rows = (
      await pipelineActivations.listByTenant(ctx.params.id)
    ).filter((row) => row.pipelineId === pipeline.id);
    return ok({
      activations: rows.map((row) =>
        projectActivation(row, pipeline.latestVersionId ?? null)
      )
    });
  });

  route("POST", "/api/tenants/:id/pipelines/:pid/activations", async (ctx) => {
    enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
    const pipeline = await resolvePipelineRef(ctx.params.pid);
    if (isAppResponse(pipeline)) return pipeline;
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.label !== "string" ||
      body.label.length === 0 ||
      typeof body.environment !== "string" ||
      body.environment.length === 0
    ) {
      return error(422, "validation_failed", {
        issues: [{ message: "label and environment are required" }]
      });
    }
    const trackLatest = body.trackLatest === true;
    if (
      !trackLatest &&
      (typeof body.pipelineVersionId !== "string" || body.pipelineVersionId.length === 0)
    ) {
      return error(422, "validation_failed", {
        issues: [
          { message: "a pinned activation requires pipelineVersionId or trackLatest:true" }
        ]
      });
    }
    const row: PipelineActivationRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      tenantId: ctx.params.id,
      pipelineId: pipeline.id,
      environment: body.environment,
      label: body.label,
      pipelineVersionId:
        typeof body.pipelineVersionId === "string" ? body.pipelineVersionId : null,
      trackLatest,
      enabled: body.enabled !== false,
      createdAt: nowIso()
    };
    // Repo throws ConflictError on a duplicate (tenant,pipeline,env,label);
    // the global handler maps it to 409 conflict.
    const created = await pipelineActivations.create(row);
    await audit(ctx, "pipeline_activation.create", "pipeline_activation", created.id, undefined, created);
    return ok(
      { activation: projectActivation(created, pipeline.latestVersionId ?? null) },
      201
    );
  });

  route(
    "PATCH",
    "/api/tenants/:id/pipelines/:pid/activations/:aid",
    async (ctx) => {
      enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
      const pipeline = await resolvePipelineRef(ctx.params.pid);
      if (isAppResponse(pipeline)) return pipeline;
      const before = await pipelineActivations.get(ctx.params.aid);
      if (
        !before ||
        before.tenantId !== ctx.params.id ||
        before.pipelineId !== pipeline.id
      ) {
        return error(404, "not_found");
      }
      const body = ctx.request.body;
      if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
      const patch: Partial<PipelineActivationRow> = {};
      if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
      if (typeof body.trackLatest === "boolean") patch.trackLatest = body.trackLatest;
      if (typeof body.label === "string" && body.label.length > 0) {
        patch.label = body.label;
      }
      if ("pipelineVersionId" in body) {
        patch.pipelineVersionId =
          typeof body.pipelineVersionId === "string"
            ? body.pipelineVersionId
            : null;
      }
      const updated = await pipelineActivations.update(ctx.params.aid, patch);
      await audit(ctx, "pipeline_activation.update", "pipeline_activation", updated.id, before, updated);
      return ok({
        activation: projectActivation(updated, pipeline.latestVersionId ?? null)
      });
    }
  );

  route(
    "DELETE",
    "/api/tenants/:id/pipelines/:pid/activations/:aid",
    async (ctx) => {
      enforce(ctx.principal, "config:edit_tenant", { tenantId: ctx.params.id });
      const pipeline = await resolvePipelineRef(ctx.params.pid);
      if (isAppResponse(pipeline)) return pipeline;
      const before = await pipelineActivations.get(ctx.params.aid);
      if (
        !before ||
        before.tenantId !== ctx.params.id ||
        before.pipelineId !== pipeline.id
      ) {
        return error(404, "not_found");
      }
      await pipelineActivations.delete(ctx.params.aid);
      await audit(ctx, "pipeline_activation.delete", "pipeline_activation", ctx.params.aid, before, undefined);
      return { status: 204, body: undefined, headers: {} };
    }
  );

  // ---- schedules ----------------------------------------------------------
  function scheduleNextRun(
    cron: string,
    timezone?: string
  ): { ok: true; next: string } | { ok: false; message: string } {
    try {
      parseCron(cron, timezone);
    } catch (e) {
      if (e instanceof CronParseError) {
        return { ok: false, message: e.message };
      }
      throw e;
    }
    return {
      ok: true,
      next: nextAfter(cron, new Date(), timezone).toISOString()
    };
  }

  route("GET", "/api/schedules", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    let rows = await schedules.list();
    const tenant = ctx.request.query.tenant;
    const pipeline = ctx.request.query.pipeline;
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId
    ) {
      rows = rows.filter((row) => row.tenantId === ctx.principal.tenantId);
    }
    if (tenant) rows = rows.filter((row) => row.tenantId === tenant);
    if (pipeline) rows = rows.filter((row) => row.pipelineId === pipeline);
    return ok({ schedules: rows });
  });

  route("POST", "/api/schedules", async (ctx) => {
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.tenantId !== "string" ||
      typeof body.pipelineId !== "string" ||
      typeof body.environment !== "string" ||
      typeof body.cron !== "string"
    ) {
      return error(422, "validation_failed", {
        issues: [
          { message: "tenantId, pipelineId, environment and cron are required" }
        ]
      });
    }
    enforce(ctx.principal, "config:edit_tenant", { tenantId: body.tenantId });
    const tz = typeof body.timezone === "string" ? body.timezone : "UTC";
    const next = scheduleNextRun(body.cron, tz);
    if (!next.ok) {
      return error(422, "validation_failed", {
        issues: [{ path: "cron", message: next.message }]
      });
    }
    const row: ScheduleRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      tenantId: body.tenantId,
      pipelineId: body.pipelineId,
      environment: body.environment,
      activationLabel:
        typeof body.activationLabel === "string" ? body.activationLabel : null,
      cron: body.cron,
      timezone: tz,
      input: isObject(body.input) ? body.input : {},
      enabled: body.enabled !== false,
      lastRunAt: null,
      nextRunAt: next.next,
      createdAt: nowIso()
    };
    const created = await schedules.create(row);
    await audit(ctx, "schedule.create", "schedule", created.id, undefined, created);
    return ok({ schedule: created }, 201);
  });

  route("PUT", "/api/schedules/:id", async (ctx) => {
    const before = await schedules.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    // System schedules (un-deletable platform sweepers) bypass the
    // tenant-scoped grant check — they're platform-wide config. Only
    // global config admins (config:edit_global) can edit cadence.
    if (before.system) {
      enforce(ctx.principal, "config:edit_global", {});
    } else {
      enforce(ctx.principal, "config:edit_tenant", {
        tenantId: before.tenantId ?? undefined
      });
    }
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<ScheduleRow> = {};
    if (typeof body.environment === "string") patch.environment = body.environment;
    if ("activationLabel" in body) {
      patch.activationLabel =
        typeof body.activationLabel === "string" ? body.activationLabel : null;
    }
    if (typeof body.timezone === "string") patch.timezone = body.timezone;
    if (isObject(body.input)) patch.input = body.input;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.cron === "string") {
      // Honour the (possibly updated) timezone when recomputing nextRunAt.
      const tz = patch.timezone ?? before.timezone;
      const next = scheduleNextRun(body.cron, tz);
      if (!next.ok) {
        return error(422, "validation_failed", {
          issues: [{ path: "cron", message: next.message }]
        });
      }
      patch.cron = body.cron;
      patch.nextRunAt = next.next;
    }
    const updated = await schedules.update(ctx.params.id, patch);
    await audit(ctx, "schedule.update", "schedule", updated.id, before, updated);
    return ok({ schedule: updated });
  });

  route("PATCH", "/api/schedules/:id", async (ctx) => {
    const before = await schedules.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    if (before.system) {
      enforce(ctx.principal, "config:edit_global", {});
    } else {
      enforce(ctx.principal, "config:edit_tenant", {
        tenantId: before.tenantId ?? undefined
      });
    }
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.enabled !== "boolean") {
      return error(422, "validation_failed", {
        issues: [{ path: "enabled", message: "enabled (boolean) is required" }]
      });
    }
    const updated = await schedules.update(ctx.params.id, { enabled: body.enabled });
    await audit(ctx, "schedule.toggle", "schedule", updated.id, before, updated);
    return ok({ schedule: updated });
  });

  route("DELETE", "/api/schedules/:id", async (ctx) => {
    const before = await schedules.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    // System schedules are un-deletable — the worker can't run without
    // its stale-exec / retention sweepers, and re-creating the row would
    // lose the operator-tuned cadence.
    if (before.system) {
      return error(403, "system_schedule_undeletable", {
        message:
          "System schedules cannot be deleted. Disable or edit the cadence instead."
      });
    }
    enforce(ctx.principal, "config:edit_tenant", {
      tenantId: before.tenantId ?? undefined
    });
    await schedules.delete(ctx.params.id);
    await audit(ctx, "schedule.delete", "schedule", ctx.params.id, before, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- config definitions -------------------------------------------------
  route("GET", "/api/config/definitions", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    return ok({ definitions: await deps.configDefinitions.list() });
  });

  route("PUT", "/api/config/definitions/:key", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.type !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "type", message: "type is required" }]
      });
    }
    const before = await deps.configDefinitions.get(ctx.params.key);
    const row: ConfigDefinitionRow = {
      key: ctx.params.key,
      type: body.type as ConfigDefinitionRow["type"],
      defaultValue: body.defaultValue,
      allowedScopes: Array.isArray(body.allowedScopes)
        ? (body.allowedScopes as ConfigDefinitionRow["allowedScopes"])
        : ["global"],
      required: body.required === true,
      secret: body.secret === true,
      sensitive: body.sensitive === true,
      overridable: body.overridable !== false,
      inherited: body.inherited !== false,
      nullable: body.nullable === true,
      tenantOverridable: body.tenantOverridable === true,
      runtimeOverridable: body.runtimeOverridable === true,
      validation: isObject(body.validation) ? body.validation : {},
      description: typeof body.description === "string" ? body.description : null
    };
    const saved = await deps.configDefinitions.upsert(row);
    await audit(ctx, "config_definition.upsert", "config_definition", saved.key, before, saved);
    return ok({ definition: saved }, before ? 200 : 201);
  });

  route("DELETE", "/api/config/definitions/:key", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const before = await deps.configDefinitions.get(ctx.params.key);
    if (!before) return error(404, "not_found");
    await deps.configDefinitions.delete(ctx.params.key);
    await audit(ctx, "config_definition.delete", "config_definition", ctx.params.key, before, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- config values ------------------------------------------------------
  route("GET", "/api/config/values", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const values = await deps.configValues.listConfigValues({
      key: ctx.request.query.key,
      scope: ctx.request.query.scope as ConfigValueRow["scope"] | undefined,
      // Accept both snake_case (scope_id) and camelCase (scopeId) so the web
      // can build a global -> tenant -> pipeline tree with either convention.
      scopeId: ctx.request.query.scope_id ?? ctx.request.query.scopeId
    });
    // Redact sensitive-looking values defensively.
    return ok({
      values: values.map((value) => ({ ...value, value: redactValue(value.value) }))
    });
  });

  route("POST", "/api/config/values", async (ctx) => {
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.key !== "string" || typeof body.scope !== "string") {
      return error(422, "validation_failed", {
        issues: [{ message: "key and scope are required" }]
      });
    }
    // Pick the permission appropriate to the scope being written.
    const scope = body.scope as ConfigValueRow["scope"];
    const permission: Permission =
      scope === "tenant" || scope === "tenant_pipeline"
        ? "config:edit_tenant"
        : scope === "global" || scope === "environment"
          ? "config:edit_global"
          : "config:edit_pipeline";
    enforce(ctx.principal, permission, {
      tenantId:
        scope === "tenant" ? (body.scopeId as string | undefined) : ctx.principal.tenantId
    });
    const saved = await deps.configValues.upsert({
      key: body.key,
      value: body.value,
      scope,
      scopeId: typeof body.scopeId === "string" ? body.scopeId : null,
      locked: body.locked === true,
      createdBy: ctx.principal.id
    });
    await audit(ctx, "config_value.upsert", "config_value", saved.id, undefined, {
      key: saved.key,
      scope: saved.scope,
      scopeId: saved.scopeId,
      value: redactValue(saved.value)
    });
    return ok({ value: { ...saved, value: redactValue(saved.value) } }, 201);
  });

  route("DELETE", "/api/config/values/:id", async (ctx) => {
    enforce(ctx.principal, "config:edit_pipeline");
    const existing = await deps.configValues.get(ctx.params.id);
    if (!existing) return error(404, "not_found");
    await deps.configValues.delete(ctx.params.id);
    await audit(ctx, "config_value.delete", "config_value", ctx.params.id, existing, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- resolved config ----------------------------------------------------
  route("GET", "/api/config/resolved", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const pipelineId = ctx.request.query.pipeline_id;
    const tenantId = ctx.request.query.tenant_id;
    const environment = ctx.request.query.environment;
    if (!pipelineId || !tenantId || !environment) {
      return error(422, "validation_failed", {
        issues: [{ message: "pipeline_id, tenant_id, environment are required" }]
      });
    }
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId &&
      ctx.principal.tenantId !== tenantId
    ) {
      return error(403, "forbidden");
    }
    const definitionRows = await deps.configDefinitions.list();
    const definitions: ConfigDefinition[] = definitionRows.map((row) => ({
      key: row.key,
      type: row.type,
      defaultValue: row.defaultValue,
      allowedScopes: row.allowedScopes,
      required: row.required,
      secret: row.secret,
      sensitive: row.sensitive,
      overridable: row.overridable,
      inherited: row.inherited,
      nullable: row.nullable,
      tenantOverridable: row.tenantOverridable,
      runtimeOverridable: row.runtimeOverridable,
      description: row.description ?? undefined
    }));
    const valueRows = await deps.configValues.listConfigValues();
    const values: ConfigValue[] = valueRows.map((row) => ({
      key: row.key,
      value: row.value,
      scope: row.scope,
      scopeId: row.scopeId ?? undefined,
      locked: row.locked
    }));
    const resolver = new ConfigResolver(definitions);
    const resolved = resolver.resolve(
      { pipelineId, tenantId, environment, values },
      { redactSecrets: true }
    );
    return ok(resolved);
  });

  // ---- datasets -----------------------------------------------------------
  // Phase 4 of the dataset/RBAC/retrieval refactor. Datasets are the
  // first-class corpus a pipeline reads from / writes into; they decouple
  // ingestion from retrieval (multiple pipelines can share one dataset)
  // and the platform owns the physical collection naming. This commit
  // ships the metadata + lifecycle; the plugin contract switch to "go
  // through the dataset" is Phase 5.

  function datasetScopeResource(row: {
    scope: DatasetRow["scope"];
    tenantId?: string | null;
    environmentId?: string | null;
  }): { tenantId?: string; environment?: string } {
    if (row.scope === "tenant") return { tenantId: row.tenantId ?? undefined };
    if (row.scope === "environment") {
      return {
        tenantId: row.tenantId ?? undefined,
        environment: row.environmentId ?? undefined
      };
    }
    return {}; // global -> *
  }

  function publicDataset(row: DatasetRow): Record<string, unknown> {
    return {
      id: row.id,
      scope: row.scope,
      tenantId: row.tenantId ?? null,
      environmentId: row.environmentId ?? null,
      slug: row.slug,
      displayName: row.displayName,
      description: row.description ?? null,
      embeddingProfile: row.embeddingProfile,
      chunkSchema: row.chunkSchema,
      modalities: row.modalities,
      backends: row.backends,
      currentVersionId: row.currentVersionId ?? null,
      archivedAt: row.archivedAt ?? null,
      createdAt: row.createdAt,
      createdBy: row.createdBy ?? null,
      updatedAt: row.updatedAt
    };
  }

  function publicDatasetVersion(row: DatasetVersionRow): Record<string, unknown> {
    return {
      id: row.id,
      datasetId: row.datasetId,
      versionLabel: row.versionLabel,
      schemaSpec: row.schemaSpec,
      backendCollections: row.backendCollections,
      status: row.status,
      docCount: row.docCount,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
      readyAt: row.readyAt ?? null
    };
  }

  function publicDatasetAlias(row: DatasetAliasRow): Record<string, unknown> {
    return {
      id: row.id,
      datasetId: row.datasetId,
      alias: row.alias,
      versionId: row.versionId,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy ?? null
    };
  }

  route("GET", "/api/datasets", async (ctx) => {
    // Anyone with dataset:read at SOME scope can list; the response is
    // filtered to what they can actually see (tenant-coarse — Phase 4
    // doesn't yet model "dataset granted to a specific user" beyond the
    // existing tenant/env scoping, so listing everything in-scope and
    // letting RBAC reject individual gets is the right trade-off).
    enforce(ctx.principal, "dataset:read");
    const headerTenant = tenantScope(ctx);
    const headerEnv = headerValue(ctx.request.headers, "x-environment");
    const rows = await datasets.listVisibleAt({
      tenantId: headerTenant ?? undefined,
      environmentId: headerEnv ?? undefined
    });
    return ok({ datasets: rows.map(publicDataset) });
  });

  route("GET", "/api/datasets/:id", async (ctx) => {
    const row = await datasets.get(ctx.params.id);
    if (!row) return error(404, "not_found", { message: "dataset not found" });
    enforce(ctx.principal, "dataset:read", datasetScopeResource(row));
    return ok({ dataset: publicDataset(row) });
  });

  route("POST", "/api/datasets", async (ctx) => {
    const body = ctx.request.body;
    if (!isObject(body)) {
      return error(422, "validation_failed", { issues: [{ message: "body required" }] });
    }
    const scope = body.scope as DatasetRow["scope"];
    if (scope !== "global" && scope !== "tenant" && scope !== "environment") {
      return error(422, "validation_failed", {
        issues: [{ path: "scope", message: "scope must be global | tenant | environment" }]
      });
    }
    if (typeof body.slug !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(body.slug)) {
      return error(422, "validation_failed", {
        issues: [{ path: "slug", message: "slug must be lowercase alphanumeric + _- (1..63 chars)" }]
      });
    }
    if (typeof body.displayName !== "string" || !body.displayName.trim()) {
      return error(422, "validation_failed", {
        issues: [{ path: "displayName", message: "displayName required" }]
      });
    }
    const tenantId =
      typeof body.tenantId === "string" && body.tenantId ? body.tenantId : undefined;
    const environmentId =
      typeof body.environmentId === "string" && body.environmentId
        ? body.environmentId
        : undefined;
    if (scope === "global" && (tenantId || environmentId)) {
      return error(422, "validation_failed", {
        issues: [{ message: "global datasets cannot carry a tenantId or environmentId" }]
      });
    }
    if (scope === "tenant" && (!tenantId || environmentId)) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant datasets require tenantId and no environmentId" }]
      });
    }
    if (scope === "environment" && (!tenantId || !environmentId)) {
      return error(422, "validation_failed", {
        issues: [{ message: "environment datasets require both tenantId and environmentId" }]
      });
    }
    if (tenantId) {
      const t = await deps.tenants.get(tenantId);
      if (!t) {
        return error(422, "validation_failed", {
          issues: [{ path: "tenantId", message: "unknown tenant" }]
        });
      }
    }
    if (environmentId && tenantId) {
      const envs = await environments.listByTenant(tenantId);
      if (!envs.find((e) => e.name === environmentId)) {
        return error(422, "validation_failed", {
          issues: [{ path: "environmentId", message: `unknown environment: ${environmentId}` }]
        });
      }
    }
    // The creator needs dataset:admin at the target scope to create.
    enforce(ctx.principal, "dataset:admin", { tenantId, environment: environmentId });

    const now = nowIso();
    const created = await datasets.create({
      id: randomUUID(),
      scope,
      tenantId,
      environmentId,
      slug: body.slug,
      displayName: body.displayName.trim(),
      description: typeof body.description === "string" ? body.description : null,
      embeddingProfile: isObject(body.embeddingProfile) ? body.embeddingProfile : {},
      chunkSchema: isObject(body.chunkSchema) ? body.chunkSchema : {},
      modalities: Array.isArray(body.modalities) && body.modalities.length > 0
        ? (body.modalities.filter((m) => typeof m === "string") as string[])
        : ["vector"],
      backends: isObject(body.backends) ? body.backends : {},
      currentVersionId: null,
      archivedAt: null,
      createdAt: now,
      createdBy: ctx.principal.id,
      updatedAt: now
    });
    await audit(ctx, "dataset.create", "dataset", created.id, undefined, publicDataset(created));
    return ok({ dataset: publicDataset(created) }, 201);
  });

  route("PATCH", "/api/datasets/:id", async (ctx) => {
    const before = await datasets.get(ctx.params.id);
    if (!before) return error(404, "not_found", { message: "dataset not found" });
    enforce(ctx.principal, "dataset:admin", datasetScopeResource(before));
    const body = ctx.request.body;
    if (!isObject(body)) {
      return error(422, "validation_failed", { issues: [{ message: "body required" }] });
    }
    const patch: Partial<DatasetRow> = {};
    if (typeof body.displayName === "string") patch.displayName = body.displayName.trim();
    if (typeof body.description === "string" || body.description === null) {
      patch.description = body.description as string | null;
    }
    if (isObject(body.chunkSchema)) patch.chunkSchema = body.chunkSchema;
    if (isObject(body.embeddingProfile)) patch.embeddingProfile = body.embeddingProfile;
    if (isObject(body.backends)) patch.backends = body.backends;
    if (Array.isArray(body.modalities) && body.modalities.length > 0) {
      patch.modalities = body.modalities.filter((m) => typeof m === "string") as string[];
    }
    if (body.archived === true) patch.archivedAt = nowIso();
    if (body.archived === false) patch.archivedAt = null;
    patch.updatedAt = nowIso();
    const updated = await datasets.update(before.id, patch);
    await audit(ctx, "dataset.update", "dataset", updated.id, publicDataset(before), publicDataset(updated));
    return ok({ dataset: publicDataset(updated) });
  });

  route("DELETE", "/api/datasets/:id", async (ctx) => {
    const before = await datasets.get(ctx.params.id);
    if (!before) return error(404, "not_found", { message: "dataset not found" });
    enforce(ctx.principal, "dataset:admin", datasetScopeResource(before));
    await datasets.delete(before.id);
    await audit(ctx, "dataset.delete", "dataset", before.id, publicDataset(before), undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // --- versions + aliases ---

  route("GET", "/api/datasets/:id/versions", async (ctx) => {
    const ds = await datasets.get(ctx.params.id);
    if (!ds) return error(404, "not_found", { message: "dataset not found" });
    enforce(ctx.principal, "dataset:read", datasetScopeResource(ds));
    const versions = await datasetVersions.listByDataset(ds.id);
    const aliases = await datasetAliases.listByDataset(ds.id);
    return ok({
      versions: versions.map(publicDatasetVersion),
      aliases: aliases.map(publicDatasetAlias)
    });
  });

  route("POST", "/api/datasets/:id/versions", async (ctx) => {
    const ds = await datasets.get(ctx.params.id);
    if (!ds) return error(404, "not_found", { message: "dataset not found" });
    enforce(ctx.principal, "dataset:admin", datasetScopeResource(ds));
    const body = ctx.request.body;
    if (!isObject(body)) {
      return error(422, "validation_failed", { issues: [{ message: "body required" }] });
    }
    // Auto-number the version label as `v<N+1>` unless the caller passed
    // an explicit one (used by the migration script to mark imports `v1`).
    const existing = await datasetVersions.listByDataset(ds.id);
    const nextLabel =
      typeof body.versionLabel === "string" && body.versionLabel
        ? body.versionLabel
        : `v${existing.length + 1}`;
    const created = await datasetVersions.create({
      id: randomUUID(),
      datasetId: ds.id,
      versionLabel: nextLabel,
      schemaSpec: isObject(body.schemaSpec) ? body.schemaSpec : ds.chunkSchema,
      backendCollections: isObject(body.backendCollections)
        ? (body.backendCollections as Record<string, string>)
        : {},
      status: (body.status as DatasetVersionRow["status"]) ?? "building",
      docCount: 0,
      sizeBytes: 0,
      createdAt: nowIso(),
      readyAt: body.status === "ready" ? nowIso() : null
    });
    // If this is the dataset's first version and no `current_version_id`
    // is set yet, pin it and create the `stable` alias.
    if (!ds.currentVersionId) {
      await datasets.update(ds.id, { currentVersionId: created.id, updatedAt: nowIso() });
      await datasetAliases.upsert({
        id: randomUUID(),
        datasetId: ds.id,
        alias: "stable",
        versionId: created.id,
        updatedAt: nowIso(),
        updatedBy: ctx.principal.id
      });
    }
    await audit(ctx, "dataset_version.create", "dataset_version", created.id, undefined, publicDatasetVersion(created));
    return ok({ version: publicDatasetVersion(created) }, 201);
  });

  route("PATCH", "/api/datasets/:id/aliases/:alias", async (ctx) => {
    const ds = await datasets.get(ctx.params.id);
    if (!ds) return error(404, "not_found", { message: "dataset not found" });
    enforce(ctx.principal, "dataset:admin", datasetScopeResource(ds));
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.versionId !== "string") {
      return error(422, "validation_failed", {
        issues: [{ path: "versionId", message: "versionId required" }]
      });
    }
    const version = await datasetVersions.get(body.versionId);
    if (!version || version.datasetId !== ds.id) {
      return error(422, "validation_failed", {
        issues: [{ path: "versionId", message: "version does not belong to this dataset" }]
      });
    }
    const before = await datasetAliases.resolve(ds.id, ctx.params.alias);
    const row = await datasetAliases.upsert({
      id: before?.id ?? randomUUID(),
      datasetId: ds.id,
      alias: ctx.params.alias,
      versionId: version.id,
      updatedAt: nowIso(),
      updatedBy: ctx.principal.id
    });
    await audit(
      ctx,
      "dataset_alias.set",
      "dataset_alias",
      row.id,
      before ? publicDatasetAlias(before) : undefined,
      publicDatasetAlias(row)
    );
    return ok({ alias: publicDatasetAlias(row) });
  });

  registerSecretsRoutes({ route }, { deps, audit, tenantScope });
  registerExecutionsRoutes({ route }, { deps, tenantScope });


  // ---- observability (audit / usage / retention) --------------------------
  // Extracted into ./app/routes/observability.ts. Future route domains
  // follow the same `registerXxxRoutes(api, svc)` pattern — each module
  // declares its own deps shape so migrations stay independent.
  registerObservabilityRoutes(
    { route },
    { deps, audit, retentionSettings }
  );

  registerPluginsProvidersRoutes({ route }, { deps });

  // ---- run ----------------------------------------------------------------
  route("POST", "/api/pipelines/:id/run", async (ctx) => {
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    enforce(ctx.principal, "pipeline:run", {
      tenantId: ctx.principal.tenantId,
      pipelineId: pipeline.id
    });
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required (x-tenant-id or principal tenant)" }]
      });
    }
    const environment =
      (typeof body.environment === "string" && body.environment) ||
      ctx.request.query.environment ||
      "dev";
    const activationLabel =
      typeof body.activation === "string" ? body.activation : undefined;

    const outcome = await enqueuePipelineRun({
      tenantId,
      pipeline,
      environment,
      activationLabel,
      input: body.input
    });
    if (!outcome.ok) return outcome.response;
    await audit(ctx, "pipeline.run", "execution", outcome.executionId, undefined, {
      pipelineId: pipeline.id,
      version: outcome.version,
      resolvedVia: outcome.resolvedVia,
      activationLabel: outcome.activationLabel ?? null,
      input: redactValue(body.input)
    });
    return ok(
      {
        executionId: outcome.executionId,
        jobId: outcome.jobId,
        pipelineId: pipeline.id,
        pipelineVersionId: outcome.versionId,
        version: outcome.version,
        resolvedVia: outcome.resolvedVia,
        ...(outcome.activationLabel !== undefined
          ? { activationLabel: outcome.activationLabel }
          : {}),
        status: "accepted"
      },
      202
    );
  });

  // ---- webhook triggers ---------------------------------------------------
  // Lifecycle of a webhook trigger:
  //   1. POST /api/pipelines/:id/triggers  (auth'd, scoped) -> mints a token
  //      bound to (tenant, pipeline, env, activation?); plaintext is shown
  //      once and a sha256 hash + 12-char prefix are persisted.
  //   2. The external system POSTs the body to /api/triggers/webhook/<token>;
  //      that endpoint is PUBLIC (the token IS the auth) and enqueues a
  //      run_pipeline job exactly like the API run route.
  //   3. DELETE /api/triggers/:id revokes (row delete).

  route("POST", "/api/pipelines/:id/triggers", async (ctx) => {
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required" }]
      });
    }
    enforce(ctx.principal, "pipeline:run", {
      tenantId,
      pipelineId: pipeline.id
    });
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    if (typeof body.environment !== "string" || typeof body.name !== "string") {
      return error(422, "validation_failed", {
        issues: [{ message: "environment and name are required" }]
      });
    }
    const id = randomUUID();
    const issued = WebhookTokenService.issue(id);
    const row: WebhookTriggerRow = {
      id,
      tenantId,
      pipelineId: pipeline.id,
      environment: body.environment,
      activationLabel:
        typeof body.activationLabel === "string" ? body.activationLabel : null,
      name: body.name,
      prefix: issued.prefix,
      hash: issued.hash,
      enabled: body.enabled !== false,
      createdBy: ctx.principal.id,
      createdAt: nowIso()
    };
    const created = await webhookTriggers.create(row);
    await audit(
      ctx,
      "webhook_trigger.create",
      "webhook_trigger",
      created.id,
      undefined,
      { name: created.name, environment: created.environment, prefix: created.prefix }
    );
    return ok(
      {
        trigger: {
          id: created.id,
          name: created.name,
          environment: created.environment,
          activationLabel: created.activationLabel,
          prefix: created.prefix,
          enabled: created.enabled,
          createdAt: created.createdAt
        },
        // The plaintext is returned ONCE; the server only persists the hash.
        token: issued.plaintext,
        url: `${requestOrigin(ctx.request)}/api/triggers/webhook/${issued.plaintext}`
      },
      201
    );
  });

  route("GET", "/api/pipelines/:id/triggers", async (ctx) => {
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required" }]
      });
    }
    enforce(ctx.principal, "pipeline:run", {
      tenantId,
      pipelineId: pipeline.id
    });
    const rows = await webhookTriggers.listForPipeline(tenantId, pipeline.id);
    return ok({
      triggers: rows.map((r) => ({
        id: r.id,
        name: r.name,
        environment: r.environment,
        activationLabel: r.activationLabel,
        prefix: r.prefix,
        enabled: r.enabled,
        createdAt: r.createdAt,
        lastTriggeredAt: r.lastTriggeredAt ?? null
      }))
    });
  });

  route("DELETE", "/api/triggers/:id", async (ctx) => {
    const row = await webhookTriggers.get(ctx.params.id);
    if (!row) return error(404, "not_found");
    enforce(ctx.principal, "pipeline:run", {
      tenantId: row.tenantId,
      pipelineId: row.pipelineId
    });
    await webhookTriggers.delete(row.id);
    await audit(
      ctx,
      "webhook_trigger.delete",
      "webhook_trigger",
      row.id,
      { name: row.name, environment: row.environment },
      undefined
    );
    return { status: 204, body: undefined, headers: {} };
  });

  /**
   * Public webhook trigger. The path token is the bearer; no other auth runs.
   * Body is forwarded verbatim as the run's `input`. We touch the trigger so
   * an admin can see "last fired at" in the UI.
   */
  route("POST", "/api/triggers/webhook/:token", async (ctx) => {
    let record;
    try {
      record = await WebhookTokenService.verify(ctx.params.token, {
        findByPrefix: async (prefix) => {
          const row = await webhookTriggers.findByPrefix(prefix);
          if (!row) return undefined;
          return {
            id: row.id,
            prefix: row.prefix,
            hash: row.hash,
            enabled: row.enabled,
            revokedAt: row.revokedAt
          };
        }
      });
    } catch (e) {
      if (e instanceof InvalidWebhookTokenError) {
        return error(401, "invalid_webhook_token", { message: e.message });
      }
      throw e;
    }
    const trigger = await webhookTriggers.get(record.id);
    if (!trigger) return error(404, "not_found");
    const pipeline = await deps.pipelines.get(trigger.pipelineId);
    if (!pipeline) {
      return error(404, "not_found", { message: "pipeline no longer exists" });
    }
    const outcome = await enqueuePipelineRun({
      tenantId: trigger.tenantId,
      pipeline,
      environment: trigger.environment,
      activationLabel: trigger.activationLabel ?? undefined,
      input: ctx.request.body
    });
    if (!outcome.ok) return outcome.response;
    await webhookTriggers.touch(trigger.id);
    await deps.auditLogs.append({
      actorId: null,
      tenantId: trigger.tenantId,
      pipelineId: trigger.pipelineId,
      action: "pipeline.run",
      targetType: "execution",
      targetId: outcome.executionId,
      beforeRedacted: undefined,
      afterRedacted: {
        source: "webhook",
        triggerId: trigger.id,
        version: outcome.version,
        resolvedVia: outcome.resolvedVia,
        input: redactValue(ctx.request.body)
      },
      requestId: headerValue(ctx.request.headers, "x-request-id") ?? null,
      sourceIp: headerValue(ctx.request.headers, "x-forwarded-for") ?? null,
      userAgent: headerValue(ctx.request.headers, "user-agent") ?? null,
      createdAt: nowIso()
    });
    return ok(
      {
        executionId: outcome.executionId,
        pipelineId: pipeline.id,
        version: outcome.version,
        resolvedVia: outcome.resolvedVia,
        ...(outcome.activationLabel !== undefined
          ? { activationLabel: outcome.activationLabel }
          : {}),
        status: "accepted"
      },
      202
    );
  });

  // ---- ingest -------------------------------------------------------------
  route("POST", "/api/pipelines/:id/ingest", async (ctx) => {
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    const pipelineId = pipeline.id;
    enforce(ctx.principal, "pipeline:run", {
      tenantId: ctx.principal.tenantId,
      pipelineId
    });
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required" }]
      });
    }
    const environment =
      (typeof body.environment === "string" && body.environment) ||
      ctx.request.query.environment ||
      "dev";
    const resolved = await resolveDeployedVersion(deps, pipelineId, environment, tenantId);
    if (!resolved) {
      return error(409, "no_active_deployment", {
        message: `no active deployment for pipeline ${pipelineId} in ${environment}`
      });
    }
    const jobId = randomUUID();
    const job: QueueJob<{
      tenantId: string;
      pipelineId: string;
      pipelineVersionId: string;
      environment: string;
      datasource: unknown;
    }> = {
      id: jobId,
      type: "ingest_datasource",
      payload: {
        tenantId,
        pipelineId,
        pipelineVersionId: resolved.id,
        environment,
        datasource: body.datasource ?? body.input
      }
    };
    await deps.queue.enqueue(job);
    await audit(ctx, "pipeline.ingest", "ingestion", jobId, undefined, {
      pipelineId,
      datasource: redactValue(body.datasource ?? body.input)
    });
    return ok(
      { jobId, pipelineId, pipelineVersionId: resolved.id, status: "accepted" },
      202
    );
  });

  // ---- Phase 8: synchronous /invoke ---------------------------------------
  // The synchronous companion to /run. Runs the pipeline in-process and
  // returns the terminal output JSON in the response body. Pipelines
  // SHOULD declare `metadata.executionKind: "synchronous"` to be invoked
  // here; legacy / batch pipelines aren't rejected but are warned about
  // (operators sometimes deliberately invoke a batch spec synchronously
  // when iterating). pipeline:run RBAC + dataset resolution + Phase 2
  // executor entry-check all behave exactly as the worker path.
  route("POST", "/api/pipelines/:id/invoke", async (ctx) => {
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    enforce(ctx.principal, "pipeline:run", {
      tenantId: ctx.principal.tenantId,
      pipelineId: pipeline.id
    });
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required" }]
      });
    }
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    const environment =
      (typeof body.environment === "string" && body.environment) ||
      ctx.request.query.environment ||
      "dev";
    const resolved = await resolveDeployedVersion(deps, pipeline.id, environment, tenantId);
    if (!resolved) {
      return error(409, "no_active_deployment", {
        message: `no active deployment for pipeline ${pipeline.id} in ${environment}`
      });
    }
    const validation = validatePipelineSpec(
      resolved.spec as PipelineSpec,
      deps.pluginRegistry
    );
    if (!validation.valid) {
      return error(422, "validation_failed", { issues: validation.errors });
    }
    try {
      const { executionId, output } = await runSyncPipeline({
        tenantId,
        pipeline,
        versionRow: resolved,
        environment,
        input: body.input,
        actorId: ctx.principal.id,
        requestId: headerValue(ctx.request.headers, "x-request-id") ?? undefined,
        deadlineMs:
          typeof body.deadlineMs === "number" ? body.deadlineMs : undefined
      });
      await audit(ctx, "pipeline.invoke", "execution", executionId, undefined, {
        pipelineId: pipeline.id,
        version: resolved.version,
        kind: "synchronous",
        input: redactValue(body.input)
      });
      return ok({
        executionId,
        pipelineId: pipeline.id,
        pipelineVersionId: resolved.id,
        version: resolved.version,
        status: "succeeded",
        output
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return error(500, "execution_failed", { message });
    }
  });

  // ---- stream (SSE) -------------------------------------------------------
  // Real chunked SSE (Phase 13). Returns an async generator that yields
  // frames as they're produced; the Fastify layer detects an
  // AsyncIterable body and pipes it via reply.raw.write() so each
  // frame goes over the wire the instant it's ready. The previous
  // not_enabled stub is gone — see ADR-0018.
  route("POST", "/api/pipelines/:id/stream", async (ctx) => {
    const pipeline = await resolvePipelineRef(ctx.params.id);
    if (isAppResponse(pipeline)) return pipeline;
    enforce(ctx.principal, "pipeline:run", {
      tenantId: ctx.principal.tenantId,
      pipelineId: pipeline.id
    });
    const tenantId = tenantScope(ctx);
    if (!tenantId) {
      return error(422, "validation_failed", {
        issues: [{ message: "tenant context required" }]
      });
    }
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    const environment =
      (typeof body.environment === "string" && body.environment) ||
      ctx.request.query.environment ||
      "dev";
    const resolved = await resolveDeployedVersion(deps, pipeline.id, environment, tenantId);
    if (!resolved) {
      return error(409, "no_active_deployment", {
        message: `no active deployment for pipeline ${pipeline.id} in ${environment}`
      });
    }
    const validation = validatePipelineSpec(
      resolved.spec as PipelineSpec,
      deps.pluginRegistry
    );
    if (!validation.valid) {
      return error(422, "validation_failed", { issues: validation.errors });
    }
    // Phase 13: real chunked SSE. Returns an async generator that yields
    // frames in real time so the client can render progress instead of
    // waiting for the whole run. The Fastify layer detects an
    // AsyncIterable body and pipes it via reply.raw.write().
    //
    // Capture the narrowed locals before the generator closes over them
    // so TS doesn't widen `pipeline` back to (PipelineRow | AppResponse)
    // or `tenantId` back to `string | undefined` inside the closure.
    const pipelineForStream = pipeline;
    const resolvedForStream = resolved;
    const tenantIdForStream = tenantId;
    async function* streamFrames(): AsyncGenerator<string> {
      function f(event: string, data: unknown): string {
        return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      }
      // Producer/consumer pattern: the run executes in the background
      // and pushes token frames into the queue via onToken; the
      // generator drains the queue between yield points. When the run
      // resolves, we push the terminal output + done frames and let
      // the loop exit.
      const queue: string[] = [];
      let resolveNext: (() => void) | undefined;
      let done = false;
      function push(frame: string): void {
        queue.push(frame);
        resolveNext?.();
        resolveNext = undefined;
      }
      yield f("execution.started", {
        pipelineId: pipelineForStream.id,
        pipelineVersionId: resolvedForStream.id
      });
      const runPromise = runSyncPipeline({
        tenantId: tenantIdForStream,
        pipeline: pipelineForStream,
        versionRow: resolvedForStream,
        environment,
        input: body.input,
        actorId: ctx.principal.id,
        requestId: headerValue(ctx.request.headers, "x-request-id") ?? undefined,
        deadlineMs:
          typeof body.deadlineMs === "number" ? body.deadlineMs : undefined,
        onToken: ({ nodeId, token }) => push(f("token", { nodeId, token }))
      })
        .then(async (result) => {
          push(
            f("execution.completed", {
              executionId: result.executionId,
              status: "succeeded"
            })
          );
          push(f("output", { output: result.output }));
          push(
            f("done", {
              executionId: result.executionId,
              pipelineId: pipelineForStream.id,
              pipelineVersionId: resolvedForStream.id
            })
          );
          await audit(
            ctx,
            "pipeline.invoke",
            "execution",
            result.executionId,
            undefined,
            {
              pipelineId: pipelineForStream.id,
              version: resolvedForStream.version,
              kind: "stream",
              input: redactValue(body.input)
            }
          );
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          push(f("execution.failed", { error: message }));
          push(f("error", { message }));
        })
        .finally(() => {
          done = true;
          resolveNext?.();
          resolveNext = undefined;
        });
      try {
        while (true) {
          while (queue.length > 0) {
            yield queue.shift()!;
          }
          if (done) break;
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
      } finally {
        // If the consumer hung up early, let the run finish so the
        // audit log + execution record stay consistent.
        await runPromise.catch(() => undefined);
      }
    }
    return {
      status: 200,
      body: streamFrames(),
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    };
  });

  // ---- auth & access-control ---------------------------------------------
  //
  // Authentication entry points (login/signup/sso/providers) are public; every
  // management route is default-deny via `enforce`. Grant-scoped routes derive
  // the request scope from the grant itself so an admin can only act within
  // scopes their own grants cover (a tenant_admin cannot mint platform roles).

  function scopeInputFromBody(body: Record<string, unknown>): ScopeInput {
    if (typeof body.scope === "string" && body.scope.length > 0) {
      return parseScope(body.scope);
    }
    return {
      tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
      environment:
        typeof body.environment === "string" ? body.environment : undefined,
      pipelineId:
        typeof body.pipelineId === "string" ? body.pipelineId : undefined
    };
  }

  function scopeResource(scope: string): {
    tenantId?: string;
    pipelineId?: string;
    environment?: string;
  } {
    const s = parseScope(scope);
    return {
      tenantId: s.tenantId ?? undefined,
      environment: s.environment ?? undefined,
      pipelineId: s.pipelineId ?? undefined
    };
  }

  function defaultPermsFor(role: string): string[] {
    return (
      (DEFAULT_ROLE_PERMISSIONS as Record<string, string[]>)[role] ?? []
    );
  }

  /**
   * Effective role -> permission catalog: the DB store if populated, else the
   * built-in defaults (so a fresh / in-memory deployment works with no seed).
   */
  async function effectiveCatalog(): Promise<Map<string, Set<string>>> {
    const rows = await rbacPolicies.listRolePermissions();
    const catalog = new Map<string, Set<string>>();
    const source = rows.length
      ? rows
      : ALL_ROLES.flatMap((r) =>
          defaultPermsFor(r).map((permission) => ({ role: r, permission }))
        );
    for (const { role, permission } of source) {
      let set = catalog.get(role);
      if (!set) {
        set = new Set();
        catalog.set(role, set);
      }
      set.add(permission);
    }
    return catalog;
  }

  function publicUser(u: UserRow): Record<string, unknown> {
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName ?? null,
      status: u.status,
      sso: !u.passwordHash,
      createdAt: u.createdAt
    };
  }

  /**
   * Non-secret view of an API key. The stored sha256 `hash` and the one-time
   * plaintext are NEVER part of this projection — only the lookup `prefix`,
   * which is not a credential on its own.
   */
  function publicApiKey(r: ApiKeyRecord): Record<string, unknown> {
    const expired =
      !!r.expiresAt && new Date(r.expiresAt).getTime() <= Date.now();
    return {
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      roles: r.roles,
      tenantId: r.tenantId ?? null,
      environmentId: r.environmentId ?? null,
      scope: scopeToString({
        tenantId: r.tenantId,
        environment: r.environmentId
      }),
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt ?? null,
      revokedAt: r.revokedAt ?? null,
      expiresAt: r.expiresAt ?? null,
      status: r.revokedAt
        ? "revoked"
        : expired
          ? "expired"
          : "active"
    };
  }

  /** Non-secret view of an IdP (client secrets / SP keys are write-only). */
  function publicIdp(p: IdentityProviderRow): Record<string, unknown> {
    const cfg = { ...(p.config as Record<string, unknown>) };
    for (const k of ["clientSecret", "spPrivateKey", "privateKey"]) {
      if (k in cfg) cfg[k] = "REDACTED";
    }
    return {
      id: p.id,
      slug: p.slug,
      kind: p.kind,
      displayName: p.displayName,
      enabled: p.enabled,
      config: cfg
    };
  }

  function buildSsoProvider(
    row: IdentityProviderRow
  ): OidcProvider | SamlProvider {
    const c = row.config as Record<string, unknown>;
    if (row.kind === "oidc") {
      return new OidcProvider({
        issuer: String(c.issuer ?? ""),
        clientId: String(c.clientId ?? ""),
        clientSecret: String(c.clientSecret ?? ""),
        scopes: typeof c.scopes === "string" ? c.scopes : undefined
      });
    }
    return new SamlProvider({
      entryPoint: String(c.entryPoint ?? ""),
      issuer: String(c.issuer ?? ""),
      callbackUrl: String(c.callbackUrl ?? ""),
      idpCert: String(c.idpCert ?? ""),
      emailAttribute:
        typeof c.emailAttribute === "string" ? c.emailAttribute : undefined,
      nameAttribute:
        typeof c.nameAttribute === "string" ? c.nameAttribute : undefined
    });
  }

  function requestOrigin(req: AppRequest): string {
    const proto = headerValue(req.headers, "x-forwarded-proto") ?? "http";
    const host =
      headerValue(req.headers, "x-forwarded-host") ??
      headerValue(req.headers, "host") ??
      "localhost:3001";
    return `${proto}://${host}`;
  }

  function webRedirect(token: string): AppResponse {
    const base = process.env.WEB_BASE_URL ?? "/";
    const sep = base.includes("#") ? "&" : "#";
    return {
      status: 302,
      body: undefined,
      headers: { location: `${base}${sep}access_token=${encodeURIComponent(token)}` }
    };
  }

  // ---- auth: local + session ----------------------------------------------
  route("POST", "/api/auth/login", async (ctx) => {
    if (!accounts) return error(501, "auth_not_configured");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.email !== "string" || typeof body.password !== "string") {
      return error(422, "validation_failed", { issues: [{ message: "email and password are required" }] });
    }
    try {
      const out = await accounts.loginLocal(body.email, body.password);
      return ok({ token: out.token, user: publicUser(out.user as UserRow) });
    } catch (e) {
      if (e instanceof InvalidCredentialsError) return error(401, "invalid_credentials");
      if (e instanceof AccountDisabledError) return error(403, "account_disabled");
      throw e;
    }
  });

  route("POST", "/api/auth/signup", async (ctx) => {
    if (!accounts) return error(501, "auth_not_configured");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.email !== "string" || typeof body.password !== "string") {
      return error(422, "validation_failed", { issues: [{ message: "email and password are required" }] });
    }
    try {
      const out = await accounts.signupLocal({
        email: body.email,
        password: body.password,
        displayName: typeof body.displayName === "string" ? body.displayName : undefined
      });
      return ok({ token: out.token, user: publicUser(out.user as UserRow) }, 201);
    } catch (e) {
      if (e instanceof SignupDisabledError) return error(403, "signup_disabled");
      if (e instanceof EmailInUseError) return error(409, "email_in_use");
      if (e instanceof Error && e.name === "WeakPasswordError") {
        return error(422, "weak_password", { message: e.message });
      }
      throw e;
    }
  });

  route("POST", "/api/auth/logout", async () => {
    // Session tokens are stateless and short-lived; the client discards it.
    return { status: 204, body: undefined, headers: {} };
  });

  route("GET", "/api/auth/me", async (ctx) => {
    const p = ctx.principal;
    const user =
      p.type === "user" ? await users.get(p.id) : undefined;
    let grants: Array<{ role: string; scope: string }>;
    if (p.type === "user" && (!p.roles || p.roles.length === 0)) {
      grants = (await rbacPolicies.listGrantsForUser(p.id)).map((g) => ({
        role: g.role,
        scope: g.scope
      }));
    } else {
      const scope = p.tenantId ? `t/${p.tenantId}` : "*";
      grants = (p.roles ?? []).map((role) => ({ role, scope }));
    }
    const catalog = await effectiveCatalog();
    const permissions = [
      ...new Set(grants.flatMap((g) => [...(catalog.get(g.role) ?? [])]))
    ];
    return ok({
      principal: { id: p.id, type: p.type, tenantId: p.tenantId ?? null },
      user: user ? publicUser(user) : null,
      grants,
      permissions
    });
  });

  // ---- self-service profile ----------------------------------------------
  // Any signed-in user may edit their OWN account; these need no permission
  // grant (the principal IS the resource). API-key principals have no
  // editable account, so they are refused.
  route("PATCH", "/api/auth/me", async (ctx) => {
    const p = ctx.principal;
    if (p.type !== "user") {
      return error(403, "forbidden", {
        message: "no editable profile for this principal"
      });
    }
    const before = await users.get(p.id);
    if (!before) return error(404, "not_found");
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<UserRow> = { updatedAt: nowIso() };
    if (typeof body.displayName === "string" || body.displayName === null) {
      patch.displayName = body.displayName as string | null;
    }
    const updated = await users.update(p.id, patch);
    await audit(ctx, "user.update", "user", p.id, publicUser(before), publicUser(updated));
    return ok({ user: publicUser(updated) });
  });

  route("POST", "/api/auth/password", async (ctx) => {
    const p = ctx.principal;
    if (p.type !== "user") {
      return error(403, "forbidden", {
        message: "no password for this principal"
      });
    }
    const user = await users.get(p.id);
    if (!user) return error(404, "not_found");
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.newPassword !== "string" ||
      body.newPassword.length < 8
    ) {
      return error(422, "validation_failed", {
        issues: [
          { path: "newPassword", message: "newPassword must be at least 8 characters" }
        ]
      });
    }
    // A user who already has a password must prove they know it. An SSO-only
    // account (no stored hash) may set an initial password without one.
    if (user.passwordHash) {
      const current =
        typeof body.currentPassword === "string" ? body.currentPassword : "";
      if (!(await passwords.verify(current, user.passwordHash))) {
        return error(403, "invalid_credentials", {
          message: "current password is incorrect"
        });
      }
    }
    let passwordHash: string;
    try {
      passwordHash = await passwords.hash(body.newPassword);
    } catch (e) {
      if (e instanceof Error && e.name === "WeakPasswordError") {
        return error(422, "validation_failed", {
          issues: [{ path: "newPassword", message: "password is too weak" }]
        });
      }
      throw e;
    }
    await users.update(p.id, { passwordHash, updatedAt: nowIso() });
    await audit(ctx, "user.password_change", "user", p.id, undefined, undefined);
    return ok({ ok: true });
  });

  // ---- API keys (self-service) -------------------------------------------
  // A user manages their OWN keys. A new key carries an explicit role at an
  // explicit scope, and `enforce` caps it: the creator must already hold
  // every permission that role confers at that scope, so a key can never
  // exceed its issuer.
  route("GET", "/api/api-keys", async (ctx) => {
    const p = ctx.principal;
    if (p.type !== "user") {
      return error(403, "forbidden", {
        message: "API keys are managed by a signed-in user"
      });
    }
    const records = await apiKeys.list(p.id);
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return ok({ apiKeys: records.map(publicApiKey) });
  });

  route("POST", "/api/api-keys", async (ctx) => {
    const p = ctx.principal;
    if (p.type !== "user") {
      return error(403, "forbidden", {
        message: "API keys are managed by a signed-in user"
      });
    }
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.name !== "string" ||
      body.name.trim() === ""
    ) {
      return error(422, "validation_failed", {
        issues: [{ path: "name", message: "name is required" }]
      });
    }
    if (typeof body.role !== "string" || body.role === "") {
      return error(422, "validation_failed", {
        issues: [{ path: "role", message: "role is required" }]
      });
    }
    const role = body.role;
    const tenantId =
      typeof body.tenantId === "string" && body.tenantId ? body.tenantId : undefined;
    // Phase 3: optional env + expiration. env is a string that must match a
    // configured tenant environment when both tenant and env are provided.
    const environmentId =
      typeof body.environmentId === "string" && body.environmentId
        ? body.environmentId.trim()
        : undefined;
    let expiresAt: string | undefined;
    if (body.expiresAt !== undefined && body.expiresAt !== null) {
      if (typeof body.expiresAt !== "string") {
        return error(422, "validation_failed", {
          issues: [{ path: "expiresAt", message: "expiresAt must be an ISO 8601 string" }]
        });
      }
      const parsed = new Date(body.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        return error(422, "validation_failed", {
          issues: [{ path: "expiresAt", message: "expiresAt is not a valid date" }]
        });
      }
      if (parsed.getTime() <= Date.now()) {
        return error(422, "validation_failed", {
          issues: [{ path: "expiresAt", message: "expiresAt must be in the future" }]
        });
      }
      expiresAt = parsed.toISOString();
    }

    const catalog = await effectiveCatalog();
    if (!catalog.has(role)) {
      return error(422, "validation_failed", {
        issues: [{ path: "role", message: `unknown role: ${role}` }]
      });
    }
    if (tenantId) {
      const tenant = await deps.tenants.get(tenantId);
      if (!tenant) {
        return error(422, "validation_failed", {
          issues: [{ path: "tenantId", message: "unknown tenant" }]
        });
      }
    }
    if (environmentId) {
      if (!tenantId) {
        return error(422, "validation_failed", {
          issues: [{ path: "environmentId", message: "environmentId requires tenantId" }]
        });
      }
      const envs = await environments.listByTenant(tenantId);
      if (!envs.find((e) => e.name === environmentId)) {
        return error(422, "validation_failed", {
          issues: [{ path: "environmentId", message: `unknown environment: ${environmentId}` }]
        });
      }
    }

    // Cap the key at its creator's authority: reuse the exact scoped decision
    // the rest of the API uses. `enforce` throws AuthorizationError (-> 403)
    // for any permission of `role` the creator does not hold at this scope.
    const resource = scopeResource(
      scopeToString({ tenantId, environment: environmentId })
    );
    for (const permission of catalog.get(role) ?? []) {
      enforce(p, permission as Permission, resource);
    }

    const issued = await apiKeys.issue({
      principalId: p.id,
      tenantId,
      environmentId,
      name: body.name.trim(),
      roles: [role] as ApiKeyRecord["roles"],
      expiresAt
    });
    await audit(
      ctx,
      "apikey.create",
      "api_key",
      issued.id,
      undefined,
      publicApiKey(issued.record)
    );
    // `plaintext` is returned exactly once — it is never recoverable later.
    return ok(
      { apiKey: publicApiKey(issued.record), plaintext: issued.plaintext },
      201
    );
  });

  route("DELETE", "/api/api-keys/:id", async (ctx) => {
    const p = ctx.principal;
    if (p.type !== "user") {
      return error(403, "forbidden", {
        message: "API keys are managed by a signed-in user"
      });
    }
    const target = (await apiKeys.list(p.id)).find(
      (k) => k.id === ctx.params.id
    );
    if (!target) {
      return error(404, "not_found", { message: "API key not found" });
    }
    await apiKeys.revoke(target.id);
    await audit(
      ctx,
      "apikey.revoke",
      "api_key",
      target.id,
      publicApiKey(target),
      publicApiKey({ ...target, revokedAt: target.revokedAt ?? nowIso() })
    );
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- auth: SSO ----------------------------------------------------------
  route("GET", "/api/auth/providers", async () => {
    const list = await identityProviders.listEnabled();
    return ok({
      providers: list.map((p) => ({
        slug: p.slug,
        kind: p.kind,
        displayName: p.displayName
      }))
    });
  });

  route("GET", "/api/auth/sso/:slug/start", async (ctx) => {
    const row = await identityProviders.findBySlug(ctx.params.slug);
    if (!row || !row.enabled) return error(404, "provider_not_found");
    const provider = buildSsoProvider(row);
    const origin = requestOrigin(ctx.request);
    const redirectUri =
      String((row.config as Record<string, unknown>).callbackUrl ?? "") ||
      `${origin}/api/auth/sso/${row.slug}/callback`;
    const state = randomToken();
    const nonce = randomToken();
    ssoStates.set(state, { slug: row.slug, nonce, redirectUri, at: Date.now() });
    if (provider instanceof OidcProvider) {
      const url = await provider.authorizationUrl({ redirectUri, state, nonce });
      return { status: 302, body: undefined, headers: { location: url } };
    }
    const url = await (provider as SamlProvider).loginRedirectUrl(state);
    return { status: 302, body: undefined, headers: { location: url } };
  });

  async function completeSso(
    code: string | undefined,
    samlBody: { SAMLResponse: string; RelayState?: string } | undefined,
    stateParam: string | undefined
  ): Promise<AppResponse> {
    if (!accounts) return error(501, "auth_not_configured");
    const state = stateParam ?? samlBody?.RelayState;
    const pending = state ? ssoStates.get(state) : undefined;
    if (!state || !pending || Date.now() - pending.at > SSO_STATE_TTL_MS) {
      return error(400, "sso_state_invalid");
    }
    ssoStates.delete(state);
    const row = await identityProviders.findBySlug(pending.slug);
    if (!row || !row.enabled) return error(404, "provider_not_found");
    const provider = buildSsoProvider(row);
    let identity: SsoIdentity;
    try {
      if (provider instanceof OidcProvider) {
        if (!code) return error(400, "missing_code");
        identity = await provider.handleCallback({
          code,
          redirectUri: pending.redirectUri,
          expectedNonce: pending.nonce
        });
      } else {
        if (!samlBody?.SAMLResponse) return error(400, "missing_saml_response");
        identity = await (provider as SamlProvider).validatePostResponse({
          SAMLResponse: samlBody.SAMLResponse
        });
      }
    } catch (e) {
      deps.logger.error("sso_validation_failed", {
        slug: pending.slug,
        error: e instanceof Error ? e.message : String(e)
      });
      return error(401, "sso_failed", { message: e instanceof Error ? e.message : "SSO failed" });
    }
    try {
      const out = await accounts.loginSso(pending.slug, identity);
      return webRedirect(out.token);
    } catch (e) {
      if (e instanceof AccountDisabledError) return error(403, "account_disabled");
      throw e;
    }
  }

  route("GET", "/api/auth/sso/:slug/callback", async (ctx) =>
    completeSso(ctx.request.query.code, undefined, ctx.request.query.state)
  );

  route("POST", "/api/auth/sso/:slug/callback", async (ctx) => {
    const body = isObject(ctx.request.body) ? ctx.request.body : {};
    return completeSso(
      typeof body.code === "string" ? body.code : ctx.request.query.code,
      typeof body.SAMLResponse === "string"
        ? {
            SAMLResponse: body.SAMLResponse,
            RelayState:
              typeof body.RelayState === "string" ? body.RelayState : undefined
          }
        : undefined,
      ctx.request.query.state
    );
  });

  // ---- users --------------------------------------------------------------
  route("GET", "/api/users", async (ctx) => {
    enforce(ctx.principal, "user:manage");
    const all = await users.list();
    return ok({ users: all.map(publicUser) });
  });

  route("POST", "/api/users", async (ctx) => {
    enforce(ctx.principal, "user:manage");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.email !== "string") {
      return error(422, "validation_failed", { issues: [{ path: "email", message: "email is required" }] });
    }
    const email = body.email.trim().toLowerCase();
    if (await users.findByEmail(email)) {
      return error(409, "conflict", { message: "email already exists" });
    }
    const now = nowIso();
    const row: UserRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      email,
      displayName: typeof body.displayName === "string" ? body.displayName : null,
      passwordHash:
        typeof body.password === "string" && body.password.length > 0
          ? await passwords.hash(body.password)
          : null,
      status: body.status === "disabled" ? "disabled" : "active",
      createdAt: now,
      updatedAt: now
    };
    const created = await users.create(row);
    await audit(ctx, "user.create", "user", created.id, undefined, publicUser(created));
    return ok({ user: publicUser(created) }, 201);
  });

  route("PATCH", "/api/users/:id", async (ctx) => {
    enforce(ctx.principal, "user:manage");
    const before = await users.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<UserRow> = { updatedAt: nowIso() };
    if (typeof body.displayName === "string" || body.displayName === null) {
      patch.displayName = body.displayName as string | null;
    }
    if (body.status === "active" || body.status === "disabled") {
      patch.status = body.status;
    }
    if (typeof body.password === "string" && body.password.length > 0) {
      patch.passwordHash = await passwords.hash(body.password);
    }
    const updated = await users.update(ctx.params.id, patch);
    await audit(ctx, "user.update", "user", updated.id, publicUser(before), publicUser(updated));
    return ok({ user: publicUser(updated) });
  });

  route("DELETE", "/api/users/:id", async (ctx) => {
    enforce(ctx.principal, "user:manage");
    const before = await users.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    await users.delete(ctx.params.id);
    if (authorizer) authorizer.invalidate(ctx.params.id);
    await audit(ctx, "user.delete", "user", ctx.params.id, publicUser(before), undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  route("GET", "/api/users/:id/grants", async (ctx) => {
    enforce(ctx.principal, "user:manage");
    const user = await users.get(ctx.params.id);
    if (!user) return error(404, "not_found");
    const grants = await rbacPolicies.listGrantsForUser(ctx.params.id);
    return ok({
      grants: grants.map((g) => ({
        id: g.id,
        role: g.role,
        scope: g.scope,
        ...parseScope(g.scope)
      }))
    });
  });

  route("POST", "/api/users/:id/grants", async (ctx) => {
    const user = await users.get(ctx.params.id);
    if (!user) return error(404, "not_found");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.role !== "string") {
      return error(422, "validation_failed", { issues: [{ path: "role", message: "role is required" }] });
    }
    const scope = scopeToString(scopeInputFromBody(body));
    // The acting admin must hold user:manage over the *target scope*.
    enforce(ctx.principal, "user:manage", scopeResource(scope));
    const row: RbacGrantRow = {
      id: randomUUID(),
      userId: ctx.params.id,
      role: body.role,
      scope,
      createdAt: nowIso()
    };
    const created = await rbacPolicies.addGrant(row);
    if (authorizer) authorizer.invalidate(ctx.params.id);
    await audit(ctx, "user.grant", "user", ctx.params.id, undefined, { role: created.role, scope: created.scope });
    return ok({ grant: { id: created.id, role: created.role, scope: created.scope, ...parseScope(created.scope) } }, 201);
  });

  route("DELETE", "/api/users/:id/grants/:grantId", async (ctx) => {
    const user = await users.get(ctx.params.id);
    if (!user) return error(404, "not_found");
    const grants = await rbacPolicies.listGrantsForUser(ctx.params.id);
    const target = grants.find((g) => g.id === ctx.params.grantId);
    if (!target) return error(404, "not_found", { message: "grant not found" });
    enforce(ctx.principal, "user:manage", scopeResource(target.scope));
    await rbacPolicies.removeGrant(ctx.params.grantId);
    if (authorizer) authorizer.invalidate(ctx.params.id);
    await audit(ctx, "user.revoke", "user", ctx.params.id, { role: target.role, scope: target.scope }, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- roles & permissions ------------------------------------------------
  route("GET", "/api/roles", async (ctx) => {
    enforce(ctx.principal, "role:manage");
    const rows = await rbacPolicies.listRolePermissions();
    const byRole = new Map<string, string[]>();
    for (const { role, permission } of rows) {
      byRole.set(role, [...(byRole.get(role) ?? []), permission]);
    }
    const custom = await roleCatalog.list();
    const names = new Set<string>([
      ...ALL_ROLES,
      ...byRole.keys(),
      ...custom.map((r) => r.name)
    ]);
    const roles = [...names].map((name) => ({
      name,
      builtin: (ALL_ROLES as string[]).includes(name),
      description: custom.find((r) => r.name === name)?.description ?? null,
      permissions: byRole.get(name) ?? defaultPermsFor(name)
    }));
    return ok({ roles, allPermissions: ALL_PERMISSIONS });
  });

  route("POST", "/api/roles", async (ctx) => {
    enforce(ctx.principal, "role:manage");
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.name !== "string" || !body.name.trim()) {
      return error(422, "validation_failed", { issues: [{ path: "name", message: "name is required" }] });
    }
    if (await roleCatalog.findByName(body.name)) {
      return error(409, "conflict", { message: "role already exists" });
    }
    const created = await roleCatalog.create({
      id: randomUUID(),
      name: body.name.trim(),
      description: typeof body.description === "string" ? body.description : null
    });
    await audit(ctx, "role.create", "role", created.id, undefined, created);
    return ok({ role: created }, 201);
  });

  route("PUT", "/api/roles/:name/permissions", async (ctx) => {
    enforce(ctx.principal, "role:manage");
    const body = ctx.request.body;
    if (!isObject(body) || !Array.isArray(body.permissions)) {
      return error(422, "validation_failed", { issues: [{ path: "permissions", message: "permissions[] required" }] });
    }
    const perms = (body.permissions as unknown[]).filter(
      (p): p is string => typeof p === "string"
    );
    await rbacPolicies.setRolePermissions(ctx.params.name, perms);
    if (authorizer) authorizer.invalidate();
    await audit(ctx, "role.set_permissions", "role", ctx.params.name, undefined, { permissions: perms });
    return ok({ role: ctx.params.name, permissions: perms });
  });

  route("DELETE", "/api/roles/:name", async (ctx) => {
    enforce(ctx.principal, "role:manage");
    if ((ALL_ROLES as string[]).includes(ctx.params.name)) {
      return error(409, "conflict", { message: "cannot delete a built-in role" });
    }
    await rbacPolicies.setRolePermissions(ctx.params.name, []);
    const existing = await roleCatalog.findByName(ctx.params.name);
    if (existing) await roleCatalog.delete(existing.id);
    if (authorizer) authorizer.invalidate();
    await audit(ctx, "role.delete", "role", ctx.params.name, undefined, undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- identity providers -------------------------------------------------
  route("GET", "/api/identity-providers", async (ctx) => {
    enforce(ctx.principal, "idp:manage");
    const list = await identityProviders.list();
    return ok({ providers: list.map(publicIdp) });
  });

  route("POST", "/api/identity-providers", async (ctx) => {
    enforce(ctx.principal, "idp:manage");
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.slug !== "string" ||
      (body.kind !== "oidc" && body.kind !== "saml") ||
      typeof body.displayName !== "string"
    ) {
      return error(422, "validation_failed", {
        issues: [{ message: "slug, kind ('oidc'|'saml') and displayName are required" }]
      });
    }
    if (await identityProviders.findBySlug(body.slug)) {
      return error(409, "conflict", { message: "slug already exists" });
    }
    const now = nowIso();
    const row: IdentityProviderRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      slug: body.slug,
      kind: body.kind,
      displayName: body.displayName,
      enabled: body.enabled !== false,
      config: isObject(body.config) ? body.config : {},
      createdAt: now,
      updatedAt: now
    };
    const created = await identityProviders.create(row);
    await audit(ctx, "idp.create", "identity_provider", created.id, undefined, publicIdp(created));
    return ok({ provider: publicIdp(created) }, 201);
  });

  route("PUT", "/api/identity-providers/:id", async (ctx) => {
    enforce(ctx.principal, "idp:manage");
    const before = await identityProviders.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<IdentityProviderRow> = { updatedAt: nowIso() };
    if (typeof body.displayName === "string") patch.displayName = body.displayName;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (isObject(body.config)) {
      // Merge so a redacted secret left untouched by the UI is preserved.
      const merged = { ...(before.config as Record<string, unknown>) };
      for (const [k, v] of Object.entries(body.config)) {
        if (v === "REDACTED") continue;
        merged[k] = v;
      }
      patch.config = merged;
    }
    const updated = await identityProviders.update(ctx.params.id, patch);
    await audit(ctx, "idp.update", "identity_provider", updated.id, publicIdp(before), publicIdp(updated));
    return ok({ provider: publicIdp(updated) });
  });

  route("DELETE", "/api/identity-providers/:id", async (ctx) => {
    enforce(ctx.principal, "idp:manage");
    const before = await identityProviders.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    await identityProviders.delete(ctx.params.id);
    await audit(ctx, "idp.delete", "identity_provider", ctx.params.id, publicIdp(before), undefined);
    return { status: 204, body: undefined, headers: {} };
  });

  // ---- auth settings ------------------------------------------------------
  route("GET", "/api/auth/settings", async (ctx) => {
    enforce(ctx.principal, "auth:settings");
    return ok({ settings: await authSettings.get() });
  });

  route("PUT", "/api/auth/settings", async (ctx) => {
    enforce(ctx.principal, "auth:settings");
    const body = ctx.request.body;
    const modes: SignupMode[] = ["admin_only", "open_default_role", "open_no_access"];
    if (!isObject(body) || !modes.includes(body.signupMode as SignupMode)) {
      return error(422, "validation_failed", {
        issues: [{ path: "signupMode", message: `signupMode must be one of ${modes.join(", ")}` }]
      });
    }
    const saved = await authSettings.set({
      signupMode: body.signupMode as SignupMode,
      defaultRole:
        typeof body.defaultRole === "string" ? body.defaultRole : null,
      updatedAt: nowIso()
    });
    await audit(ctx, "auth.settings.update", "auth_settings", "singleton", undefined, saved);
    return ok({ settings: saved });
  });

  // ---- router -------------------------------------------------------------
  async function handle(request: AppRequest): Promise<AppResponse> {
    const pathSegments = compile(request.path);

    let matched: Route | undefined;
    let params: Record<string, string> = {};
    for (const r of routes) {
      const m = matchRoute(r, request.method, pathSegments);
      if (m) {
        matched = r;
        params = m;
        break;
      }
    }

    if (!matched) {
      // Distinguish a known path with the wrong method (405) from 404.
      const pathExists = routes.some(
        (r) => matchRoute({ ...r, method: r.method }, r.method, pathSegments) !== undefined
      );
      return error(pathExists ? 405 : 404, pathExists ? "method_not_allowed" : "not_found");
    }

    // Public = no credentials required. Besides health probes these are the
    // unauthenticated entry points to authentication itself: local login,
    // self-service signup, the enabled-provider list the login page renders,
    // and the SSO start/callback legs. Everything else is default-deny.
    const isPublic =
      request.path === "/healthz" ||
      request.path === "/readyz" ||
      request.path === "/api/auth/login" ||
      request.path === "/api/auth/signup" ||
      request.path === "/api/auth/providers" ||
      request.path.startsWith("/api/auth/sso/") ||
      // Webhook triggers carry their own bearer-in-URL: the token IS the auth.
      request.path.startsWith("/api/triggers/webhook/");

    let principal: Principal = { id: "anonymous", type: "service", roles: [] };
    if (!isPublic) {
      try {
        principal = await deps.auth.resolve({ headers: request.headers });
      } catch (e) {
        if (
          e instanceof UnauthorizedError ||
          e instanceof InvalidCredentialsError ||
          e instanceof TokenInvalidError ||
          e instanceof TokenExpiredError
        ) {
          return error(401, "unauthorized", { message: e.message });
        }
        throw e;
      }

      // The DevAuthProvider fallback must never be honored in production.
      if (
        (deps.env ?? "development") === "production" &&
        principal.id === "dev-user"
      ) {
        return error(401, "unauthorized", {
          message: "dev auth fallback disabled in production"
        });
      }

      // Attach the per-request scoped decision closure. The request's tenant
      // context (selected `x-tenant-id`, else the principal's tenant) is the
      // default scope so the existing `enforce(...)` call sites stay correct
      // while gaining hierarchy + default-deny. Without an authorizer wired
      // (legacy harnesses) `enforce` keeps using the flat role map.
      if (authorizer) {
        const headerTenant = headerValue(request.headers, "x-tenant-id");
        const defaultTenantId =
          headerTenant && isUuid(headerTenant)
            ? headerTenant
            : principal.tenantId;
        try {
          principal.authorize = await authorizer.authorizeClosure(
            {
              id: principal.id,
              type: principal.type,
              tenantId: principal.tenantId,
              environment: principal.environment,
              roles: principal.roles
            },
            { defaultTenantId }
          );
          // Session tokens carry NO roles/tenant (grants live in the policy
          // store). Many handlers still scope *which rows to return* by
          // `principal.roles.includes("platform_admin")` and
          // `principal.tenantId`. Reflect the user's resolved grants onto the
          // principal so that data scoping stays correct — derived from stored
          // grants (never spoofable headers); real authz is still Casbin via
          // `enforce`. Dev/API-key principals already carry these.
          if (principal.type === "user" && (!principal.roles || principal.roles.length === 0)) {
            const grants = await authorizer.resolveGrants({
              id: principal.id,
              type: principal.type,
              tenantId: principal.tenantId,
              roles: principal.roles
            });
            // Global-scope roles power the "see everything" superuser branches.
            principal.roles = [
              ...new Set(
                grants
                  .filter((g) => g.scope === "*")
                  .map((g) => g.role)
              )
            ] as Principal["roles"];
            // Bind the selected tenant only when a grant actually covers it,
            // so a tenant-scoped user's list/filter endpoints work for that
            // tenant without letting anyone spoof `x-tenant-id`.
            if (
              !principal.tenantId &&
              defaultTenantId &&
              grants.some((g) =>
                scopeCovers(g.scope, scopeToString({ tenantId: defaultTenantId }))
              )
            ) {
              principal.tenantId = defaultTenantId;
            }
          }
        } catch (e) {
          deps.logger.error("authorizer_failed", {
            error: e instanceof Error ? e.message : String(e)
          });
          return error(500, "internal_error", { message: "authorization unavailable" });
        }
      }
    }

    try {
      const response = await matched.handler({
        request,
        params,
        principal,
        deps
      });
      return response;
    } catch (e) {
      if (e instanceof AuthorizationError) {
        return error(403, "forbidden", { message: e.message });
      }
      if (e instanceof NotFoundError || e instanceof SecretNotFoundError) {
        return error(404, "not_found", { message: e.message });
      }
      if (e instanceof SecretAccessDeniedError) {
        return error(403, "forbidden", { message: e.message });
      }
      if (e instanceof ConflictError) {
        return error(409, "conflict", { message: e.message });
      }
      // A non-UUID value (typically a pipeline slug) reaching a Postgres
      // `uuid` column raises SQLSTATE 22P02 / "invalid input syntax for type
      // uuid". That is bad client input, not a server fault: surface 400, not
      // 500. (The id-or-slug resolver normally prevents this; this is a
      // defense-in-depth backstop for any path that still casts directly.)
      if (isInvalidTextRepresentation(e)) {
        const message = e instanceof Error ? e.message : String(e);
        deps.logger.error("invalid_identifier", {
          path: request.path,
          method: request.method,
          error: message
        });
        return error(400, "invalid_identifier", { message });
      }
      deps.logger.error("unhandled_route_error", {
        path: request.path,
        method: request.method,
        error: e instanceof Error ? e.message : String(e)
      });
      return error(500, "internal_error", {
        message: e instanceof Error ? e.message : String(e)
      });
    }
  }

  return { handle };
}

