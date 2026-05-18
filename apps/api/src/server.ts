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
import { createApp, type AppDeps, type ReadableExecutionStore } from "./app.ts";
import {
  AuthResolver,
  DevAuthProvider,
  ApiKeyService,
  SessionTokenService
} from "../../../packages/auth/src/index.ts";
import {
  createPool,
  runMigrations,
  defaultMigrationsDir,
  PostgresExecutionStore,
  PostgresSecretRepository,
  PostgresTenantRepository,
  PostgresPipelineVersionRepository,
  PostgresPipelineDeploymentRepository,
  PostgresConfigValueRepository,
  PostgresAuditLogRepository,
  PostgresUsageRecordRepository,
  PostgresApiKeyRepository,
  InMemoryTenantRepository,
  InMemoryPipelineRepository,
  InMemoryPipelineVersionRepository,
  InMemoryPipelineDeploymentRepository,
  InMemoryConfigDefinitionRepository,
  InMemoryConfigValueRepository,
  InMemoryAuditLogRepository,
  InMemoryUsageRecordRepository,
  InMemoryPluginRepository,
  InMemoryProviderRepository,
  InMemoryDatasourceConnectionRepository,
  InMemoryVectorCollectionRepository,
  InMemoryExecutionStore,
  type PoolLike
} from "../../../packages/db/src/index.ts";
import { loadRegistries } from "../../../packages/plugin-loader/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider,
  type SecretRepository
} from "../../../packages/secrets/src/index.ts";
import { getLogger } from "../../../packages/observability/src/index.ts";
import { InMemoryQueue } from "../../../apps/worker/src/index.ts";

async function buildDeps(): Promise<{ deps: AppDeps; pool?: PoolLike }> {
  const logger = getLogger();
  const env = process.env.RAGDOLL_ENV ?? "development";
  const databaseUrl = process.env.DATABASE_URL;
  const { plugins: pluginRegistry, providers: providerRegistry } = loadRegistries();
  const queue = new InMemoryQueue();

  // Auth: dev provider only outside production; session/API-key always wired.
  const sessionSecret = process.env.SESSION_SECRET ?? "dev-insecure-session-secret";
  const sessions = new SessionTokenService(sessionSecret);
  const keyEncryptionSecret =
    process.env.SECRET_ENCRYPTION_KEY ?? "dev-insecure-secret-encryption-key";

  let pool: PoolLike | undefined;
  let secretRepository: SecretRepository;
  let deps: AppDeps;

  if (databaseUrl) {
    pool = await createPool({ connectionString: databaseUrl });
    const migration = await runMigrations(pool, defaultMigrationsDir());
    logger.info("migrations_applied", {
      applied: migration.applied,
      skipped: migration.skipped.length
    });
    secretRepository = new PostgresSecretRepository(pool);
    const apiKeyRepo = new PostgresApiKeyRepository(pool);
    const apiKeys = new ApiKeyService(apiKeyRepo);
    const auth = new AuthResolver({
      sessions,
      apiKeys,
      dev: env === "production" ? undefined : new DevAuthProvider()
    });
    deps = {
      tenants: new PostgresTenantRepository(pool),
      // No Postgres repos exist for these entities yet; use InMemory.
      pipelines: new InMemoryPipelineRepository(),
      pipelineVersions: new PostgresPipelineVersionRepository(pool),
      deployments: new PostgresPipelineDeploymentRepository(pool),
      configDefinitions: new InMemoryConfigDefinitionRepository(),
      configValues: new PostgresConfigValueRepository(pool),
      auditLogs: new PostgresAuditLogRepository(pool),
      usageRecords: new PostgresUsageRecordRepository(pool),
      plugins: new InMemoryPluginRepository(),
      providers: new InMemoryProviderRepository(),
      datasources: new InMemoryDatasourceConnectionRepository(),
      vectorCollections: new InMemoryVectorCollectionRepository(),
      // PostgresExecutionStore is write-only; expose an InMemory reader for the
      // control-plane read paths until a Postgres execution reader exists.
      executionStore: new InMemoryExecutionStore() as ReadableExecutionStore,
      auth,
      queue,
      secretProvider: new DatabaseEncryptedSecretProvider(
        secretRepository,
        new StaticKeyProvider(keyEncryptionSecret)
      ),
      pluginRegistry,
      providerRegistry,
      logger,
      env
    };
    // Touch PostgresExecutionStore so the symbol stays referenced for ops that
    // wire a real reader in future; not used on the read path here.
    void PostgresExecutionStore;
  } else {
    secretRepository = new InMemorySecretRepository();
    const { InMemoryApiKeyRepository } = await import(
      "../../../packages/db/src/index.ts"
    );
    const apiKeys = new ApiKeyService(new InMemoryApiKeyRepository());
    const auth = new AuthResolver({
      sessions,
      apiKeys,
      dev: env === "production" ? undefined : new DevAuthProvider()
    });
    deps = {
      tenants: new InMemoryTenantRepository(),
      pipelines: new InMemoryPipelineRepository(),
      pipelineVersions: new InMemoryPipelineVersionRepository(),
      deployments: new InMemoryPipelineDeploymentRepository(),
      configDefinitions: new InMemoryConfigDefinitionRepository(),
      configValues: new InMemoryConfigValueRepository(),
      auditLogs: new InMemoryAuditLogRepository(),
      usageRecords: new InMemoryUsageRecordRepository(),
      plugins: new InMemoryPluginRepository(),
      providers: new InMemoryProviderRepository(),
      datasources: new InMemoryDatasourceConnectionRepository(),
      vectorCollections: new InMemoryVectorCollectionRepository(),
      executionStore: new InMemoryExecutionStore(),
      auth,
      queue,
      secretProvider: new DatabaseEncryptedSecretProvider(
        secretRepository,
        new StaticKeyProvider(keyEncryptionSecret)
      ),
      pluginRegistry,
      providerRegistry,
      logger,
      env
    };
  }

  return { deps, pool };
}

async function main(): Promise<void> {
  const logger = getLogger();
  const { deps, pool } = await buildDeps();
  const app = createApp(deps);

  const fastify = Fastify({ logger: false });

  // Capture the raw body for all routes; the app does its own parsing.
  fastify.addContentTypeParser(
    "*",
    { parseAs: "string" },
    (_request: any, body: any, done: any) => done(null, body)
  );

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

    const response = await app.handle({
      method: request.method,
      path: url.pathname,
      query,
      headers: { ...request.headers, "x-request-id": requestId },
      body: parsedBody
    });

    reply.header("x-request-id", requestId);
    for (const [k, v] of Object.entries(response.headers)) reply.header(k, v);
    reply.code(response.status);

    logger.info("request", {
      method: request.method,
      path: url.pathname,
      status: response.status,
      requestId
    });

    if (response.body === undefined) return reply.send();
    if (typeof response.body === "string") return reply.send(response.body);
    return reply.send(response.body);
  });

  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? "0.0.0.0";

  const shutdown = async (): Promise<void> => {
    logger.info("shutting_down", {});
    await fastify.close().catch(() => undefined);
    if (pool) await pool.end().catch(() => undefined);
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
