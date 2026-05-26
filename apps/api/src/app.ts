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
import { registerFoldersRoutes } from "./app/routes/folders.ts";
import { registerConfigRoutes } from "./app/routes/config.ts";
import { registerSchedulesRoutes } from "./app/routes/schedules.ts";
import { registerDatasetsRoutes } from "./app/routes/datasets.ts";
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
import {
  scopeInputFromBody,
  scopeResource,
  defaultPermsFor,
  effectiveCatalog as effectiveCatalogFn
} from "./app/rbac-helpers.ts";

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


  registerHealthRoutes({ route });

  registerTenantsRoutes({ route }, { deps, audit, environments });

  registerPipelinesRoutes({ route }, { deps, audit, pipelineFolders });
  registerFoldersRoutes({ route }, { pipelineFolders, audit });


  registerTenantPipelinesRoutes({ route }, { deps, audit, tenantPipelines, pipelineActivations });

  registerSchedulesRoutes({ route }, { schedules, audit });
  registerConfigRoutes({ route }, { deps, audit });

  registerDatasetsRoutes({ route }, { deps, audit, datasets, datasetVersions, datasetAliases, environments, tenantScope });

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
  // `buildSsoProvider` is closure-internal because OidcProvider /
  // SamlProvider are constructed per IdP row at call time.
  const effectiveCatalog = (): Promise<Map<string, Set<string>>> =>
    effectiveCatalogFn(rbacPolicies);
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

