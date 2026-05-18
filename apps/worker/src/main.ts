/**
 * Production entrypoint for the RAGdoll worker.
 *
 * Selection rules:
 *   - DATABASE_URL set  -> Postgres-backed execution store + usage records
 *                          (control-plane lookups still use in-memory repos
 *                          unless a future Postgres variant is wired); else
 *                          a fully in-memory execution store.
 *   - REDIS_URL set     -> BullMQ consumer bound to `createWorker` handlers;
 *                          else the InMemoryQueue (process exits after a
 *                          readiness log — useful for smoke checks).
 *
 * This module is only imported by `index.ts`'s `import.meta.url` guard, so the
 * offline test suite never loads bullmq / ioredis / pg.
 */

import { InMemoryQueue } from "./index.ts";
import { createWorker, type WorkerDeps, type WorkerRepositories } from "./handlers.ts";
import { loadRegistries } from "../../../packages/plugin-loader/src/index.ts";
import { createVectorStore } from "../../../packages/vector/src/index.ts";
import { getLogger, createTracer } from "../../../packages/observability/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider,
  type SecretProvider
} from "../../../packages/secrets/src/index.ts";
import {
  InMemoryExecutionStore,
  InMemoryPipelineVersionRepository,
  InMemoryConfigDefinitionRepository,
  InMemoryConfigValueRepository,
  InMemoryProviderRepository,
  InMemoryProviderModelRepository,
  InMemoryVectorCollectionRepository,
  InMemoryDatasourceConnectionRepository,
  InMemoryUsageRecordRepository
} from "../../../packages/db/src/index.ts";
import type { ExecutionStore } from "../../../packages/runtime/src/index.ts";

async function buildDeps(): Promise<WorkerDeps> {
  const logger = getLogger();
  const { plugins, providers } = loadRegistries();
  const tracer = await createTracer({ enabled: process.env.OTEL_ENABLED !== "false" });
  const vectorStore = createVectorStore({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY
  });

  const repositories: WorkerRepositories = {
    pipelineVersions: new InMemoryPipelineVersionRepository(),
    configDefinitions: new InMemoryConfigDefinitionRepository(),
    configValues: new InMemoryConfigValueRepository(),
    providers: new InMemoryProviderRepository(),
    providerModels: new InMemoryProviderModelRepository(),
    vectorCollections: new InMemoryVectorCollectionRepository(),
    datasourceConnections: new InMemoryDatasourceConnectionRepository(),
    usageRecords: new InMemoryUsageRecordRepository()
  };

  const secretProvider: SecretProvider = new DatabaseEncryptedSecretProvider(
    new InMemorySecretRepository(),
    new StaticKeyProvider(process.env.SECRET_ENCRYPTION_KEY ?? "dev-secret")
  );

  let store: ExecutionStore;
  // Mirror runtime usage into the control-plane UsageRecordRepository ONLY in
  // the in-memory wiring. PostgresExecutionStore.recordUsage already writes
  // the shared usage_records table that a Postgres UsageRecordRepository
  // reads, so mirroring there would double-insert. Off in Postgres mode keeps
  // exactly one usage write per (executionId, provider, model).
  let mirrorUsageToRepository = false;
  if (process.env.DATABASE_URL) {
    // Postgres-backed execution store; migrations are owned by the migrate
    // tool / API. We only wire the runtime store + usage here.
    const { createPool, PostgresExecutionStore } = await import(
      "../../../packages/db/src/index.ts"
    );
    const pool = await createPool({ connectionString: process.env.DATABASE_URL });
    store = new PostgresExecutionStore(pool);
    logger.info("worker using Postgres execution store");
  } else {
    store = new InMemoryExecutionStore();
    mirrorUsageToRepository = true;
    logger.info("worker using in-memory execution store");
  }

  return {
    store,
    plugins,
    providers,
    secretProvider,
    vectorStore,
    repositories,
    tracer,
    logger,
    maxRetries: Number(process.env.WORKER_MAX_RETRIES ?? 1),
    mirrorUsageToRepository
  };
}

export async function main(): Promise<void> {
  const logger = getLogger();
  const deps = await buildDeps();
  const worker = createWorker(deps);

  if (process.env.REDIS_URL) {
    const { startBullMqConsumer } = await import("./bullmq.ts");
    const consumer = await startBullMqConsumer(worker, {
      redisUrl: process.env.REDIS_URL,
      queueName: process.env.WORKER_QUEUE_NAME,
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
      logger
    });
    logger.info("worker consuming BullMQ queue", {
      queue: process.env.WORKER_QUEUE_NAME ?? "ragdoll-jobs"
    });
    const shutdown = async (): Promise<void> => {
      logger.info("worker shutting down");
      await consumer.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    // No Redis: there is no external transport to consume. Expose an
    // InMemoryQueue (mainly used by tests / single-process embedding) and log
    // readiness. The worker remains importable + usable in-process.
    const queue = new InMemoryQueue();
    void queue;
    logger.info("worker ready (in-memory queue; set REDIS_URL for BullMQ)", {
      handlers: [
        "run_pipeline",
        "ingest_datasource",
        "reindex_tenant",
        "evaluate_pipeline",
        "batch_run",
        "delete_tenant_vector_data",
        "rotate_provider_model_metadata",
        "plugin_health_check"
      ]
    });
  }
}
