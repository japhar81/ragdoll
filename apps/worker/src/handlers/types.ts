/**
 * Worker dependency contract + job payload / result shapes.
 *
 * Kept as a pure type module so `nats.ts`, `main.ts`, `scheduler.ts`,
 * and the e2e harness can `import type { … }` without pulling in the
 * runtime executor. The implementations live in the rest of
 * `apps/worker/src/handlers/*`.
 */

import type {
  RuntimeContext,
  UsageRecord
} from "../../../../packages/core/src/index.ts";
import type {
  ExecutionStore,
  IngestStateRepository
} from "../../../../packages/runtime/src/index.ts";
import type { PluginRegistry } from "../../../../packages/plugin-sdk/src/index.ts";
import type { ProviderRegistry } from "../../../../packages/providers/src/index.ts";
import type { SecretProvider } from "../../../../packages/secrets/src/index.ts";
import type { PipelineDeployment } from "../../../../packages/pipeline-spec/src/index.ts";
import type { VectorStore } from "../../../../packages/vector/src/index.ts";
import type {
  Tracer,
  Meter,
  StructuredLogger
} from "../../../../packages/observability/src/index.ts";
import type { ChangeBus } from "../../../../packages/events/src/index.ts";
import type { PrincipalType } from "../../../../packages/auth/src/index.ts";
import type { Authorizer } from "../../../../packages/authz/src/index.ts";
import type {
  PipelineVersionRepository,
  ConfigDefinitionRepository,
  ConfigValueRepository,
  ProviderRepository,
  ProviderModelRepository,
  VectorCollectionRepository,
  ConnectionRepository,
  UsageRecordRepository,
  PipelineRepository,
  PipelineActivationRepository,
  DatasetRepository,
  DatasetVersionRepository,
  DatasetAliasRepository,
  PipelineDatasetBindingRepository,
  TenantRepository,
  EnvironmentRepository
} from "../../../../packages/db/src/index.ts";
import type { QueueJob } from "../index.ts";

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
  /** ADR-0023 Unified Connections Registry. Replaces the older
   *  `datasourceConnections` + `externalConnections` fields. */
  connections: ConnectionRepository;
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
   * Optional activation repository. See `resolveRunVersion`: when the
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
  /**
   * Optional per-(pipeline, tenant, env) dataset binding overrides
   * (PR3). When wired, the shared resolver consults the binding
   * cascade BEFORE the default slug → env→tenant→global lookup, so
   * operators can pin a pipeline's logical dataset slug to a
   * specific row per environment without forking the spec.
   */
  pipelineDatasetBindings?: PipelineDatasetBindingRepository;
  /**
   * Optional tenant + environment repos (PR6 — namespace policy). The
   * resolver looks up the caller's tenant slug / env name lazily to
   * expand a backend block's `namespace: by-tenant | by-env |
   * by-tenant-env` into a per-scope collection suffix. Without these
   * wired, any non-`shared` policy degrades silently to the base
   * collection name — exactly the legacy behaviour pre-PR6.
   */
  tenants?: TenantRepository;
  environments?: EnvironmentRepository;
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
 * boundary (`request.principal`) and serialized into the queue payload.
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

// `RuntimeContext` + `UsageRecord` are re-exported so callers that
// imported them via handlers.ts (the pre-refactor barrel) keep
// compiling. New code should import from packages/core directly.
export type { RuntimeContext, UsageRecord };
