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
import type { QueuePort } from "./index.ts";
import { createWorker, type WorkerDeps, type WorkerRepositories } from "./handlers.ts";
import {
  InMemoryChangeBus,
  createRedisChangeBus,
  type ChangeBus
} from "../../../packages/events/src/index.ts";
import { createScheduler } from "./scheduler.ts";
import { createPostgresSystemSweeps } from "./systemSweeps.ts";
import { startOllamaWarmer } from "./ollama-warmer.ts";
import { loadRegistries } from "../../../packages/plugin-loader/src/index.ts";
import { createVectorStore } from "../../../packages/vector/src/index.ts";
import {
  createTracer,
  getLogger,
  getMeter,
  wireOtelLogs,
  wireOtelMetrics,
  wireOtelTraces
} from "../../../packages/observability/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider,
  type SecretProvider
} from "../../../packages/secrets/src/index.ts";
import * as db from "../../../packages/db/src/index.ts";
import {
  InMemoryExecutionStore,
  InMemoryPipelineRepository,
  InMemoryPipelineVersionRepository,
  InMemoryPipelineActivationRepository,
  InMemoryConfigDefinitionRepository,
  InMemoryConfigValueRepository,
  InMemoryProviderRepository,
  InMemoryProviderModelRepository,
  InMemoryVectorCollectionRepository,
  InMemoryDatasourceConnectionRepository,
  InMemoryUsageRecordRepository,
  InMemoryScheduleRepository
} from "../../../packages/db/src/index.ts";
import type { ScheduleRepository } from "../../../packages/db/src/index.ts";
import type { ExecutionStore, IngestStateRepository } from "../../../packages/runtime/src/index.ts";

interface BuiltDeps {
  deps: WorkerDeps;
  /**
   * Schedule repository the cron scheduler scans. Same backend selection as
   * the control-plane repositories (Postgres when DATABASE_URL else InMemory).
   */
  schedules: ScheduleRepository;
}

async function buildDeps(): Promise<BuiltDeps> {
  const logger = getLogger();
  const { plugins, providers } = loadRegistries();
  const tracer = await createTracer({ enabled: process.env.OTEL_ENABLED !== "false" });
  const meter = getMeter();
  const vectorStore = createVectorStore({
    url: process.env.QDRANT_URL,
    apiKey: process.env.QDRANT_API_KEY
  });

  // Control-plane repositories: Postgres-backed when DATABASE_URL is set so the
  // worker reads the SAME seeded pipelines / config / providers the API serves;
  // otherwise fully in-memory (single-process embedding / tests).
  let repositories: WorkerRepositories;
  let secretProvider: SecretProvider;
  let store: ExecutionStore;
  let schedules: ScheduleRepository;
  let ingestStateRepository: IngestStateRepository | undefined;
  // Mirror runtime usage into the control-plane UsageRecordRepository ONLY in
  // the in-memory wiring. PostgresExecutionStore.recordUsage already writes
  // the shared usage_records table that a Postgres UsageRecordRepository
  // reads, so mirroring there would double-insert. Off in Postgres mode keeps
  // exactly one usage write per (executionId, provider, model).
  let mirrorUsageToRepository = false;
  let systemSweeps: ReturnType<typeof createPostgresSystemSweeps> | undefined;
  if (process.env.DATABASE_URL) {
    // Postgres-backed execution store + control-plane repositories so the
    // worker resolves the SAME seeded pipeline versions / config / providers
    // the API serves. Migrations are owned by db-init / the API.
    const pool = await db.createPool({
      connectionString: process.env.DATABASE_URL
    });
    store = new db.PostgresExecutionStore(pool);
    ingestStateRepository = new db.PostgresIngestStateRepository(pool);
    repositories = {
      pipelineVersions: new db.PostgresPipelineVersionRepository(pool),
      configDefinitions: new db.PostgresConfigDefinitionRepository(pool),
      configValues: new db.PostgresConfigValueRepository(pool),
      providers: new db.PostgresProviderRepository(pool),
      providerModels: new db.PostgresProviderModelRepository(pool),
      vectorCollections: new db.PostgresVectorCollectionRepository(pool),
      datasourceConnections: new db.PostgresDatasourceConnectionRepository(
        pool
      ),
      usageRecords: new db.PostgresUsageRecordRepository(pool),
      // Org-versioning resolution for schedule-originated run_pipeline jobs.
      pipelines: new db.PostgresPipelineRepository(pool),
      activations: new db.PostgresPipelineActivationRepository(pool),
      // Phase 5: dataset resolution at executor time.
      datasets: new db.PostgresDatasetRepository(pool),
      datasetVersions: new db.PostgresDatasetVersionRepository(pool),
      datasetAliases: new db.PostgresDatasetAliasRepository(pool)
    };
    schedules = new db.PostgresScheduleRepository(pool);
    systemSweeps = createPostgresSystemSweeps(pool);
    secretProvider = new DatabaseEncryptedSecretProvider(
      new db.PostgresSecretRepository(pool),
      new StaticKeyProvider(process.env.SECRET_ENCRYPTION_KEY ?? "dev-secret")
    );
    logger.info("worker using Postgres execution store + repositories");
  } else {
    store = new InMemoryExecutionStore();
    repositories = {
      pipelineVersions: new InMemoryPipelineVersionRepository(),
      configDefinitions: new InMemoryConfigDefinitionRepository(),
      configValues: new InMemoryConfigValueRepository(),
      providers: new InMemoryProviderRepository(),
      providerModels: new InMemoryProviderModelRepository(),
      vectorCollections: new InMemoryVectorCollectionRepository(),
      datasourceConnections: new InMemoryDatasourceConnectionRepository(),
      usageRecords: new InMemoryUsageRecordRepository(),
      // Org-versioning resolution for schedule-originated run_pipeline jobs.
      pipelines: new InMemoryPipelineRepository(),
      activations: new InMemoryPipelineActivationRepository(),
      // Phase 5: dataset resolution at executor time.
      datasets: new db.InMemoryDatasetRepository(),
      datasetVersions: new db.InMemoryDatasetVersionRepository(),
      datasetAliases: new db.InMemoryDatasetAliasRepository()
    };
    schedules = new InMemoryScheduleRepository();
    secretProvider = new DatabaseEncryptedSecretProvider(
      new InMemorySecretRepository(),
      new StaticKeyProvider(process.env.SECRET_ENCRYPTION_KEY ?? "dev-secret")
    );
    mirrorUsageToRepository = true;
    logger.info("worker using in-memory execution store + repositories");
  }

  // Live-events bus: Redis when configured so worker writes reach the API's
  // /api/events fan-out across replicas; in-memory otherwise (tests / single
  // local process — broadcasts simply have no remote subscriber).
  const redisUrl = process.env.REDIS_URL;
  const changeBus: ChangeBus = redisUrl
    ? await createRedisChangeBus({ redisUrl, logger })
    : new InMemoryChangeBus({ logger });
  logger.info("worker change_bus_ready", {
    transport: redisUrl ? "redis" : "in-process"
  });

  return {
    deps: {
      store,
      plugins,
      providers,
      secretProvider,
      vectorStore,
      repositories,
      tracer,
      meter,
      logger,
      maxRetries: Number(process.env.WORKER_MAX_RETRIES ?? 1),
      mirrorUsageToRepository,
      ingestStateRepository,
      changeBus,
      systemSweeps
    },
    schedules
  };
}

export async function main(): Promise<void> {
  // Wire OTLP log + metric exporters BEFORE we ask for the logger so the
  // very first startup line ships into Loki/Prometheus.
  const stopTraces = await wireOtelTraces({ instrumentationName: "ragdoll-worker" });
  const stopLogs = await wireOtelLogs({ instrumentationName: "ragdoll-worker" });
  const stopMetrics = await wireOtelMetrics({ instrumentationName: "ragdoll-worker" });
  const logger = getLogger();
  const { deps, schedules } = await buildDeps();
  const worker = createWorker(deps);

  // The scheduler enqueues `run_pipeline` jobs onto whichever queue the worker
  // consumes (BullMQ when REDIS_URL is set, else the in-memory queue) so the
  // SAME worker process picks them up. Single active scheduler instance
  // assumed — see the leader-election caveat in ./scheduler.ts.
  let stopScheduler: (() => void) | undefined;

  if (process.env.REDIS_URL) {
    const { startBullMqConsumer, BullMqQueue } = await import("./bullmq.ts");
    // Start the Ollama warmer FIRST so we can gate the BullMQ consumer
    // on the warmer's readiness promise. Without this gate, the worker
    // would happily pick up a `run_pipeline` job while `ollama-pull` is
    // still fetching weights — the first /api/embed comes back 404
    // ("model not found") and the pipeline crashes. The warmer polls
    // /api/generate (chat) and /api/embed (embedding-only) until each
    // model responds 2xx, then resolves `ready`. The dequeue waits.
    const warmModels = (process.env.OLLAMA_WARM_MODELS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const warmer = startOllamaWarmer({
      models: warmModels,
      baseUrl: process.env.OLLAMA_BASE_URL ?? "http://ollama:11434",
      intervalMs: Number(process.env.OLLAMA_WARM_INTERVAL_MS ?? 300_000),
      readyTimeoutMs: Number(
        process.env.OLLAMA_WARM_READY_TIMEOUT_MS ?? 600_000
      ),
      logger
    });
    if (warmModels.length > 0) {
      logger.info("ollama_warmer_started", { models: warmModels });
      try {
        await warmer.ready;
      } catch (err) {
        // A misconfigured Ollama or a hung pull shouldn't leave the
        // worker silently dead. Log loudly and fall through so the
        // worker still accepts non-Ollama jobs (transform-demo,
        // xml-codec-demo, …); Ollama-dependent runs will still fail
        // until the operator fixes the underlying problem.
        logger.error("ollama_warmer_ready_timeout", {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    const consumer = await startBullMqConsumer(worker, {
      redisUrl: process.env.REDIS_URL,
      queueName: process.env.WORKER_QUEUE_NAME,
      concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
      logger
    });
    logger.info("worker consuming BullMQ queue", {
      queue: process.env.WORKER_QUEUE_NAME ?? "ragdoll-jobs"
    });
    const queue: QueuePort = new BullMqQueue({
      redisUrl: process.env.REDIS_URL,
      queueName: process.env.WORKER_QUEUE_NAME
    });
    const scheduler = createScheduler({ schedules, queue, logger });
    stopScheduler = scheduler.start(
      Number(process.env.SCHEDULER_INTERVAL_MS ?? 60000)
    );
    logger.info("scheduler started (BullMQ enqueue)");
    const shutdown = async (): Promise<void> => {
      logger.info("worker shutting down");
      stopScheduler?.();
      warmer.stop();
      await consumer.close();
      // Flush metric + log batches before the process dies so the last
      // few seconds of telemetry actually reach the collector.
      await stopMetrics().catch(() => undefined);
      await stopLogs().catch(() => undefined);
      await stopTraces().catch(() => undefined);
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    // No Redis: there is no external transport to consume. Expose an
    // InMemoryQueue (mainly used by tests / single-process embedding) and log
    // readiness. The worker remains importable + usable in-process. The
    // scheduler enqueues onto the same in-memory queue.
    const queue = new InMemoryQueue();
    const scheduler = createScheduler({ schedules, queue, logger });
    stopScheduler = scheduler.start(
      Number(process.env.SCHEDULER_INTERVAL_MS ?? 60000)
    );
    void stopScheduler;
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
      ],
      scheduler: "started"
    });
  }
}
