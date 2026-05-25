/**
 * Framework-agnostic RAGdoll worker job handlers.
 *
 * `createWorker(deps)` returns `{ handle(job, signal?) }`. Every dependency is
 * injected so this module imports no transport (bullmq / ioredis) and no
 * database driver (pg) — only foundation packages — keeping the unit/functional
 * test path install-free and offline.
 */

import { randomUUID } from "node:crypto";
import type {
  ConfigDefinition,
  ConfigValue,
  PipelineSpec,
  ResolvedConfig,
  RuntimeContext,
  UsageRecord
} from "../../../packages/core/src/index.ts";
import { sanitizeSlug, stableHash } from "../../../packages/core/src/index.ts";
import {
  DagExecutor,
  type ExecutionStore,
  type IngestStateRepository
} from "../../../packages/runtime/src/index.ts";
import type {
  ExecutionRecord,
  ExecutionNodeRecord
} from "../../../packages/runtime/src/index.ts";
import type { PluginRegistry } from "../../../packages/plugin-sdk/src/index.ts";
import { pluginKey } from "../../../packages/plugin-sdk/src/index.ts";
import type { ProviderRegistry } from "../../../packages/providers/src/index.ts";
import type { SecretProvider } from "../../../packages/secrets/src/index.ts";
import { ConfigResolver } from "../../../packages/config-resolver/src/index.ts";
import { validatePipelineSpec } from "../../../packages/pipeline-spec/src/index.ts";
import {
  loadPipelineSpec,
  selectDeployedVersion,
  resolveActivation,
  effectiveVersionId
} from "../../../packages/pipeline-spec/src/index.ts";
import type { PipelineDeployment } from "../../../packages/pipeline-spec/src/index.ts";
import type { VectorStore } from "../../../packages/vector/src/index.ts";
import type { Tracer, Meter } from "../../../packages/observability/src/index.ts";
import { NoopTracer, NoopMeter } from "../../../packages/observability/src/index.ts";
import type { StructuredLogger } from "../../../packages/observability/src/index.ts";
import type { ChangeBus } from "../../../packages/events/src/index.ts";
import {
  PermissionDeniedError,
  requirePermission,
  type Permission,
  type Principal,
  type PrincipalType,
  type Resource
} from "../../../packages/auth/src/index.ts";
import type { Authorizer } from "../../../packages/authz/src/index.ts";
import type {
  PipelineVersionRepository,
  ConfigDefinitionRepository,
  ConfigValueRepository,
  ProviderRepository,
  ProviderModelRepository,
  VectorCollectionRepository,
  DatasourceConnectionRepository,
  UsageRecordRepository,
  PipelineRepository,
  PipelineActivationRepository,
  DatasetRepository,
  DatasetVersionRepository,
  DatasetAliasRepository,
  PipelineVersionRow,
  ConfigValueRow,
  ProviderModelRow,
  VectorCollectionRow
} from "../../../packages/db/src/index.ts";
import type { QueueJob } from "./index.ts";

/* -------------------------------------------------------------------------- */
/*  Dependency contract                                                       */
/* -------------------------------------------------------------------------- */

export interface WorkerRepositories {
  pipelineVersions: PipelineVersionRepository;
  configDefinitions: ConfigDefinitionRepository;
  configValues: ConfigValueRepository;
  providers: ProviderRepository;
  providerModels: ProviderModelRepository;
  vectorCollections: VectorCollectionRepository;
  datasourceConnections: DatasourceConnectionRepository;
  usageRecords: UsageRecordRepository;
  /**
   * Optional pipeline repository. When present (alongside `activations`) the
   * worker can resolve a schedule-originated `run_pipeline` job's effective
   * version via the org-versioning activation table (track-latest follows
   * `PipelineRow.latestVersionId`). Omitted in the legacy e2e harness wiring,
   * which falls back to deployment selection unchanged.
   */
  pipelines?: PipelineRepository;
  /**
   * Optional activation repository. See {@link resolveRunVersion}: when the
   * tenant has activations for (tenant, pipeline, environment) they take
   * precedence over deployment selection for jobs WITHOUT an explicit
   * `pipelineVersionId` (i.e. schedule-originated runs).
   */
  activations?: PipelineActivationRepository;
  /**
   * Optional dataset repositories (Phase 5). When all three are wired
   * the executor resolves `node.dataset` refs against them; without
   * them the resolver hook never fires and pipelines see only their
   * literal `config.collection` / `config.index` exactly as before.
   */
  datasets?: DatasetRepository;
  datasetVersions?: DatasetVersionRepository;
  datasetAliases?: DatasetAliasRepository;
}

export interface WorkerDeps {
  /** Runtime execution store (Postgres- or in-memory-backed). */
  store: ExecutionStore;
  /** Loaded in-process plugin registry. */
  plugins: PluginRegistry;
  /** Loaded provider adapter registry. */
  providers: ProviderRegistry;
  /** Secret provider for resolving node secret refs. */
  secretProvider: SecretProvider;
  /** Vector store (Qdrant or in-memory singleton). */
  vectorStore: VectorStore;
  /** Control-plane repositories. */
  repositories: WorkerRepositories;
  /** Optional tracer; defaults to a no-op. */
  tracer?: Tracer;
  /** Optional metric meter; defaults to a no-op. */
  meter?: Meter;
  /** Optional structured logger. */
  logger?: StructuredLogger;
  /** Max node retries handed to the DagExecutor (default 1). */
  maxRetries?: number;
  /** Deployments lookup for run_pipeline version selection. */
  deployments?: PipelineDeployment[];
  /** Clock injection for deterministic tests. */
  now?: () => Date;
  /** Optional ingest-state repository used by delta-aware plugins
   *  (`delta_filter`). When unset, plugins fall back to an empty state on
   *  every run, effectively treating every document as new. */
  ingestStateRepository?: IngestStateRepository;
  /**
   * When `true`, every usage record written by the DagExecutor (via the
   * runtime ExecutionStore) is ALSO mirrored into
   * `repositories.usageRecords` so it surfaces through the control-plane
   * `/api/usage` endpoint (which reads the repository, not the runtime store).
   *
   * MUST stay `false` whenever `store` is a Postgres ExecutionStore backed by
   * the same `usage_records` table that a Postgres UsageRecordRepository
   * reads — otherwise each usage row is inserted twice. The default
   * in-memory wiring sets this to `true` because InMemoryExecutionStore keeps
   * usage in a private array that the repository never observes, so the
   * mirror is the single source for `/api/usage`.
   *
   * Net effect: exactly one usage write per (executionId, provider, model)
   * in every mode.
   */
  mirrorUsageToRepository?: boolean;
  /**
   * Optional live-event bus. When set, the worker publishes execution
   * lifecycle ChangeEvents (`execution.started`, `execution.node.started`,
   * `execution.node.completed`, `execution.completed`/`.failed`) so the API
   * fans them out over `/api/events` to subscribed clients. Omitted in tests
   * — the wrapper is bypassed and no broadcasts occur.
   */
  changeBus?: ChangeBus;
  /**
   * Optional Authorizer. When provided AND a job payload carries an
   * `enqueuedBy` block, the worker re-checks the enqueuer's grants at
   * dequeue and refuses to run if the grant has been revoked. Without an
   * authorizer the worker dispatches every job as it does today —
   * preserves the install-free unit-test path.
   */
  authorizer?: Authorizer;
  /**
   * System-sweep adapter for the un-deletable `stale_exec_sweep` and
   * `retention_sweep` schedules. Optional so the install-free test path
   * doesn't have to fake one — the dispatch is a no-op when missing.
   * Production wiring (main.ts) passes a Postgres-backed implementation.
   */
  systemSweeps?: SystemSweeps;
}

/* -------------------------------------------------------------------------- */
/*  System sweeps                                                             */
/* -------------------------------------------------------------------------- */

export interface StaleExecSweepResult {
  /** Number of executions transitioned from `running` to `failed`. */
  swept: number;
  /** Effective timeout the sweep used as the platform floor (ms). */
  defaultTimeoutMs: number;
}

export interface RetentionSweepResult {
  executionsDeleted: number;
  usageDeleted: number;
  auditDeleted: number;
}

export interface SystemSweeps {
  /** Mark executions whose `started_at + timeoutMs` is in the past as
   *  failed. `timeoutMs` is read from the pipeline_version spec's
   *  `metadata.timeoutMs` (falling back to the platform default). */
  staleExec(args: {
    /** Platform default timeout, used when a spec doesn't override. */
    defaultTimeoutMs: number;
  }): Promise<StaleExecSweepResult>;
  /** Apply per-resource count + age caps from retention_settings,
   *  deleting rows that exceed any active limit. */
  retention(): Promise<RetentionSweepResult>;
}

/* -------------------------------------------------------------------------- */
/*  Captured-enqueuer block (Phase 2 RBAC refactor)                          */
/* -------------------------------------------------------------------------- */

/**
 * Snapshot of the principal that enqueued a job. Captured at the API
 * boundary (`request.principal`) and serialized into the BullMQ payload.
 * The worker uses it to re-check authorization at dequeue time so a
 * principal whose grant was revoked between enqueue and dequeue cannot
 * keep firing pipelines through previously-queued work.
 *
 * `roles` is the snapshot the API saw at enqueue. For session users this
 * is `[]` (their roles come from `rbac_grants`, which we re-resolve via
 * the authorizer); for API keys / dev / service principals the carried
 * roles are authoritative.
 *
 * `requestId` lets the audit log tie the dequeue-time denial back to the
 * original HTTP request that enqueued the job.
 */
export interface EnqueuedBy {
  principalId: string;
  principalType: PrincipalType;
  tenantId?: string;
  roles: string[];
  requestId?: string;
}

/* -------------------------------------------------------------------------- */
/*  Job payloads                                                              */
/* -------------------------------------------------------------------------- */

export interface RunPipelineJob {
  tenantId: string;
  pipelineId: string;
  environment: string;
  /** Pin a specific published version; otherwise the deployed version is used. */
  pipelineVersionId?: string;
  version?: string;
  /**
   * Org-versioning activation label to resolve when no `pipelineVersionId` is
   * pinned (schedule-originated jobs). `undefined` -> resolveActivation picks
   * the `default`/sole-enabled activation.
   */
  activationLabel?: string;
  input?: Record<string, unknown>;
  runtimeOverrides?: Record<string, unknown>;
  requestId?: string;
  executionId?: string;
  /** Absolute deadline (epoch ms) honored cooperatively by the executor. */
  deadlineMs?: number;
  /** Provenance marker; `"schedule"` for scheduler-enqueued runs. */
  source?: string;
  /** Snapshot of the enqueuing principal. See {@link EnqueuedBy}. */
  enqueuedBy?: EnqueuedBy;
}

export interface IngestDatasourceJob {
  tenantId: string;
  pipelineId: string;
  environment: string;
  pipelineVersionId?: string;
  version?: string;
  datasourceConnectionId?: string;
  /** Raw text to ingest when no datasource plugin is wired. */
  text?: string;
  documents?: Array<{ id?: string; text: string; metadata?: Record<string, unknown> }>;
  collection?: string;
  /** Precomputed vectors aligned with chunks (test/offline injection). */
  vectors?: number[][];
  embeddingProfile?: {
    provider: string;
    model: string;
    dimensions: number;
    distanceMetric?: "cosine" | "dot" | "euclidean";
  };
  chunkConfig?: { chunkSize?: number; overlap?: number };
  runtimeOverrides?: Record<string, unknown>;
  requestId?: string;
  executionId?: string;
  /** Snapshot of the enqueuing principal. See {@link EnqueuedBy}. */
  enqueuedBy?: EnqueuedBy;
}

export interface ReindexTenantJob {
  tenantId: string;
  environment: string;
  /** When omitted, every datasource connection for the tenant is reingested. */
  datasourceConnectionIds?: string[];
  pipelineId?: string;
  /** Snapshot of the enqueuing principal. See {@link EnqueuedBy}. */
  enqueuedBy?: EnqueuedBy;
}

export interface EvaluatePipelineJob {
  tenantId: string;
  pipelineId: string;
  environment: string;
  pipelineVersionId?: string;
  version?: string;
  dataset: Array<{ input: Record<string, unknown>; expected?: unknown }>;
  runtimeOverrides?: Record<string, unknown>;
  /** Snapshot of the enqueuing principal. See {@link EnqueuedBy}. */
  enqueuedBy?: EnqueuedBy;
}

export interface BatchRunJob {
  tenantId: string;
  pipelineId: string;
  environment: string;
  pipelineVersionId?: string;
  version?: string;
  inputs: Array<Record<string, unknown>>;
  runtimeOverrides?: Record<string, unknown>;
  /** Snapshot of the enqueuing principal. See {@link EnqueuedBy}. */
  enqueuedBy?: EnqueuedBy;
}

export interface DeleteTenantVectorDataJob {
  tenantId: string;
  /** When omitted, every collection registered for the tenant is purged. */
  collections?: string[];
  /** Snapshot of the enqueuing principal. See {@link EnqueuedBy}. */
  enqueuedBy?: EnqueuedBy;
}

export interface RotateProviderModelMetadataJob {
  /** When omitted, every registered provider is refreshed. */
  providerIds?: string[];
}

export type PluginHealthCheckJob = Record<string, never>;

/* -------------------------------------------------------------------------- */
/*  Result types                                                              */
/* -------------------------------------------------------------------------- */

export interface RunPipelineResult {
  executionId: string;
  pipelineVersionId: string;
  status: "succeeded";
  output: Record<string, unknown>;
}

export interface IngestResult {
  executionId: string;
  collection: string;
  chunks: number;
  upserted: number;
  vectorCollectionId: string;
}

export interface ReindexResult {
  tenantId: string;
  reindexed: Array<{ datasourceConnectionId: string; chunks: number; upserted: number }>;
}

export interface EvaluateResult {
  pipelineVersionId: string;
  total: number;
  passed: number;
  cases: Array<{ index: number; output: Record<string, unknown>; matched?: boolean }>;
}

export interface BatchRunResult {
  pipelineVersionId: string;
  total: number;
  results: Array<{ index: number; executionId: string; output: Record<string, unknown> }>;
}

export interface DeleteVectorDataResult {
  tenantId: string;
  collections: string[];
}

export interface RotateMetadataResult {
  providers: Array<{ providerId: string; models: number }>;
}

export interface PluginHealthResult {
  plugins: Array<{ key: string; ok: boolean; message?: string; checked: boolean }>;
}

export interface Worker {
  handle(job: QueueJob, signal?: AbortSignal): Promise<unknown>;
}

/* -------------------------------------------------------------------------- */
/*  Default ingestion pipeline spec                                           */
/* -------------------------------------------------------------------------- */

/**
 * Built-in load -> chunk -> embed -> upsert spec used by ingest when the
 * pipeline version has no explicit ingestion graph. Uses the builtin-rag
 * plugins that ship with the platform.
 */
function defaultIngestionSpec(): PipelineSpec {
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name: "builtin-ingestion" },
    spec: {
      nodes: [
        { id: "input", type: "input" },
        {
          id: "chunk",
          plugin: { category: "chunker", id: "basic_text_chunker", version: "1.0.0" },
          config: {
            chunkSize: "${config.chunking.chunk_size}",
            overlap: "${config.chunking.overlap}"
          }
        },
        {
          id: "embed",
          plugin: { category: "embedder", id: "provider_embeddings", version: "1.0.0" }
        },
        {
          id: "upsert",
          plugin: { category: "sink", id: "vector_upsert", version: "1.0.0" },
          config: {
            collection: "${config.vector.collection}",
            distance: "${config.vector.distance}"
          }
        },
        { id: "output", type: "output" }
      ],
      edges: [
        { from: "input", to: "chunk" },
        { from: "chunk", to: "embed" },
        { from: "embed", to: "upsert" },
        { from: "upsert", to: "output" }
      ]
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  createWorker                                                              */
/* -------------------------------------------------------------------------- */

/**
 * ExecutionStore decorator that delegates every call to a wrapped store and
 * additionally mirrors `recordUsage` into a control-plane
 * `UsageRecordRepository`. Used only when `mirrorUsageToRepository` is enabled
 * (in-memory wiring) so pipeline-run usage surfaces via `/api/usage` without
 * risking a double write in Postgres mode (see `WorkerDeps`).
 */
/**
 * ExecutionStore decorator that mirrors every lifecycle write onto a
 * {@link ChangeBus} so the API can rebroadcast to subscribed WebSocket
 * clients. The publish is best-effort: a bus failure is logged but never
 * rolled back, so a transient Redis outage never breaks the run.
 */
class PublishingExecutionStore implements ExecutionStore {
  private inner: ExecutionStore;
  private bus: ChangeBus;
  private logger?: StructuredLogger;
  /**
   * Node records carry neither tenant nor actor; the parent execution does.
   * Cache both from `start()` so node events can be scoped correctly and
   * the live broadcast carries the enqueuing principal's id. Cleared on
   * `complete()` to keep the map bounded.
   */
  private metaByExecution = new Map<
    string,
    { tenantId: string; actorId: string | null }
  >();

  constructor(
    inner: ExecutionStore,
    bus: ChangeBus,
    logger?: StructuredLogger
  ) {
    this.inner = inner;
    this.bus = bus;
    this.logger = logger;
  }

  private async fire(
    action: string,
    targetId: string,
    tenantId: string | null | undefined,
    actorId: string | null,
    payload?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.bus.publish({
        id: randomUUID(),
        action,
        targetType: "execution",
        targetId,
        tenantId: tenantId ?? null,
        actorId,
        at: new Date().toISOString(),
        payload
      });
    } catch (e) {
      this.logger?.warn?.("change_bus_publish_failed", {
        action,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  async start(record: ExecutionRecord): Promise<void> {
    await this.inner.start(record);
    const actorId = record.actorId ?? null;
    this.metaByExecution.set(record.executionId, {
      tenantId: record.tenantId,
      actorId
    });
    await this.fire(
      "execution.started",
      record.executionId,
      record.tenantId,
      actorId,
      {
        pipelineId: record.pipelineId,
        pipelineVersionId: record.pipelineVersionId,
        status: record.status,
        startedAt: record.startedAt
      }
    );
  }

  async complete(record: ExecutionRecord): Promise<void> {
    await this.inner.complete(record);
    const action =
      record.status === "succeeded"
        ? "execution.completed"
        : record.status === "failed"
          ? "execution.failed"
          : record.status === "denied"
            ? "execution.denied"
            : "execution.updated";
    const meta = this.metaByExecution.get(record.executionId);
    await this.fire(
      action,
      record.executionId,
      record.tenantId,
      record.actorId ?? meta?.actorId ?? null,
      {
        pipelineId: record.pipelineId,
        pipelineVersionId: record.pipelineVersionId,
        status: record.status,
        completedAt: record.completedAt
      }
    );
    this.metaByExecution.delete(record.executionId);
  }

  async startNode(record: ExecutionNodeRecord): Promise<void> {
    await this.inner.startNode(record);
    const meta = this.metaByExecution.get(record.executionId);
    await this.fire(
      "execution.node.started",
      record.executionId,
      meta?.tenantId ?? null,
      meta?.actorId ?? null,
      {
        nodeId: record.nodeId,
        status: record.status,
        startedAt: record.startedAt
      }
    );
  }

  async completeNode(record: ExecutionNodeRecord): Promise<void> {
    await this.inner.completeNode(record);
    const meta = this.metaByExecution.get(record.executionId);
    await this.fire(
      "execution.node.completed",
      record.executionId,
      meta?.tenantId ?? null,
      meta?.actorId ?? null,
      {
        nodeId: record.nodeId,
        status: record.status,
        completedAt: record.completedAt
      }
    );
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    return this.inner.recordUsage(record);
  }
}

class UsageMirroringExecutionStore implements ExecutionStore {
  private inner: ExecutionStore;
  private usageRepo: UsageRecordRepository;

  constructor(inner: ExecutionStore, usageRepo: UsageRecordRepository) {
    this.inner = inner;
    this.usageRepo = usageRepo;
  }

  start(record: ExecutionRecord): Promise<void> {
    return this.inner.start(record);
  }

  complete(record: ExecutionRecord): Promise<void> {
    return this.inner.complete(record);
  }

  startNode(record: ExecutionNodeRecord): Promise<void> {
    return this.inner.startNode(record);
  }

  completeNode(record: ExecutionNodeRecord): Promise<void> {
    return this.inner.completeNode(record);
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    await this.inner.recordUsage(record);
    await this.usageRepo.append({
      tenantId: record.tenantId,
      pipelineId: record.pipelineId ?? null,
      executionId: record.executionId ?? null,
      provider: record.provider ?? null,
      model: record.model ?? null,
      inputTokens: record.inputTokens ?? 0,
      outputTokens: record.outputTokens ?? 0,
      embeddingTokens: record.embeddingTokens ?? 0,
      estimatedCostUsd: record.estimatedCostUsd ?? 0,
      latencyMs: record.latencyMs ?? null,
      success: record.success
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Effective-version resolution (org versioning + schedule-originated runs)   */
/* -------------------------------------------------------------------------- */

export interface ResolveRunVersionArgs {
  tenantId: string;
  pipelineId: string;
  environment: string;
  /** Org-versioning activation label; resolved via `resolveActivation`. */
  activationLabel?: string;
  /** When already resolved by the API, this wins and nothing else runs. */
  pipelineVersionId?: string;
}

/**
 * Resolves the concrete pipeline version a `run_pipeline` job should execute.
 *
 * Precedence (highest first):
 *  1. An explicit `pipelineVersionId` on the job — the API already resolved
 *     it. Returned as-is so existing /api/.../run behavior and the local-demo
 *     e2e are byte-for-byte unchanged.
 *  2. Org-versioning activations: if `repositories.activations` +
 *     `repositories.pipelines` are wired AND the tenant has activations for
 *     (tenant, pipeline, environment), pick one via `resolveActivation(...,
 *     activationLabel)` and resolve `effectiveVersionId(activation,
 *     pipeline.latestVersionId)` (track-latest follows the pipeline pointer;
 *     pinned uses the activation's own version). Schedule-originated jobs
 *     (no `pipelineVersionId`) land here.
 *  3. Fallback: `undefined` — the caller then defers to the existing
 *     `selectVersion` deployment/`selectDeployedVersion` resolution exactly as
 *     `run_pipeline` does today (no activations table, or none for this key).
 *
 * Returning `undefined` (not throwing) for case 3 keeps the legacy
 * deployment path and its error messages intact.
 */
export async function resolveRunVersion(
  deps: WorkerDeps,
  args: ResolveRunVersionArgs
): Promise<string | undefined> {
  if (args.pipelineVersionId) return args.pipelineVersionId;

  const activationsRepo = deps.repositories.activations;
  const pipelinesRepo = deps.repositories.pipelines;
  if (!activationsRepo) return undefined;

  const activations = await activationsRepo.listByTenantPipelineEnv(
    args.tenantId,
    args.pipelineId,
    args.environment
  );
  if (activations.length === 0) return undefined;

  const activation = resolveActivation(activations, args.activationLabel);
  let latestVersionId: string | null | undefined;
  if (pipelinesRepo) {
    const pipeline = await pipelinesRepo.get(args.pipelineId);
    latestVersionId = pipeline?.latestVersionId ?? null;
  }
  return effectiveVersionId(activation, latestVersionId);
}

export function createWorker(deps: WorkerDeps): Worker {
  const tracer = deps.tracer ?? new NoopTracer();
  const meter = deps.meter ?? new NoopMeter();
  // Worker-side metrics. Cardinality is bounded: pipeline_id is a tenant
  // ref but the universe per tenant is finite; status is two values; node
  // plugin_id is a registered set. Avoid putting execution_id / tenant_id
  // here — those belong on traces, not metrics.
  const executionCounter = meter.counter("ragdoll_worker_executions_total", {
    description: "Pipeline executions handled by the worker.",
    unit: "{execution}"
  });
  // See the API-side comment for the rationale: omit `unit: "ms"` so the
  // OTLP→Prometheus bridge doesn't double-suffix the exported series.
  const executionDuration = meter.histogram("ragdoll_worker_execution_duration_ms", {
    description: "End-to-end pipeline execution duration."
  });
  const now = deps.now ?? (() => new Date());
  // Compose the runtime store decorators outermost-first:
  // events → usage mirror → real store. Publishing runs only after the inner
  // write succeeds, so a failed write never produces a misleading broadcast.
  const usageMirrored: ExecutionStore = deps.mirrorUsageToRepository
    ? new UsageMirroringExecutionStore(deps.store, deps.repositories.usageRecords)
    : deps.store;
  const runtimeStore: ExecutionStore = deps.changeBus
    ? new PublishingExecutionStore(usageMirrored, deps.changeBus, deps.logger)
    : usageMirrored;

  // Phase 5: build a DatasetResolver from the wired repos. When any of
  // the three is missing we leave it undefined so the executor falls
  // back to "no dataset refs are resolvable" (and the v1 shim never
  // runs) — preserves the legacy harness exactly.
  const datasetResolver =
    deps.repositories.datasets &&
    deps.repositories.datasetVersions &&
    deps.repositories.datasetAliases
      ? {
          async resolve(args: {
            ref: { slug: string; alias?: string };
            tenantId?: string;
            environmentId?: string;
          }) {
            const dsRepo = deps.repositories.datasets!;
            const verRepo = deps.repositories.datasetVersions!;
            const aliasRepo = deps.repositories.datasetAliases!;
            const ds = await dsRepo.resolveSlug({
              slug: args.ref.slug,
              tenantId: args.tenantId,
              environmentId: args.environmentId
            });
            if (!ds) return undefined;
            // alias default = "stable". When the alias points at a version,
            // use that; otherwise fall back to `current_version_id`.
            const aliasName = args.ref.alias ?? "stable";
            const aliasRow = await aliasRepo.resolve(ds.id, aliasName);
            const versionId = aliasRow?.versionId ?? ds.currentVersionId;
            if (!versionId) return undefined;
            const ver = await verRepo.get(versionId);
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

  function executor(): DagExecutor {
    return new DagExecutor({
      pluginRegistry: deps.plugins,
      secretProvider: deps.secretProvider,
      store: runtimeStore,
      ingestStateRepository: deps.ingestStateRepository,
      datasetResolver,
      maxRetries: deps.maxRetries ?? 1,
      tracer
    });
  }

  async function resolveDefinitions(): Promise<ConfigDefinition[]> {
    const rows = await deps.repositories.configDefinitions.list();
    return rows.map((row) => ({
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
  }

  async function resolveConfigValues(): Promise<ConfigValue[]> {
    const rows: ConfigValueRow[] = await deps.repositories.configValues.listConfigValues();
    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      scope: row.scope,
      scopeId: row.scopeId ?? undefined,
      locked: row.locked
    }));
  }

  async function resolveConfig(args: {
    pipelineId: string;
    pipelineVersionId: string;
    tenantId: string;
    environment: string;
    runtimeOverrides?: Record<string, unknown>;
  }): Promise<ResolvedConfig> {
    const resolver = new ConfigResolver(await resolveDefinitions());
    return resolver.resolve(
      {
        pipelineId: args.pipelineId,
        pipelineVersionId: args.pipelineVersionId,
        tenantId: args.tenantId,
        environment: args.environment,
        values: await resolveConfigValues(),
        runtimeOverrides: args.runtimeOverrides
      },
      // Keep secret refs intact so node secrets can resolve through the
      // secret provider; the executor redacts persisted payloads itself.
      { redactSecrets: false }
    );
  }

  /**
   * Resolves the pipeline version row to execute. Honors an explicit
   * `pipelineVersionId`, then a `version` string, then the deployed selection,
   * then the most-recent published row for the pipeline.
   */
  async function selectVersion(args: {
    pipelineId: string;
    environment: string;
    tenantId: string;
    pipelineVersionId?: string;
    version?: string;
  }): Promise<PipelineVersionRow> {
    if (args.pipelineVersionId) {
      return deps.repositories.pipelineVersions.require(args.pipelineVersionId);
    }
    const all = await deps.repositories.pipelineVersions.listByPipeline(args.pipelineId);
    if (args.version) {
      const byVersion = all.find((row) => row.version === args.version);
      if (!byVersion) {
        throw new Error(
          `pipeline ${args.pipelineId} has no version ${args.version}`
        );
      }
      return byVersion;
    }
    if (deps.deployments && deps.deployments.length > 0) {
      const deployed = selectDeployedVersion(deps.deployments, {
        environment: args.environment,
        tenantId: args.tenantId,
        pipelineId: args.pipelineId
      });
      if (deployed) {
        const match = all.find((row) => row.version === deployed.version);
        if (match) return match;
      }
    }
    const published = all
      .filter((row) => row.status === "published")
      .sort((a, b) => (b.publishedAt ?? b.createdAt).localeCompare(a.publishedAt ?? a.createdAt));
    const chosen = published[0] ?? all[0];
    if (!chosen) {
      throw new Error(`pipeline ${args.pipelineId} has no versions`);
    }
    return chosen;
  }

  function specOf(row: PipelineVersionRow): PipelineSpec {
    if (typeof row.spec === "string") return loadPipelineSpec(row.spec);
    return row.spec as PipelineSpec;
  }

  function buildContext(args: {
    requestId?: string;
    executionId: string;
    tenantId: string;
    pipelineId: string;
    pipelineVersionId: string;
    environment: string;
    resolvedConfig: ResolvedConfig;
    deadlineMs?: number;
    signal?: AbortSignal;
    /** Set by the dequeue auth check so the executor entry-check fires. */
    principalAuthorize?: RuntimeContext["principalAuthorize"];
    /** Snapshot of the enqueuing actor so the audit + bus carry it. */
    actor?: { id: string; type: "user" | "service" | "api_key"; roles?: string[] };
  }): RuntimeContext {
    return {
      requestId: args.requestId ?? randomUUID(),
      executionId: args.executionId,
      tenantId: args.tenantId,
      pipelineId: args.pipelineId,
      pipelineVersionId: args.pipelineVersionId,
      environment: args.environment,
      resolvedConfig: args.resolvedConfig,
      deadline: args.deadlineMs ? new Date(args.deadlineMs) : undefined,
      signal: args.signal,
      actor: args.actor,
      principalAuthorize: args.principalAuthorize
    };
  }

  /* ----- Phase 2: re-enforce the enqueuer's grants at dequeue time ------ */

  /**
   * When `deps.authorizer` AND the job's `enqueuedBy` are both present,
   * resolve the enqueuer's CURRENT scoped authorize closure and call
   * {@link requirePermission} against the run's scope. If the grant has
   * been revoked since enqueue, a {@link PermissionDeniedError} is thrown
   * — the caller records a `denied` execution and propagates the error
   * to BullMQ so the job is not retried (`status: "denied"` is terminal,
   * distinct from `failed`).
   *
   * Returns the closure + the actor block so the caller can wire both
   * into {@link RuntimeContext}: the executor's defense-in-depth entry
   * check re-uses the same closure, and the actor lands on
   * `ExecutionRecord.actorId` so "who ran this?" is answerable from
   * the audit trail.
   *
   * Without either dependency, returns the empty object — preserves the
   * install-free unit-test path and the legacy harness exactly.
   */
  async function authorizeEnqueuer(
    enqueuedBy: EnqueuedBy | undefined,
    permission: Permission,
    scope: Resource
  ): Promise<{
    principalAuthorize?: RuntimeContext["principalAuthorize"];
    actor?: { id: string; type: PrincipalType; roles: string[] };
  }> {
    if (!deps.authorizer || !enqueuedBy) return {};
    const principal: Principal = {
      id: enqueuedBy.principalId,
      type: enqueuedBy.principalType,
      tenantId: enqueuedBy.tenantId,
      // EnqueuedBy.roles is a free string[] (no compile-time coupling to
      // the auth Role union, which would force every job-payload writer
      // to import @ragdoll/auth). At authorize time, unknown role names
      // simply produce zero permissions — same fail-closed semantics.
      roles: enqueuedBy.roles as Principal["roles"]
    };
    const closure = await deps.authorizer.authorizeClosure(principal, {
      defaultTenantId: scope.tenantId ?? enqueuedBy.tenantId
    });
    principal.authorize = closure;
    requirePermission(principal, permission, scope, {
      requestId: enqueuedBy.requestId
    });
    return {
      principalAuthorize: (perm, resource) => closure(perm, resource ?? {}),
      actor: {
        id: enqueuedBy.principalId,
        type: enqueuedBy.principalType,
        roles: enqueuedBy.roles
      }
    };
  }

  /**
   * Persist a `denied` execution row when the dequeue check rejects. The
   * row carries the original enqueuer's id so the UI / audit log can
   * answer "this run was denied because principal X lost permission".
   */
  async function recordDenied(args: {
    executionId: string;
    tenantId: string;
    pipelineId: string;
    pipelineVersionId?: string;
    enqueuedBy?: EnqueuedBy;
    error: string;
  }): Promise<void> {
    const startedAt = new Date().toISOString();
    const base: ExecutionRecord = {
      executionId: args.executionId,
      tenantId: args.tenantId,
      pipelineId: args.pipelineId,
      pipelineVersionId: args.pipelineVersionId ?? "denied",
      status: "running",
      startedAt,
      actorId: args.enqueuedBy?.principalId ?? null
    };
    try {
      await deps.store.start(base);
      await deps.store.complete({
        ...base,
        status: "denied",
        completedAt: new Date().toISOString(),
        error: args.error
      });
    } catch (e) {
      deps.logger?.warn?.("denied_execution_persist_failed", {
        executionId: args.executionId,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  /* ---------------------------- run_pipeline ----------------------------- */

  async function runPipeline(
    payload: RunPipelineJob,
    signal?: AbortSignal
  ): Promise<RunPipelineResult> {
    // Dequeue-time authorization re-check (Phase 2 of dataset/RBAC refactor).
    // Runs BEFORE version resolution so a denied job never touches the
    // pipeline_versions table. Throws PermissionDeniedError when the enqueuer
    // has lost pipeline:run since enqueue; we record a `denied` execution
    // and rethrow so BullMQ treats the job as terminally rejected.
    const executionId = payload.executionId ?? randomUUID();
    let principalAuthorize: RuntimeContext["principalAuthorize"];
    let actor: { id: string; type: PrincipalType; roles?: string[] } | undefined;
    try {
      const auth = await authorizeEnqueuer(
        payload.enqueuedBy,
        "pipeline:run" as Permission,
        {
          tenantId: payload.tenantId,
          pipelineId: payload.pipelineId,
          environment: payload.environment
        }
      );
      principalAuthorize = auth.principalAuthorize;
      actor = auth.actor;
    } catch (e) {
      if (e instanceof PermissionDeniedError) {
        await recordDenied({
          executionId,
          tenantId: payload.tenantId,
          pipelineId: payload.pipelineId,
          enqueuedBy: payload.enqueuedBy,
          error: e.message
        });
      }
      throw e;
    }
    // Resolve the effective version: explicit pin (API-resolved) > org
    // activation (schedule-originated) > undefined => legacy deployment
    // selection inside selectVersion. `version` (string) overrides are only
    // consulted by selectVersion when no concrete id is resolved here.
    const resolvedVersionId = await resolveRunVersion(deps, {
      tenantId: payload.tenantId,
      pipelineId: payload.pipelineId,
      environment: payload.environment,
      activationLabel: payload.activationLabel,
      pipelineVersionId: payload.pipelineVersionId
    });
    const versionRow = await selectVersion({
      ...payload,
      pipelineVersionId: resolvedVersionId ?? payload.pipelineVersionId
    });
    const spec = specOf(versionRow);
    const validation = validatePipelineSpec(spec, deps.plugins);
    if (!validation.valid) {
      throw new Error(
        `pipeline validation failed: ${validation.errors.map((e) => e.message).join("; ")}`
      );
    }
    const resolvedConfig = await resolveConfig({
      pipelineId: payload.pipelineId,
      pipelineVersionId: versionRow.id,
      tenantId: payload.tenantId,
      environment: payload.environment,
      runtimeOverrides: payload.runtimeOverrides
    });
    const context = buildContext({
      requestId: payload.requestId,
      executionId,
      tenantId: payload.tenantId,
      pipelineId: payload.pipelineId,
      pipelineVersionId: versionRow.id,
      environment: payload.environment,
      resolvedConfig,
      deadlineMs: payload.deadlineMs,
      signal,
      actor,
      principalAuthorize
    });
    const startNs = process.hrtime.bigint();
    let metricStatus: "succeeded" | "failed" = "succeeded";
    try {
      const output = await executor().execute({
        spec,
        context,
        input: payload.input ?? {}
      });
      deps.logger?.info("run_pipeline completed", {
        executionId,
        pipelineId: payload.pipelineId,
        tenantId: payload.tenantId
      });
      return {
        executionId,
        pipelineVersionId: versionRow.id,
        status: "succeeded",
        output
      };
    } catch (e) {
      metricStatus = "failed";
      throw e;
    } finally {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      const labels = {
        pipeline_id: payload.pipelineId,
        environment: payload.environment,
        status: metricStatus
      };
      executionCounter.add(1, labels);
      executionDuration.record(durationMs, labels);
    }
  }

  /* -------------------------- ingest_datasource -------------------------- */

  async function ingestDatasource(
    payload: IngestDatasourceJob,
    signal?: AbortSignal
  ): Promise<IngestResult> {
    const executionId = payload.executionId ?? randomUUID();

    // Resolve a pipeline version if one is referenced; otherwise use the
    // built-in ingestion graph.
    let spec: PipelineSpec;
    let pipelineVersionId: string;
    const versions = await deps.repositories.pipelineVersions
      .listByPipeline(payload.pipelineId)
      .catch(() => [] as PipelineVersionRow[]);
    if (payload.pipelineVersionId || payload.version || versions.length > 0) {
      const versionRow = await selectVersion(payload).catch(() => undefined);
      if (versionRow) {
        spec = specOf(versionRow);
        pipelineVersionId = versionRow.id;
      } else {
        spec = defaultIngestionSpec();
        pipelineVersionId = `builtin-ingestion:${payload.pipelineId}`;
      }
    } else {
      spec = defaultIngestionSpec();
      pipelineVersionId = `builtin-ingestion:${payload.pipelineId}`;
    }

    const profile = payload.embeddingProfile ?? {
      provider: "inline",
      model: "precomputed",
      dimensions: payload.vectors?.[0]?.length ?? 0,
      distanceMetric: "cosine" as const
    };
    const distance = profile.distanceMetric ?? "cosine";
    const collection =
      payload.collection ??
      defaultCollectionName(payload.environment, payload.tenantId, payload.pipelineId, {
        provider: profile.provider,
        model: profile.model,
        dimensions: profile.dimensions
      });

    // Resolve documents to ingest.
    const documents =
      payload.documents ??
      (payload.text !== undefined ? [{ text: payload.text }] : []);
    const joinedText = documents.map((doc) => doc.text).join("\n\n");

    const runtimeOverrides: Record<string, unknown> = {
      "vector.collection": collection,
      "vector.distance": distance,
      ...(payload.chunkConfig?.chunkSize !== undefined
        ? { "chunking.chunk_size": payload.chunkConfig.chunkSize }
        : {}),
      ...(payload.chunkConfig?.overlap !== undefined
        ? { "chunking.overlap": payload.chunkConfig.overlap }
        : {}),
      ...(payload.runtimeOverrides ?? {})
    };
    const resolvedConfig = await resolveConfig({
      pipelineId: payload.pipelineId,
      pipelineVersionId,
      tenantId: payload.tenantId,
      environment: payload.environment,
      runtimeOverrides
    }).catch(() => syntheticConfig(payload.pipelineId, pipelineVersionId, payload.tenantId, payload.environment, runtimeOverrides));

    const context = buildContext({
      requestId: payload.requestId,
      executionId,
      tenantId: payload.tenantId,
      pipelineId: payload.pipelineId,
      pipelineVersionId,
      environment: payload.environment,
      resolvedConfig,
      signal
    });

    let chunks: Array<{ text: string; index: number } & Record<string, unknown>>;
    let upserted: number;

    if (payload.vectors && payload.vectors.length > 0) {
      // Offline / precomputed path: chunk locally, upsert vectors directly so
      // the ingestion is deterministic without an embedding provider.
      chunks = chunkDocuments(documents, payload.chunkConfig);
      const dims = payload.vectors[0]?.length ?? profile.dimensions;
      await deps.vectorStore.ensureCollection(collection, {
        dimensions: dims,
        distance
      });
      const points = payload.vectors.map((vector, index) => {
        const chunk = chunks[index] ?? { text: "", index };
        return {
          id: `${executionId}_${index}`,
          vector,
          tenantId: payload.tenantId,
          payload: {
            text: chunk.text,
            chunkIndex: chunk.index,
            ...(documents[0]?.metadata ?? {})
          }
        };
      });
      await deps.vectorStore.upsert(collection, points);
      upserted = points.length;
      // Record the execution + usage for parity with the DAG path.
      const startedAt = now().toISOString();
      const exec: ExecutionRecord = {
        executionId,
        tenantId: payload.tenantId,
        pipelineId: payload.pipelineId,
        pipelineVersionId,
        status: "running",
        startedAt,
        input: { documents: documents.length }
      };
      await runtimeStore.start(exec);
      await runtimeStore.complete({
        ...exec,
        status: "succeeded",
        completedAt: now().toISOString(),
        output: { upserted }
      });
      const usage: UsageRecord = {
        tenantId: payload.tenantId,
        pipelineId: payload.pipelineId,
        executionId,
        provider: profile.provider,
        model: profile.model,
        embeddingTokens: 0,
        success: true
      };
      await runtimeStore.recordUsage(usage);
    } else {
      // DAG path: run the load->chunk->embed->upsert graph.
      const output = await executor().execute({
        spec,
        context,
        input: { text: joinedText, documents }
      });
      upserted = Number(
        (output.upserted as number | undefined) ??
          (output.upsert as { upserted?: number } | undefined)?.upserted ??
          0
      );
      chunks = chunkDocuments(documents, payload.chunkConfig);
    }

    // Record a vector_collections row (idempotent on collection name).
    const existing = await deps.repositories.vectorCollections
      .findByName(collection)
      .catch(() => undefined);
    let vectorCollectionId: string;
    if (existing) {
      vectorCollectionId = existing.id;
    } else {
      const row: VectorCollectionRow = {
        id: randomUUID(),
        tenantId: payload.tenantId,
        pipelineId: payload.pipelineId,
        environment: payload.environment,
        collectionName: collection,
        isolationMode: "shared_collection_tenant_filter",
        embeddingProfile: {
          provider: profile.provider,
          model: profile.model,
          dimensions: profile.dimensions,
          distanceMetric: distance
        },
        createdAt: now().toISOString()
      };
      await deps.repositories.vectorCollections.create(row);
      vectorCollectionId = row.id;
    }

    deps.logger?.info("ingest_datasource completed", {
      executionId,
      collection,
      upserted
    });
    return {
      executionId,
      collection,
      chunks: chunks.length,
      upserted,
      vectorCollectionId
    };
  }

  /* --------------------------- reindex_tenant ---------------------------- */

  async function reindexTenant(
    payload: ReindexTenantJob,
    signal?: AbortSignal
  ): Promise<ReindexResult> {
    const connections = await deps.repositories.datasourceConnections.listByTenant(
      payload.tenantId
    );
    const targets = payload.datasourceConnectionIds
      ? connections.filter((c) => payload.datasourceConnectionIds!.includes(c.id))
      : connections;
    const reindexed: ReindexResult["reindexed"] = [];
    for (const connection of targets) {
      const config = connection.configRedacted as Record<string, unknown>;
      const result = await ingestDatasource(
        {
          tenantId: payload.tenantId,
          pipelineId:
            payload.pipelineId ?? String(config.pipelineId ?? connection.datasourceType),
          environment: payload.environment,
          datasourceConnectionId: connection.id,
          text: typeof config.text === "string" ? config.text : "",
          documents: Array.isArray(config.documents)
            ? (config.documents as IngestDatasourceJob["documents"])
            : undefined,
          vectors: Array.isArray(config.vectors)
            ? (config.vectors as number[][])
            : undefined,
          collection:
            typeof config.collection === "string" ? config.collection : undefined,
          embeddingProfile: config.embeddingProfile as
            | IngestDatasourceJob["embeddingProfile"]
            | undefined
        },
        signal
      );
      reindexed.push({
        datasourceConnectionId: connection.id,
        chunks: result.chunks,
        upserted: result.upserted
      });
    }
    deps.logger?.info("reindex_tenant completed", {
      tenantId: payload.tenantId,
      connections: reindexed.length
    });
    return { tenantId: payload.tenantId, reindexed };
  }

  /* -------------------------- evaluate_pipeline -------------------------- */

  async function evaluatePipeline(
    payload: EvaluatePipelineJob,
    signal?: AbortSignal
  ): Promise<EvaluateResult> {
    const cases: EvaluateResult["cases"] = [];
    let pipelineVersionId = "";
    let passed = 0;
    for (let index = 0; index < payload.dataset.length; index += 1) {
      const item = payload.dataset[index];
      const run = await runPipeline(
        {
          tenantId: payload.tenantId,
          pipelineId: payload.pipelineId,
          environment: payload.environment,
          pipelineVersionId: payload.pipelineVersionId,
          version: payload.version,
          input: item.input,
          runtimeOverrides: payload.runtimeOverrides
        },
        signal
      );
      pipelineVersionId = run.pipelineVersionId;
      const matched =
        item.expected === undefined
          ? undefined
          : JSON.stringify(run.output) === JSON.stringify(item.expected) ||
            stableHash(run.output) === stableHash(item.expected);
      if (matched) passed += 1;
      cases.push({ index, output: run.output, matched });
    }
    deps.logger?.info("evaluate_pipeline completed", {
      pipelineId: payload.pipelineId,
      total: payload.dataset.length,
      passed
    });
    return {
      pipelineVersionId,
      total: payload.dataset.length,
      passed,
      cases
    };
  }

  /* ------------------------------ batch_run ------------------------------ */

  async function batchRun(
    payload: BatchRunJob,
    signal?: AbortSignal
  ): Promise<BatchRunResult> {
    const results: BatchRunResult["results"] = [];
    let pipelineVersionId = "";
    for (let index = 0; index < payload.inputs.length; index += 1) {
      const run = await runPipeline(
        {
          tenantId: payload.tenantId,
          pipelineId: payload.pipelineId,
          environment: payload.environment,
          pipelineVersionId: payload.pipelineVersionId,
          version: payload.version,
          input: payload.inputs[index],
          runtimeOverrides: payload.runtimeOverrides
        },
        signal
      );
      pipelineVersionId = run.pipelineVersionId;
      results.push({ index, executionId: run.executionId, output: run.output });
    }
    deps.logger?.info("batch_run completed", {
      pipelineId: payload.pipelineId,
      total: payload.inputs.length
    });
    return { pipelineVersionId, total: payload.inputs.length, results };
  }

  /* ---------------------- delete_tenant_vector_data ---------------------- */

  async function deleteTenantVectorData(
    payload: DeleteTenantVectorDataJob
  ): Promise<DeleteVectorDataResult> {
    let collections = payload.collections;
    if (!collections) {
      const all = await deps.repositories.vectorCollections.list();
      collections = all
        .filter((row) => row.tenantId === payload.tenantId)
        .map((row) => row.collectionName);
    }
    const purged: string[] = [];
    for (const collection of collections) {
      try {
        await deps.vectorStore.deleteByTenant(collection, payload.tenantId);
        purged.push(collection);
      } catch (error) {
        deps.logger?.warn("delete_tenant_vector_data: collection skipped", {
          collection,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    deps.logger?.info("delete_tenant_vector_data completed", {
      tenantId: payload.tenantId,
      collections: purged.length
    });
    return { tenantId: payload.tenantId, collections: purged };
  }

  /* ------------------- rotate_provider_model_metadata -------------------- */

  async function rotateProviderModelMetadata(
    payload: RotateProviderModelMetadataJob
  ): Promise<RotateMetadataResult> {
    const providerRows = await deps.repositories.providers.list();
    const summary: RotateMetadataResult["providers"] = [];
    for (const providerRow of providerRows) {
      if (payload.providerIds && !payload.providerIds.includes(providerRow.providerId)) {
        continue;
      }
      let adapter;
      try {
        adapter = deps.providers.require(providerRow.providerId);
      } catch {
        deps.logger?.warn("rotate_provider_model_metadata: no adapter", {
          providerId: providerRow.providerId
        });
        continue;
      }
      const models = await adapter.models();
      const existing = await deps.repositories.providerModels.listByProvider(
        providerRow.id
      );
      for (const model of models) {
        const prior = existing.find((row) => row.modelId === model.id);
        const row: ProviderModelRow = {
          id: prior?.id ?? randomUUID(),
          providerId: providerRow.id,
          modelId: model.id,
          displayName: model.displayName ?? null,
          contextWindow: model.contextWindow ?? null,
          inputCostPer1m: model.inputCostPer1M ?? null,
          outputCostPer1m: model.outputCostPer1M ?? null,
          supportsStreaming: Boolean(model.supportsStreaming),
          supportsTools: Boolean(model.supportsTools),
          supportsEmbeddings: Boolean(model.supportsEmbeddings),
          metadata: {}
        };
        if (prior) {
          await deps.repositories.providerModels.update(prior.id, row);
        } else {
          await deps.repositories.providerModels.create(row);
        }
      }
      summary.push({ providerId: providerRow.providerId, models: models.length });
    }
    deps.logger?.info("rotate_provider_model_metadata completed", {
      providers: summary.length
    });
    return { providers: summary };
  }

  /* ------------------------- plugin_health_check ------------------------- */

  async function pluginHealthCheck(): Promise<PluginHealthResult> {
    const plugins = deps.plugins.list();
    const results: PluginHealthResult["plugins"] = [];
    for (const plugin of plugins) {
      const key = pluginKey(plugin.manifest);
      const healthCheck = plugin.implementation?.healthCheck;
      if (plugin.mode === "in_process" && typeof healthCheck === "function") {
        try {
          const status = await healthCheck.call(plugin.implementation);
          results.push({
            key,
            ok: status.ok,
            message: status.message,
            checked: true
          });
        } catch (error) {
          results.push({
            key,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
            checked: true
          });
        }
      } else {
        results.push({ key, ok: true, checked: false });
      }
    }
    deps.logger?.info("plugin_health_check completed", {
      plugins: results.length
    });
    return { plugins: results };
  }

  /* ----------------------------- system sweeps --------------------------- */

  /** Platform default pipeline timeout, applied when a spec doesn't carry
   *  `metadata.timeoutMs`. 60 min matches the user-visible default in the
   *  Pipelines screen; override per-pipeline by editing that field. */
  const DEFAULT_PIPELINE_TIMEOUT_MS = 60 * 60 * 1000;

  async function staleExecSweep(): Promise<StaleExecSweepResult> {
    if (!deps.systemSweeps) {
      deps.logger?.info(
        "stale_exec_sweep skipped: no systemSweeps adapter wired (test mode?)"
      );
      return { swept: 0, defaultTimeoutMs: DEFAULT_PIPELINE_TIMEOUT_MS };
    }
    const result = await deps.systemSweeps.staleExec({
      defaultTimeoutMs: DEFAULT_PIPELINE_TIMEOUT_MS
    });
    deps.logger?.info("stale_exec_sweep completed", {
      swept: result.swept,
      defaultTimeoutMs: result.defaultTimeoutMs
    });
    return result;
  }

  async function retentionSweep(): Promise<RetentionSweepResult> {
    if (!deps.systemSweeps) {
      deps.logger?.info(
        "retention_sweep skipped: no systemSweeps adapter wired (test mode?)"
      );
      return { executionsDeleted: 0, usageDeleted: 0, auditDeleted: 0 };
    }
    const result = await deps.systemSweeps.retention();
    deps.logger?.info("retention_sweep completed", { ...result });
    return result;
  }

  /* ------------------------------ dispatch ------------------------------- */

  async function handle(job: QueueJob, signal?: AbortSignal): Promise<unknown> {
    switch (job.type) {
      case "run_pipeline":
        return runPipeline(job.payload as RunPipelineJob, signal);
      case "ingest_datasource":
        return ingestDatasource(job.payload as IngestDatasourceJob, signal);
      case "reindex_tenant":
        return reindexTenant(job.payload as ReindexTenantJob, signal);
      case "evaluate_pipeline":
        return evaluatePipeline(job.payload as EvaluatePipelineJob, signal);
      case "batch_run":
        return batchRun(job.payload as BatchRunJob, signal);
      case "delete_tenant_vector_data":
        return deleteTenantVectorData(job.payload as DeleteTenantVectorDataJob);
      case "rotate_provider_model_metadata":
        return rotateProviderModelMetadata(
          job.payload as RotateProviderModelMetadataJob
        );
      case "plugin_health_check":
        return pluginHealthCheck();
      case "stale_exec_sweep":
        return staleExecSweep();
      case "retention_sweep":
        return retentionSweep();
      default: {
        const exhaustive: never = job.type;
        throw new Error(`unsupported job type: ${String(exhaustive)}`);
      }
    }
  }

  return { handle };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function chunkDocuments(
  documents: Array<{ id?: string; text: string; metadata?: Record<string, unknown> }>,
  chunkConfig?: { chunkSize?: number; overlap?: number }
): Array<{ text: string; index: number } & Record<string, unknown>> {
  const chunkSize = chunkConfig?.chunkSize ?? 1000;
  const overlap = chunkConfig?.overlap ?? 100;
  const chunks: Array<{ text: string; index: number } & Record<string, unknown>> = [];
  for (const document of documents) {
    const text = document.text ?? "";
    for (
      let start = 0;
      start < Math.max(text.length, 1);
      start += Math.max(1, chunkSize - overlap)
    ) {
      chunks.push({
        text: text.slice(start, start + chunkSize),
        index: chunks.length,
        ...(document.metadata ?? {})
      });
      if (text.length === 0) break;
    }
  }
  return chunks;
}

function defaultCollectionName(
  environment: string,
  tenantId: string,
  pipelineId: string,
  profile: { provider: string; model: string; dimensions: number }
): string {
  return [
    "rag",
    sanitizeSlug(environment),
    sanitizeSlug(tenantId),
    sanitizeSlug(pipelineId),
    stableHash(profile)
  ].join("_");
}

/**
 * Minimal ResolvedConfig used when no config definitions exist (e.g. offline
 * ingestion with only runtime overrides). Mirrors the resolver's runtime
 * scope so `${config.*}` templates still resolve.
 */
function syntheticConfig(
  pipelineId: string,
  pipelineVersionId: string,
  tenantId: string,
  environment: string,
  runtimeOverrides: Record<string, unknown>
): ResolvedConfig {
  const values: ResolvedConfig["values"] = {};
  for (const [key, value] of Object.entries(runtimeOverrides)) {
    values[key] = {
      value,
      sourceScope: "runtime",
      defaulted: false,
      locked: false,
      secret: false,
      sensitive: false,
      redacted: false,
      inherited: false
    };
  }
  return {
    pipelineId,
    pipelineVersionId,
    tenantId,
    environment,
    values,
    violations: []
  };
}
