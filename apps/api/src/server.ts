/**
 * RAGdoll control-plane HTTP server.
 *
 * This is the ONLY file that imports fastify. It builds real dependencies
 * (Postgres-backed repos when DATABASE_URL is set, otherwise InMemory), runs
 * migrations when DATABASE_URL is set, constructs the framework-agnostic app
 * via `createApp`, and adapts Fastify routes onto `app.handle`.
 */
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { createApp, type AppDeps } from "./app.ts";
import { createPlatformEventStream } from "../../worker/src/platform-events.ts";
import { gateWebhookPlugin } from "../../worker/src/platform-webhooks.ts";
import {
  loadPlatformPlugins,
  PlatformEventDispatcher
} from "../../../packages/platform-plugins/src/index.ts";
import { handleMcpRequest } from "./mcp.ts";
import { mountWebsocket } from "./websocket.ts";
import {
  InMemoryChangeBus,
  createRedisChangeBus,
  type ChangeBus
} from "../../../packages/events/src/index.ts";
import {
  AuthResolver,
  ApiKeyService,
  SessionTokenService,
  InMemorySessionRevocationStore,
  Authorizer,
  BuiltinPolicyEngine,
  createCasbinEngine,
  PasswordService,
  InMemorySsoStateStore,
  createRedisSsoStateStore,
  defaultIdentityProviderRegistry,
  loadIdentityProviderModule,
  type PolicyEngine,
  type SsoStateStore
} from "../../../packages/auth/src/index.ts";
import {
  defaultCatalogRows,
  loadAuthzEngine,
  type Role
} from "../../../packages/authz/src/index.ts";
import {
  createPool,
  runMigrations,
  defaultMigrationsDir,
  PostgresExecutionStore,
  PostgresSecretRepository,
  PostgresTenantRepository,
  PostgresEnvironmentRepository,
  PostgresDatasetRepository,
  PostgresDatasetVersionRepository,
  PostgresDatasetAliasRepository,
  PostgresRetentionSettingsRepository,
  PostgresPipelineRepository,
  PostgresPipelineVersionRepository,
  PostgresPipelineDeploymentRepository,
  PostgresPipelineFolderRepository,
  PostgresPipelineActivationRepository,
  PostgresScheduleRepository,
  PostgresTenantPipelineRepository,
  PostgresConfigDefinitionRepository,
  PostgresConfigValueRepository,
  PostgresProviderRepository,
  PostgresConnectionRepository,
  PostgresPipelineDatasetBindingRepository,
  PostgresVectorCollectionRepository,
  PostgresAuditLogRepository,
  PostgresUsageRecordRepository,
  PostgresApiKeyRepository,
  PostgresUserRepository,
  PostgresUserIdentityRepository,
  PostgresIdentityProviderRepository,
  PostgresEventSubscriptionRepository,
  PostgresRbacPolicyRepository,
  PostgresAuthSettingsRepository,
  PostgresRoleRepository,
  PostgresTenantGitConfigRepository,
  PostgresWebhookTriggerRepository,
  InMemoryUserRepository,
  InMemoryUserIdentityRepository,
  InMemoryIdentityProviderRepository,
  InMemoryEventSubscriptionRepository,
  InMemoryRbacPolicyRepository,
  InMemoryAuthSettingsRepository,
  InMemoryRoleRepository,
  InMemoryTenantGitConfigRepository,
  InMemoryWebhookTriggerRepository,
  type RbacPolicyRepository,
  type UserRepository,
  InMemoryTenantRepository,
  InMemoryEnvironmentRepository,
  InMemoryPipelineRepository,
  InMemoryPipelineVersionRepository,
  InMemoryPipelineDeploymentRepository,
  InMemoryPipelineFolderRepository,
  InMemoryPipelineActivationRepository,
  InMemoryScheduleRepository,
  InMemoryTenantPipelineRepository,
  InMemoryConfigDefinitionRepository,
  InMemoryConfigValueRepository,
  InMemoryAuditLogRepository,
  InMemoryUsageRecordRepository,
  InMemoryPluginRepository,
  InMemoryProviderRepository,
  InMemoryConnectionRepository,
  InMemoryPipelineDatasetBindingRepository,
  InMemoryVectorCollectionRepository,
  InMemoryExecutionStore,
  type PoolLike
} from "../../../packages/db/src/index.ts";
import {
  loadRegistries,
  DbPluginSourceStore,
  InMemoryPluginSourceStore
} from "../../../packages/plugin-loader/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider,
  type SecretRepository
} from "../../../packages/secrets/src/index.ts";
import {
  getLogger,
  getMeter,
  wireOtelLogs,
  wireOtelMetrics,
  wireOtelTraces
} from "../../../packages/observability/src/index.ts";
import { InMemoryQueue, type QueuePort } from "../../../apps/worker/src/index.ts";

/**
 * Idempotent first-run setup: seed the role->permission catalog from the
 * built-in defaults when the store is empty (so the admin UI starts from a
 * sane, editable baseline), and provision the first platform admin from
 * BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD when there is no usable
 * account yet. Safe to run on every boot.
 */
async function bootstrapAccessControl(
  rbac: RbacPolicyRepository,
  users: UserRepository,
  logger: ReturnType<typeof getLogger>
): Promise<void> {
  // Idempotent union: always re-apply the default catalog rows. The
  // `addRolePermission` call uses `ON CONFLICT DO NOTHING`, so this is
  // safe to run on every boot. We had a real bug where migration 010
  // pre-seeded the dataset permissions, which left the table non-empty
  // before the API ever booted — the previous `existing.length === 0`
  // guard then skipped seeding everything else, leaving platform_admin
  // with only the dataset permissions and operators staring at
  // `HTTP 403: missing permission execution:view_logs` on a fresh stack.
  const rows = defaultCatalogRows();
  const before = (await rbac.listRolePermissions()).length;
  for (const row of rows) await rbac.addRolePermission(row);
  const after = (await rbac.listRolePermissions()).length;
  if (after !== before) {
    logger.info("rbac_catalog_seeded", { added: after - before, total: after });
  }

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) return;
  if (await users.findByEmail(email)) return;
  const now = new Date().toISOString();
  const user = await users.create({
    id: randomUUID(),
    email,
    displayName: "Bootstrap Admin",
    passwordHash: await new PasswordService().hash(password),
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  await rbac.addGrant({
    id: randomUUID(),
    userId: user.id,
    role: "platform_admin",
    scope: "*",
    createdAt: now
  });
  logger.info("bootstrap_admin_created", { email });
}

async function buildDeps(): Promise<{
  deps: AppDeps;
  pool?: PoolLike;
  changeBus: ChangeBus;
}> {
  const logger = getLogger();
  const env = process.env.RAGDOLL_ENV ?? "development";
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  // The change-event bus underpins /api/events. Redis when configured so it
  // fans out across replicas AND lets the worker publish execution events;
  // in-process otherwise (single-replica local / tests).
  const changeBus: ChangeBus = redisUrl
    ? await createRedisChangeBus({ redisUrl, logger })
    : new InMemoryChangeBus({ logger });
  logger.info("change_bus_ready", {
    transport: redisUrl ? "redis" : "in-process"
  });
  // SSO state store: Redis when configured so a callback that lands on
  // a different api pod than the start step still finds the entry.
  // In-process otherwise (single-pod / tests). 10-minute TTL enforced
  // server-side via Redis EX.
  const ssoStateStore: SsoStateStore = redisUrl
    ? await createRedisSsoStateStore({ redisUrl })
    : new InMemorySsoStateStore();
  logger.info("sso_state_store_ready", {
    transport: redisUrl ? "redis" : "in-process"
  });
  const { plugins: pluginRegistry, providers: providerRegistry } = loadRegistries();
  // PLUGIN-ARCH-1: holder + source store light up the
  // /api/plugins/sources + /api/plugins/refresh endpoints. The holder
  // initially wraps the SAME `pluginRegistry` produced above so the
  // first request after boot sees the same plugin set the sync loader
  // produced. Refresh rebuilds from the source store + atomically
  // swaps; the prior registry is intact for any in-flight execution.
  let pluginRegistryHolder: import(
    "../../../packages/plugin-loader/src/index.ts"
  ).PluginRegistryHolder | undefined;
  let pluginSourceStore: import(
    "../../../packages/plugin-loader/src/index.ts"
  ).PluginSourceStore | undefined;
  // When NATS_URL is set, enqueue onto the SAME JetStream work-queue the
  // separate worker container consumes (both default to "ragdoll-jobs");
  // otherwise an in-process queue. The NATS client is lazy-imported so
  // `npm test` stays install-free. (Redis still backs the change bus / SSO
  // state store above — only the JOB queue moved to NATS.)
  const natsUrl = process.env.NATS_URL;
  let queue: QueuePort;
  if (natsUrl) {
    const { NatsJetStreamQueue } = await import(
      "../../../apps/worker/src/nats.ts"
    );
    queue = new NatsJetStreamQueue({
      natsUrl,
      queueName: process.env.WORKER_QUEUE_NAME
    });
    logger.info("api using NATS JetStream queue", {
      queue: process.env.WORKER_QUEUE_NAME ?? "ragdoll-jobs"
    });
  } else {
    queue = new InMemoryQueue();
  }

  // Auth: session tokens + API keys. The historical header-trusting
  // DevAuthProvider was removed in Phase 12 of the dataset/RBAC/retrieval
  // refactor — every caller now authenticates via a real Bearer token or
  // a `rgd_…` API key. Local developers use the bootstrap admin user
  // (BOOTSTRAP_ADMIN_EMAIL/PASSWORD env, default admin@ragdoll.local /
  // ragdoll-admin) and mint a per-machine API key from the Profile screen.
  // SESSION_SECRET and SECRET_ENCRYPTION_KEY MUST be explicitly set in
  // production — the dev defaults are publicly known and a process that
  // boots with them mints forgeable session tokens / decryptable secrets.
  // Fail-closed here so a misconfigured prod deploy crashes on startup
  // instead of silently issuing tokens an attacker can mint themselves.
  const DEV_SESSION_SECRET = "dev-insecure-session-secret";
  const DEV_SECRET_ENCRYPTION_KEY = "dev-insecure-secret-encryption-key";
  const isProd = (process.env.RAGDOLL_ENV ?? process.env.NODE_ENV) === "production";
  const rawSessionSecret = process.env.SESSION_SECRET ?? DEV_SESSION_SECRET;
  const rawKeyEncryptionSecret =
    process.env.SECRET_ENCRYPTION_KEY ?? DEV_SECRET_ENCRYPTION_KEY;
  if (isProd && rawSessionSecret === DEV_SESSION_SECRET) {
    throw new Error(
      "SESSION_SECRET must be set (and not equal to the dev default) when RAGDOLL_ENV=production"
    );
  }
  if (isProd && rawKeyEncryptionSecret === DEV_SECRET_ENCRYPTION_KEY) {
    throw new Error(
      "SECRET_ENCRYPTION_KEY must be set (and not equal to the dev default) when RAGDOLL_ENV=production"
    );
  }
  if (!isProd && rawSessionSecret === DEV_SESSION_SECRET) {
    logger.warn("session_secret_dev_default", {
      message:
        "SESSION_SECRET is the dev default — fine for local development, NEVER ship this to staging/prod (server will refuse to boot when RAGDOLL_ENV=production)"
    });
  }
  const sessionSecret = rawSessionSecret;
  // ADR-0011: in-memory revocation store by default. A Redis-backed
  // adapter (so /logout on one pod revokes the token everywhere) would
  // plug in here when REDIS_URL is set; the implementation lives with
  // the rest of the ioredis-shaped code paths and is wired below if
  // present. The in-memory version is correct for single-pod deploys.
  const revocationStore = new InMemorySessionRevocationStore();
  const sessions = new SessionTokenService(sessionSecret, revocationStore);
  if (process.env.RAGDOLL_DEV_AUTH === "1") {
    logger.warn("dev_auth_removed", {
      message:
        "RAGDOLL_DEV_AUTH=1 is no longer supported. Sign in with the bootstrap admin (admin@ragdoll.local / ragdoll-admin) and mint an API key under Profile → API keys."
    });
  }
  const keyEncryptionSecret = rawKeyEncryptionSecret;

  let pool: PoolLike | undefined;
  let secretRepository: SecretRepository;
  let deps: AppDeps;
  // Captured from whichever persistence branch runs, for the post-step that
  // builds the authorizer and bootstraps the catalog / first admin.
  let rbacForAuthz: RbacPolicyRepository;
  let usersForBootstrap: UserRepository;

  if (databaseUrl) {
    pool = await createPool({ connectionString: databaseUrl });
    // PLUGIN-ARCH-1: bind the DB-backed source store to the same
    // pool the rest of the API uses. Holder rebuild on /refresh.
    pluginSourceStore = new DbPluginSourceStore(pool);
    const executionStore = new PostgresExecutionStore(pool);
    const migration = await runMigrations(pool, defaultMigrationsDir());
    logger.info("migrations_applied", {
      applied: migration.applied,
      skipped: migration.skipped.length
    });
    secretRepository = new PostgresSecretRepository(pool);
    const apiKeyRepo = new PostgresApiKeyRepository(pool);
    const rbacPolicies = new PostgresRbacPolicyRepository(pool);
    const users = new PostgresUserRepository(pool);
    // ADR-0011 / Phase 13 follow-through: hand ApiKeyService closures
    // over the live user + rbac stores so verify() can reject keys for
    // disabled users AND intersect the mint-time role snapshot with the
    // user's CURRENT grants (so a demoted user loses powers immediately).
    const apiKeys = new ApiKeyService(apiKeyRepo, {
      accountStatus: async (principalId) =>
        (await users.get(principalId))?.status,
      currentRoles: async (principalId) => {
        const grants = await rbacPolicies.listGrantsForUser(principalId);
        return [...new Set(grants.map((g) => g.role))] as Role[];
      }
    });
    const auth = new AuthResolver({ sessions, apiKeys });
    deps = {
      tenants: new PostgresTenantRepository(pool),
      users,
      userIdentities: new PostgresUserIdentityRepository(pool),
      identityProviders: new PostgresIdentityProviderRepository(pool),
      eventSubscriptions: new PostgresEventSubscriptionRepository(pool),
      rbacPolicies,
      authSettings: new PostgresAuthSettingsRepository(pool),
      roles: new PostgresRoleRepository(pool),
      webhookTriggers: new PostgresWebhookTriggerRepository(pool),
      tenantGitConfigs: new PostgresTenantGitConfigRepository(pool),
      environments: new PostgresEnvironmentRepository(pool),
      datasets: new PostgresDatasetRepository(pool),
      datasetVersions: new PostgresDatasetVersionRepository(pool),
      datasetAliases: new PostgresDatasetAliasRepository(pool),
      retentionSettings: new PostgresRetentionSettingsRepository(pool),
      pipelines: new PostgresPipelineRepository(pool),
      pipelineVersions: new PostgresPipelineVersionRepository(pool),
      deployments: new PostgresPipelineDeploymentRepository(pool),
      pipelineFolders: new PostgresPipelineFolderRepository(pool),
      pipelineActivations: new PostgresPipelineActivationRepository(pool),
      schedules: new PostgresScheduleRepository(pool),
      // Tenant<->pipeline associations are now durably Postgres-backed
      // (composite-key ON CONFLICT upsert), matching the sibling Postgres
      // repos so associations survive process restarts in Postgres mode.
      tenantPipelines: new PostgresTenantPipelineRepository(pool),
      configDefinitions: new PostgresConfigDefinitionRepository(pool),
      configValues: new PostgresConfigValueRepository(pool),
      auditLogs: new PostgresAuditLogRepository(pool),
      usageRecords: new PostgresUsageRecordRepository(pool),
      // No control-plane plugin registry table is read on the API path; the
      // in-process plugin registry below is the source of truth for /plugins.
      plugins: new InMemoryPluginRepository(),
      providers: new PostgresProviderRepository(pool),
      connections: new PostgresConnectionRepository(pool),
      pipelineDatasetBindings: new PostgresPipelineDatasetBindingRepository(pool),
      vectorCollections: new PostgresVectorCollectionRepository(pool),
      // Single Postgres store: the worker writes executions here and the
      // control-plane read routes query the same tables, so GET
      // /api/executions/:id reflects worker runs.
      executionStore,
      auth,
      apiKeys,
      changeBus,
      ssoStateStore,
      sessions,
      queue,
      secretProvider: new DatabaseEncryptedSecretProvider(
        secretRepository,
        new StaticKeyProvider(keyEncryptionSecret)
      ),
      pluginRegistry,
      pluginRegistryHolder,
      pluginSourceStore,
      providerRegistry,
      logger,
      env,
      pool
    };
    rbacForAuthz = rbacPolicies;
    usersForBootstrap = users;
  } else {
    secretRepository = new InMemorySecretRepository();
    // PLUGIN-ARCH-1: in-memory deployments still get a working holder
    // + store so the refresh endpoint is exercisable in dev /
    // tests. The store starts empty (no external sources), which
    // means refresh is a no-op + always-succeeds — the built-ins
    // reload from the in-tree path.
    pluginSourceStore = new InMemoryPluginSourceStore([]);
    const { InMemoryApiKeyRepository } = await import(
      "../../../packages/db/src/index.ts"
    );
    const apiKeys = new ApiKeyService(new InMemoryApiKeyRepository());
    const auth = new AuthResolver({ sessions, apiKeys });
    const rbacPolicies = new InMemoryRbacPolicyRepository();
    const users = new InMemoryUserRepository();
    deps = {
      tenants: new InMemoryTenantRepository(),
      users,
      userIdentities: new InMemoryUserIdentityRepository(),
      identityProviders: new InMemoryIdentityProviderRepository(),
      eventSubscriptions: new InMemoryEventSubscriptionRepository(),
      rbacPolicies,
      authSettings: new InMemoryAuthSettingsRepository(),
      roles: new InMemoryRoleRepository(),
      webhookTriggers: new InMemoryWebhookTriggerRepository(),
      tenantGitConfigs: new InMemoryTenantGitConfigRepository(),
      environments: new InMemoryEnvironmentRepository(),
      pipelines: new InMemoryPipelineRepository(),
      pipelineVersions: new InMemoryPipelineVersionRepository(),
      deployments: new InMemoryPipelineDeploymentRepository(),
      pipelineFolders: new InMemoryPipelineFolderRepository(),
      pipelineActivations: new InMemoryPipelineActivationRepository(),
      schedules: new InMemoryScheduleRepository(),
      tenantPipelines: new InMemoryTenantPipelineRepository(),
      configDefinitions: new InMemoryConfigDefinitionRepository(),
      configValues: new InMemoryConfigValueRepository(),
      auditLogs: new InMemoryAuditLogRepository(),
      usageRecords: new InMemoryUsageRecordRepository(),
      plugins: new InMemoryPluginRepository(),
      providers: new InMemoryProviderRepository(),
      connections: new InMemoryConnectionRepository(),
      pipelineDatasetBindings: new InMemoryPipelineDatasetBindingRepository(),
      vectorCollections: new InMemoryVectorCollectionRepository(),
      executionStore: new InMemoryExecutionStore(),
      auth,
      apiKeys,
      changeBus,
      ssoStateStore,
      sessions,
      queue,
      secretProvider: new DatabaseEncryptedSecretProvider(
        secretRepository,
        new StaticKeyProvider(keyEncryptionSecret)
      ),
      pluginRegistry,
      pluginRegistryHolder,
      pluginSourceStore,
      providerRegistry,
      logger,
      env
    };
    rbacForAuthz = rbacPolicies;
    usersForBootstrap = users;
  }

  // PLUGIN-ARCH-1: bind the holder + plumb it into deps. The holder
  // initially wraps the sync-loaded registry above so existing
  // routes (which destructure `deps.pluginRegistry`) get the
  // expected plugin set. Refresh rebuilds + swaps via
  // `holder.swap(...)`; routes re-read `deps.pluginRegistry` at
  // request time and see the new pointer.
  if (pluginSourceStore) {
    const { PluginRegistryHolder } = await import(
      "../../../packages/plugin-loader/src/index.ts"
    );
    pluginRegistryHolder = new PluginRegistryHolder(pluginRegistry, []);
    deps.pluginRegistryHolder = pluginRegistryHolder;
    deps.pluginSourceStore = pluginSourceStore;
    // The holder IS a PluginRegistry (extends + delegates). Point
    // `deps.pluginRegistry` at it so routes that still type
    // `PluginRegistry` get the live, swappable instance — old code
    // unchanged, refresh becomes effective the moment the swap lands.
    deps.pluginRegistry = pluginRegistryHolder;
    // PLUGIN-ARCH-2: at boot, PUSH the `host: "sidecar"` plugin_sources
    // rows to the python-plugins sidecar (single source of truth), then
    // discover the resulting plugins back via /manifests so they appear
    // in the builder palette without requiring a manual refresh.
    // Best-effort — a sidecar that's down / on an older image is a
    // silent no-op (the sync load above already registered the
    // hardcoded built-in sidecar manifests).
    try {
      const { pushSidecarSources, registerSidecarGitPlugins } = await import(
        "../../../packages/plugin-loader/src/index.ts"
      );
      const push = await pushSidecarSources(pluginSourceStore);
      if (push.pushed) {
        logger.info("sidecar_sources_pushed", {
          sources: push.report?.sources?.length ?? 0
        });
      } else if (push.reason && push.reason !== "no PYTHON_PLUGIN_URL") {
        logger.warn("sidecar_sources_push_skipped", { reason: push.reason });
      }
      await registerSidecarGitPlugins(pluginRegistry);
    } catch (e) {
      logger.warn("sidecar_git_plugin_discovery_failed", {
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  // --- Authorizer (ADR 0035). A custom authorization provider from an
  // external repo loads at boot from RAGDOLL_AUTHZ_PROVIDER (a module that
  // exports a PolicyEngine or a factory). Unset → the built-in resolution:
  // real Casbin when importable, else the equivalent dependency-free engine.
  // Bound to the live policy store so role/grant edits (and revocations) take
  // effect on the next request.
  //
  // In production we REQUIRE Casbin for the BUILT-IN path — a silent fallback
  // would let a misconfigured deploy drift to a different decision engine with
  // no signal. Operators opt out with RAGDOLL_AUTHZ_ALLOW_BUILTIN=1. A
  // configured custom provider that fails to load is ALWAYS fatal (fail-closed)
  // — never silently fall back to a different engine.
  const builtinAuthzEngine = async (): Promise<{
    engine: PolicyEngine;
    source: string;
  }> => {
    try {
      return { engine: await createCasbinEngine(), source: "casbin" };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (isProd && process.env.RAGDOLL_AUTHZ_ALLOW_BUILTIN !== "1") {
        throw new Error(
          `Casbin authz engine failed to load in production: ${reason}. ` +
            "Set RAGDOLL_AUTHZ_ALLOW_BUILTIN=1 to allow the dependency-free fallback."
        );
      }
      logger.warn("authz_engine_fallback", {
        engine: "builtin",
        reason,
        message:
          "using built-in policy engine (Casbin unavailable). Decisions are equivalent but you lose Casbin-specific tooling."
      });
      return { engine: new BuiltinPolicyEngine(), source: "builtin" };
    }
  };
  let authz: { engine: PolicyEngine; source: string };
  try {
    authz = await loadAuthzEngine({
      moduleUrl: process.env.RAGDOLL_AUTHZ_PROVIDER,
      fallback: builtinAuthzEngine
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // Re-throw the Casbin-in-prod guard untouched; wrap a custom-provider
    // failure with a clearer message. Either way boot fails closed.
    if (process.env.RAGDOLL_AUTHZ_PROVIDER) {
      throw new Error(
        `RAGDOLL_AUTHZ_PROVIDER failed to load: ${reason}. ` +
          "Fix the module or unset it to use the built-in engine."
      );
    }
    throw e;
  }
  logger.info("authz_engine", { engine: authz.source });
  deps.authorizer = new Authorizer({ engine: authz.engine, store: rbacForAuthz });

  // --- Identity-provider SPI (ADR 0035). Built-in OIDC + SAML by default;
  // a custom identity provider from an external repo is loaded once at boot
  // from RAGDOLL_IDENTITY_PROVIDER (a package name or module path) and may
  // add a new kind (e.g. "ldap") or override the built-ins. Fail-closed in
  // production: a configured-but-unloadable provider crashes boot rather
  // than silently falling back to the built-ins.
  const identityProviderRegistry = defaultIdentityProviderRegistry();
  try {
    const idpLoad = await loadIdentityProviderModule(
      identityProviderRegistry,
      process.env.RAGDOLL_IDENTITY_PROVIDER
    );
    if (idpLoad.loaded) {
      logger.info("identity_provider_loaded", {
        module: process.env.RAGDOLL_IDENTITY_PROVIDER,
        kinds: idpLoad.kinds
      });
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `RAGDOLL_IDENTITY_PROVIDER failed to load: ${reason}. ` +
        "Fix the module or unset it to use the built-in OIDC/SAML providers."
    );
  }
  deps.identityProviderRegistry = identityProviderRegistry;

  // Platform-plugin emission + interception (ADR 0036). Emission is
  // publish-only on the API — the worker runs the OBSERVER consumer, so
  // arbitrary post-hook logic stays off the API request path. But the API
  // loads the same RAGDOLL_PLATFORM_PLUGINS registry to run synchronous PRE
  // interceptors inline: `execution.accept` (enqueue gate) + mutation vetoes.
  const platformEventStream = createPlatformEventStream({ natsUrl, logger });
  deps.platformEmitter = (event) => platformEventStream.publish(event);
  try {
    const { registry: platformRegistry, loaded: platformModules } =
      await loadPlatformPlugins();
    // Built-in: synchronous gate webhooks run in the API's PRE lane so a
    // per-tenant webhook can veto a mutation / execution.accept (→ 4xx).
    if (deps.eventSubscriptions) {
      platformRegistry.register(
        gateWebhookPlugin(deps.eventSubscriptions, logger)
      );
    }
    deps.platformDispatcher = new PlatformEventDispatcher(platformRegistry, {
      logger
    });
    if (platformModules.length) {
      logger.info("platform_plugins_loaded", {
        modules: platformModules,
        plugins: platformRegistry.list().map((p) => p.name)
      });
    }
  } catch (e) {
    // A broken module must not take the API down; run without interceptors.
    logger.error("platform_plugins_load_failed", {
      error: e instanceof Error ? e.message : String(e)
    });
  }

  await bootstrapAccessControl(rbacForAuthz, usersForBootstrap, logger);

  return { deps, pool, changeBus };
}

/**
 * Collapses high-cardinality path segments to stable templates so the
 * `route` metric label doesn't explode. Replaces UUIDs and 16+ hex/base32
 * tokens with `:id`. Anything that doesn't match is kept verbatim, so
 * `/api/pipelines/:id/run` and `/api/audit` both stay readable.
 */
function normalizeRoute(path: string): string {
  const segs = path.split("/").map((s) => {
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
    ) return ":id";
    if (/^[0-9a-zA-Z_-]{16,}$/.test(s) && /\d/.test(s)) return ":id";
    return s;
  });
  return segs.join("/") || "/";
}

async function main(): Promise<void> {
  // Wire OTLP log + metric exporters BEFORE we ask for the logger so the
  // very first startup line ships into Loki/Prometheus. Both calls return
  // a shutdown closure that flushes the batch processors on SIGTERM.
  const stopTraces = await wireOtelTraces({ instrumentationName: "ragdoll-api" });
  const stopLogs = await wireOtelLogs({ instrumentationName: "ragdoll-api" });
  const stopMetrics = await wireOtelMetrics({ instrumentationName: "ragdoll-api" });
  const logger = getLogger();
  const meter = getMeter();
  const requestCounter = meter.counter("ragdoll_api_requests_total", {
    description: "Total HTTP requests handled by the API.",
    unit: "{request}"
  });
  // No `unit: "ms"` here — the OTLP→Prometheus bridge auto-suffixes the
  // exported metric with the unit name, which would produce
  // `..._duration_ms_milliseconds_bucket`. The `_ms` in the metric name
  // already conveys the unit, so the unit hint is intentionally omitted.
  const requestDuration = meter.histogram("ragdoll_api_request_duration_ms", {
    description: "API request duration in milliseconds."
  });
  // Counterpart to the `slow_request` log line — a counter so dashboards
  // can alert on slow-request RATE without grepping logs. Threshold is
  // the same as the log (1000ms) so the two stay in lockstep.
  const slowRequestCounter = meter.counter("ragdoll_api_slow_requests_total", {
    description:
      "API requests that exceeded the slow-request threshold (default 1000ms); see also the slow_request log line.",
    unit: "{request}"
  });
  const { deps, pool, changeBus } = await buildDeps();
  const app = createApp(deps);

  // Body-size cap (Fastify default is 1MB which the catch-all parser below
  // would inherit). Tuned high enough for big crawl payloads / multi-doc
  // ingests but low enough that a runaway client can't OOM the API by
  // streaming /dev/zero into POST /api/pipelines/:id/run.
  // Override with API_BODY_LIMIT_BYTES (e.g. an XML-heavy tenant).
  const bodyLimit = Number(process.env.API_BODY_LIMIT_BYTES) || 8 * 1024 * 1024;
  // trustProxy=true makes Fastify honor X-Forwarded-* for request.ip etc.
  // Required behind an ingress/LB; harmless on a direct connection because
  // those headers are stripped by reverse proxies before they reach us.
  const fastify = Fastify({ logger: false, bodyLimit, trustProxy: true });
  logger.info("fastify_body_limit", { bytes: bodyLimit });

  // ---- Security headers + CORS (lazy imports keep tests install-free) ----
  // Helmet sets X-Content-Type-Options, X-Frame-Options, Strict-Transport-
  // Security, Referrer-Policy, etc. — defaults are sane for a JSON API.
  // CSP is OFF by default because this server is API-only; the web SPA
  // (served separately) sets its own CSP. Override with API_DISABLE_HELMET=1
  // only for debugging.
  if (process.env.API_DISABLE_HELMET !== "1") {
    const helmet = (await import("@fastify/helmet")).default as any;
    await fastify.register(helmet, { contentSecurityPolicy: false });
  }
  // CORS allowlist. Default: no cross-origin (server-to-server callers and
  // the same-origin web build are fine without it). Set CORS_ALLOW_ORIGINS
  // to a CSV of allowed origins, or "*" to allow any (development only).
  const corsOrigins = (process.env.CORS_ALLOW_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (corsOrigins.length > 0) {
    const cors = (await import("@fastify/cors")).default as any;
    const wildcard = corsOrigins.includes("*");
    await fastify.register(cors, {
      origin: wildcard ? true : corsOrigins,
      credentials: !wildcard,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "authorization",
        "x-api-key",
        "x-request-id",
        "content-type",
        "x-ragdoll-tenant"
      ],
      exposedHeaders: ["x-request-id"]
    });
    logger.info("cors_enabled", { origins: corsOrigins });
  }

  // Capture the raw body for all routes; the app does its own parsing.
  // Fastify's bodyLimit (above) is enforced before this parser ever sees
  // the payload, so we don't need a redundant check here.
  fastify.addContentTypeParser(
    "*",
    { parseAs: "string" },
    (_request: any, body: any, done: any) => done(null, body)
  );

  // Live-events WebSocket. Registered BEFORE the framework-agnostic
  // catch-all so the `/api/events` upgrade isn't swallowed by `fastify.all`.
  // Awaited so the plugin is loaded before the route is added (otherwise
  // upgrades fall through to the HTTP handler with a 500).
  await mountWebsocket(fastify, {
    bus: changeBus,
    auth: deps.auth,
    authorizer: deps.authorizer,
    logger
  });

  // MCP transport needs raw req/res (Streamable HTTP, SSE-style), so we
  // register it BEFORE the framework-agnostic catch-all and bypass app.handle.
  // Auth is still resolved by the MCP tools, which invoke app.handle in-process
  // with the original Authorization header attached (so RBAC stays in force).
  fastify.all("/mcp", async (request: any, reply: any) => {
    let parsedBody: unknown;
    const raw = request.body;
    if (typeof raw === "string" && raw.length > 0) {
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        parsedBody = raw;
      }
    } else {
      parsedBody = raw;
    }
    // hijack so fastify doesn't try to send a response after the SDK writes one
    reply.hijack();
    try {
      await handleMcpRequest(app, request.raw, reply.raw, parsedBody);
    } catch (e) {
      logger.error("mcp_request_failed", {
        error: e instanceof Error ? e.message : String(e)
      });
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.end(JSON.stringify({ error: "mcp_failed" }));
      }
    }
  });

  fastify.all("/*", async (request: any, reply: any) => {
    const requestId =
      (request.headers["x-request-id"] as string | undefined) ?? randomUUID();
    let parsedBody: unknown;
    const raw = request.body;
    if (typeof raw === "string" && raw.length > 0) {
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        parsedBody = raw;
      }
    } else {
      parsedBody = raw;
    }

    const url = new URL(request.url, "http://localhost");
    const query: Record<string, string | undefined> = {};
    for (const [k, v] of url.searchParams.entries()) query[k] = v;

    const startNs = process.hrtime.bigint();
    const response = await app.handle({
      method: request.method,
      path: url.pathname,
      query,
      headers: { ...request.headers, "x-request-id": requestId },
      body: parsedBody
    });
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;

    reply.header("x-request-id", requestId);
    for (const [k, v] of Object.entries(response.headers)) reply.header(k, v);
    reply.code(response.status);

    // Per-request metrics: counter + histogram, both keyed by a normalized
    // route so high-cardinality ids don't blow up Prometheus labels.
    const route = normalizeRoute(url.pathname);
    const metricLabels = {
      method: request.method as string,
      route,
      status: String(response.status)
    };
    requestCounter.add(1, metricLabels);
    requestDuration.record(durationMs, metricLabels);

    // Severity scales with outcome: 4xx is a warn, 5xx an error, slow but
    // successful requests are warn'd separately so dashboards can alert on
    // a slow-but-ok rate. Default-deny 401/403 are common during dev so
    // they stay info; everything else 4xx escalates.
    const status = response.status;
    const slow = durationMs > 1000;
    const fields = {
      method: request.method,
      path: url.pathname,
      route,
      status,
      duration_ms: Math.round(durationMs),
      requestId
    };
    if (status >= 500) {
      logger.error("request_failed", fields);
    } else if (status >= 400 && status !== 401 && status !== 403) {
      logger.warn("request_client_error", fields);
    } else if (slow) {
      logger.warn("slow_request", { ...fields, threshold_ms: 1000 });
    } else {
      logger.info("request", fields);
    }
    if (slow) {
      slowRequestCounter.add(1, metricLabels);
    }

    if (response.body === undefined) return reply.send();
    if (typeof response.body === "string") return reply.send(response.body);
    // Phase 13: real chunked delivery for async-iterable bodies (the
    // /stream SSE route uses this). Detection is duck-typed on
    // Symbol.asyncIterator so any AsyncGenerator / AsyncIterable works
    // without a separate response type.
    if (
      response.body &&
      typeof response.body === "object" &&
      typeof (response.body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
    ) {
      reply.hijack();
      reply.raw.statusCode = response.status;
      reply.raw.setHeader("x-request-id", requestId);
      for (const [k, v] of Object.entries(response.headers)) {
        reply.raw.setHeader(k, v);
      }
      try {
        for await (const chunk of response.body as AsyncIterable<string>) {
          if (!reply.raw.write(chunk)) {
            // Respect backpressure: wait for the drain event so we don't
            // pile up bytes in the kernel send buffer on slow consumers.
            await new Promise<void>((resolve) => reply.raw.once("drain", resolve));
          }
        }
      } catch (e) {
        logger.error("stream_failed", {
          error: e instanceof Error ? e.message : String(e),
          requestId
        });
      } finally {
        reply.raw.end();
      }
      return;
    }
    return reply.send(response.body);
  });

  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? "0.0.0.0";

  const shutdown = async (): Promise<void> => {
    logger.info("shutting_down", {});
    await fastify.close().catch(() => undefined);
    if (pool) await pool.end().catch(() => undefined);
    // Flush metric + log + trace batches before the process dies so the last
    // few seconds of telemetry actually reach the collector.
    await stopMetrics().catch(() => undefined);
    await stopLogs().catch(() => undefined);
    await stopTraces().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await fastify.listen({ port, host });
  logger.info("api_listening", {
    port,
    env: process.env.RAGDOLL_ENV ?? "development",
    persistence: process.env.DATABASE_URL ? "postgres" : "in_memory"
  });
}

main().catch((error) => {
  getLogger().error("api_fatal", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
