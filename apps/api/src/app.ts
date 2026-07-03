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
  defaultIdentityProviderRegistry,
  randomToken,
  SignupDisabledError,
  AccountDisabledError,
  EmailInUseError,
  WebhookTokenService,
  InvalidWebhookTokenError,
  type IdentityProviderRegistry,
  type SsoProviderInstance,
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
  InMemoryConnectionRepository,
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
  type ConnectionRepository,
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
  clientIp,
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
import { registerFoldersRoutes } from "./app/routes/folders.ts";
import { registerConfigRoutes } from "./app/routes/config.ts";
import { registerSchedulesRoutes } from "./app/routes/schedules.ts";
import { registerDatasetsRoutes } from "./app/routes/datasets.ts";
import { registerConnectionsRoutes } from "./app/routes/connections.ts";
import { registerPipelineBindingsRoutes } from "./app/routes/pipeline-bindings.ts";
import { registerTenantPipelinesRoutes } from "./app/routes/tenant-pipelines.ts";
import { registerPipelinesRoutes } from "./app/routes/pipelines.ts";
import { registerPipelineRunsRoutes } from "./app/routes/pipeline-runs.ts";
import { buildApiDatasetResolver } from "./app/pipeline-execution.ts";
import {
  publicUser,
  publicApiKey,
  publicIdp,
  requestOrigin,
  webRedirect
} from "./app/projections.ts";
import { effectiveCatalog as effectiveCatalogFn } from "./app/rbac-helpers.ts";
import { registerAuthRoutes } from "./app/routes/auth.ts";
import { registerApiKeysRoutes } from "./app/routes/api-keys.ts";
import { registerAuthSsoRoutes } from "./app/routes/auth-sso.ts";
import { registerUsersRoutes } from "./app/routes/users.ts";
import { registerRolesRoutes } from "./app/routes/roles.ts";
import { registerIdentityProvidersRoutes } from "./app/routes/identity-providers.ts";
import { registerAuthSettingsRoutes } from "./app/routes/auth-settings.ts";

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
  const connections: ConnectionRepository =
    deps.connections ?? new InMemoryConnectionRepository();
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
      sourceIp: clientIp(ctx.request.headers) ?? null,
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
    // Platform-plugin emission (ADR 0036): the SAME mutation, as a durable
    // `post` PlatformEvent, so hooks can trap any audited action. Fire-and-
    // forget; the emitter never throws. (pre-lane interception of mutations
    // is Phase 2.)
    deps.platformEmitter?.({
      id: randomUUID(),
      correlationId:
        headerValue(ctx.request.headers, "x-request-id") ?? targetId,
      event: action,
      phase: "post",
      category: "mutation",
      at,
      actor: { id: actorId ?? "system", type: ctx.principal.type, tenantId: tenantId ?? undefined },
      tenantId,
      target: { type: targetType, id: targetId },
      ...(SENSITIVE_ACTIONS[action]
        ? { requiredPermission: SENSITIVE_ACTIONS[action] }
        : {}),
      requestId: headerValue(ctx.request.headers, "x-request-id") ?? undefined,
      sourceIp: clientIp(ctx.request.headers) ?? undefined,
      userAgent: headerValue(ctx.request.headers, "user-agent") ?? undefined,
      before: before === undefined ? undefined : redactValue(before),
      after: after === undefined ? undefined : redactValue(after)
    });
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


  registerHealthRoutes({ route }, { pool: deps.pool, queue: deps.queue });

  registerTenantsRoutes({ route }, { deps, audit, environments, rbacPolicies });

  registerPipelinesRoutes({ route }, { deps, audit, pipelineFolders, tenantScope });
  registerFoldersRoutes({ route }, { pipelineFolders, pipelines: deps.pipelines, audit });


  registerTenantPipelinesRoutes({ route }, { deps, audit, tenantPipelines, pipelineActivations });

  registerSchedulesRoutes({ route }, { schedules, audit });
  registerConfigRoutes({ route }, { deps, audit });

  registerDatasetsRoutes({ route }, { deps, audit, datasets, datasetVersions, datasetAliases, environments, pipelines: deps.pipelines, pipelineVersions: deps.pipelineVersions, tenantScope });

  // ADR-0023 Unified Connections Registry. Routes at /api/connections
  // are the single CRUD surface; old /api/external-connections is gone
  // (registerExternalConnectionsRoutes deleted alongside this).
  registerConnectionsRoutes(
    { route },
    {
      deps,
      audit,
      connections,
      environments,
      tenants: deps.tenants,
      tenantScope
    }
  );

  // Per-(pipeline, tenant, env) dataset binding overrides (PR3).
  // Optional dep — legacy harnesses can skip this without breaking
  // anything; the runtime resolver falls through to the default
  // slug cascade when bindings is undefined.
  if (deps.pipelineDatasetBindings) {
    registerPipelineBindingsRoutes(
      { route },
      {
        deps,
        audit,
        bindings: deps.pipelineDatasetBindings,
        datasets: datasets,
        environments,
        pipelines: deps.pipelines,
        tenants: deps.tenants,
        tenantScope
      }
    );
  }

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


  // Build the v2 DatasetResolver the in-process executor uses. Lives
  // next to the registration so the resolver is constructed once.
  const apiDatasetResolver = buildApiDatasetResolver(deps);
  registerPipelineRunsRoutes(
    { route },
    {
      deps,
      audit,
      pipelineActivations,
      webhookTriggers,
      apiDatasetResolver,
      tenantScope
    }
  );


  // ---- auth & access-control ---------------------------------------------
  // Pure helpers + projections live in ./app/projections.ts +
  // ./app/rbac-helpers.ts. `effectiveCatalog` needs the rbacPolicies repo;
  // bind it once here so the inline routes can call it without args.
  const effectiveCatalog = (): Promise<Map<string, Set<string>>> =>
    effectiveCatalogFn(rbacPolicies);
  // Identity-provider SPI (ADR 0035). The registry holds the built-in OIDC +
  // SAML providers by default; server.ts may load a custom provider from
  // RAGDOLL_IDENTITY_PROVIDER and pass its registry in via deps. Resolution
  // is by `row.kind`, so a custom provider can add a new kind (e.g. "ldap")
  // or override oidc/saml without touching the routes.
  const identityProviderRegistry: IdentityProviderRegistry =
    deps.identityProviderRegistry ?? defaultIdentityProviderRegistry();
  function buildSsoProvider(row: IdentityProviderRow): SsoProviderInstance {
    return identityProviderRegistry.build({
      kind: row.kind,
      config: (row.config as Record<string, unknown>) ?? {}
    });
  }

  registerAuthRoutes({ route }, { deps, audit, accounts, passwords, users, rbacPolicies });
  registerApiKeysRoutes({ route }, { deps, audit, apiKeys, environments, rbacPolicies });
  registerAuthSsoRoutes(
    { route },
    {
      deps,
      accounts,
      identityProviders,
      buildSsoProvider,
      ssoStateStore: deps.ssoStateStore
    }
  );
  registerUsersRoutes({ route }, { audit, users, passwords, rbacPolicies, authorizer });
  registerRolesRoutes({ route }, { audit, rbacPolicies, roleCatalog, authorizer });
  registerIdentityProvidersRoutes({ route }, { audit, identityProviders });
  registerAuthSettingsRoutes({ route }, { audit, authSettings });

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

