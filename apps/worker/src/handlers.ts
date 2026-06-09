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
import { stableHash } from "../../../packages/core/src/index.ts";
import {
  DagExecutor,
  buildDatasetResolver,
  type ExecutionStore,
  type ExecutionRecord
} from "../../../packages/runtime/src/index.ts";
import {
  ExternalConnectionResolver,
  probeConnection
} from "../../../packages/external-connections/src/index.ts";
import { pluginKey } from "../../../packages/plugin-sdk/src/index.ts";
import { ConfigResolver } from "../../../packages/config-resolver/src/index.ts";
import { validatePipelineSpec } from "../../../packages/pipeline-spec/src/index.ts";
import {
  loadPipelineSpec,
  selectDeployedVersion
} from "../../../packages/pipeline-spec/src/index.ts";
import { NoopTracer, NoopMeter } from "../../../packages/observability/src/index.ts";
import {
  PermissionDeniedError,
  requirePermission,
  type Permission,
  type Principal,
  type PrincipalType,
  type Resource
} from "../../../packages/auth/src/index.ts";
import type {
  PipelineVersionRow,
  ConfigValueRow,
  ProviderModelRow,
  VectorCollectionRow
} from "../../../packages/db/src/index.ts";
import type { QueueJob } from "./index.ts";
import { resolveRunVersion } from "./handlers/version-resolution.ts";

// Worker types (WorkerDeps, WorkerRepositories, job + result shapes,
// Worker interface) live in ./handlers/types.ts. Re-exported below so
// every existing `import … from "./handlers.ts"` keeps compiling.
export type {
  WorkerRepositories,
  WorkerDeps,
  StaleExecSweepResult,
  RetentionSweepResult,
  SystemSweeps,
  EnqueuedBy,
  RunPipelineJob,
  IngestDatasourceJob,
  ReindexTenantJob,
  EvaluatePipelineJob,
  BatchRunJob,
  DeleteTenantVectorDataJob,
  RotateProviderModelMetadataJob,
  PluginHealthCheckJob,
  RunPipelineResult,
  IngestResult,
  ReindexResult,
  EvaluateResult,
  BatchRunResult,
  DeleteVectorDataResult,
  RotateMetadataResult,
  PluginHealthResult,
  Worker
} from "./handlers/types.ts";
import type {
  WorkerDeps,
  WorkerRepositories,
  Worker,
  EnqueuedBy,
  RunPipelineJob,
  IngestDatasourceJob,
  ReindexTenantJob,
  EvaluatePipelineJob,
  BatchRunJob,
  DeleteTenantVectorDataJob,
  RotateProviderModelMetadataJob,
  PluginHealthCheckJob,
  RunPipelineResult,
  IngestResult,
  ReindexResult,
  EvaluateResult,
  BatchRunResult,
  DeleteVectorDataResult,
  RotateMetadataResult,
  PluginHealthResult,
  StaleExecSweepResult,
  RetentionSweepResult
} from "./handlers/types.ts";
import {
  PublishingExecutionStore,
  UsageMirroringExecutionStore
} from "./handlers/execution-store-decorators.ts";
import {
  defaultIngestionSpec,
  chunkDocuments,
  defaultCollectionName,
  syntheticConfig
} from "./handlers/builtin-ingestion.ts";
export { resolveRunVersion } from "./handlers/version-resolution.ts";
export type { ResolveRunVersionArgs } from "./handlers/version-resolution.ts";

// ----- The remainder of this file is `createWorker` + its closures.
// Pure helpers, decorators, version-resolution, and type declarations
// were extracted into `handlers/` so the bulk of this file is the
// runtime dispatch logic, not boilerplate.

/* -------------------------------------------------------------------------- */
/*  System sweeps                                                             */
/* -------------------------------------------------------------------------- */

export function createWorker(deps: WorkerDeps): Worker {
  const tracer = deps.tracer ?? new NoopTracer();
  const meter = deps.meter ?? new NoopMeter();
  // Worker identity stamped on every metric so the Grafana dashboard
  // can break throughput / duration down per replica. Defaults to
  // "worker-1" when unset so single-worker stacks still produce a
  // non-empty label (Prometheus drops series with empty label values).
  // Cardinality is bounded by the number of replicas — safe to label.
  const workerId = process.env.WORKER_ID ?? "worker-1";
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
  // In-flight gauge so the dashboard can show concurrent runs per
  // worker (proves scale-out at a glance). Counter-of-counters because
  // the OTel histogram/counter API doesn't include UpDownCounter on
  // our minimal NoopMeter; we model the gauge as a counter that ticks
  // +1 on start and -1 on complete, then a `sum without (status)` in
  // PromQL collapses it back to current in-flight.
  const inFlight = meter.upDownCounter("ragdoll_worker_inflight", {
    description: "Pipeline executions currently running on this worker (+1 on start, -1 on terminal).",
    unit: "{execution}"
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

  // Phase 5+: hand off to the shared buildDatasetResolver in
  // packages/runtime so the worker resolves datasets the EXACT same
  // way the API does (binding override → slug cascade → per-modality
  // backend block with injected connection). When any of the core
  // three repos is missing we leave it undefined and the executor
  // falls back to "no dataset refs are resolvable", preserving the
  // legacy harness.
  //
  // Critical regression history: before this hop, the worker built
  // its own resolver inline and dropped the backend/connection
  // injection added in the PR2/PR3 rollout, which made every storage
  // plugin hard-fail in production (the dataset's backends arrived
  // without resolved connection blocks). Anything dataset-resolution
  // shaped belongs in the shared module, not here.
  const datasetResolver =
    deps.repositories.datasets &&
    deps.repositories.datasetVersions &&
    deps.repositories.datasetAliases
      ? buildDatasetResolver({
          datasets: deps.repositories.datasets,
          datasetVersions: deps.repositories.datasetVersions,
          datasetAliases: deps.repositories.datasetAliases,
          datasources: deps.repositories.datasourceConnections,
          pipelineDatasetBindings: deps.repositories.pipelineDatasetBindings,
          tenants: deps.repositories.tenants,
          environments: deps.repositories.environments
        })
      : undefined;

  // ADR-0021: External connection resolver wired the same way as
  // datasetResolver — undefined when the optional repo is absent so the
  // legacy install-free test paths keep working unchanged.
  const externalConnectionResolver = deps.repositories.externalConnections
    ? new ExternalConnectionResolver(
        deps.repositories.externalConnections,
        deps.secretProvider
      )
    : undefined;

  function executor(): DagExecutor {
    return new DagExecutor({
      pluginRegistry: deps.plugins,
      secretProvider: deps.secretProvider,
      store: runtimeStore,
      ingestStateRepository: deps.ingestStateRepository,
      datasetResolver,
      externalConnectionResolver,
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
    /**
     * Parameters declared inline on `spec.spec.parameters`. Merged on top
     * of the platform-wide config_definitions so a pipeline can ship its
     * own knobs (defaults + allowedScopes) without requiring an operator
     * to seed a separate config definition row first. A spec parameter
     * overrides a platform definition with the same key (pipelines win
     * because the spec is the version-pinned source of truth).
     */
    specParameters?: ConfigDefinition[];
  }): Promise<ResolvedConfig> {
    const platformDefinitions = await resolveDefinitions();
    const specKeys = new Set((args.specParameters ?? []).map((p) => p.key));
    const definitions = [
      ...platformDefinitions.filter((d) => !specKeys.has(d.key)),
      ...(args.specParameters ?? [])
    ];
    const resolver = new ConfigResolver(definitions);
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
    environment: string;
    enqueuedBy?: EnqueuedBy;
    error: string;
  }): Promise<void> {
    const startedAt = new Date().toISOString();
    const base: ExecutionRecord = {
      executionId: args.executionId,
      tenantId: args.tenantId,
      pipelineId: args.pipelineId,
      pipelineVersionId: args.pipelineVersionId ?? "denied",
      environment: args.environment,
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
          environment: payload.environment,
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
      runtimeOverrides: payload.runtimeOverrides,
      specParameters: spec.spec.parameters
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
    // Mark this run as in-flight on the local worker the instant we
    // start spending time on it. The matching `-1` lands in the finally
    // block so a thrown exception still rolls the gauge back.
    const inflightLabels = {
      worker_id: workerId,
      pipeline_id: payload.pipelineId,
      environment: payload.environment
    };
    inFlight.add(1, inflightLabels);
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
        worker_id: workerId,
        pipeline_id: payload.pipelineId,
        environment: payload.environment,
        status: metricStatus
      };
      executionCounter.add(1, labels);
      executionDuration.record(durationMs, labels);
      inFlight.add(-1, inflightLabels);
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
        environment: payload.environment,
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
   *  `metadata.timeoutMs`. Overridable via `RAGDOLL_DEFAULT_PIPELINE_TIMEOUT_MS`.
   *
   *  10 minutes is the operator-friendly default: a stuck-on-external-call
   *  execution gets reclaimed within a sweep cycle (5 min) of the timeout,
   *  so the operator's "what's still running?" view stays honest. The old
   *  60-minute default left orphans visible as `running` for the better
   *  part of an hour when an external (Ollama / vector store / sidecar)
   *  hung — long enough that operators concluded "broken" before the sweep
   *  fired.
   *
   *  Per-pipeline timeouts (set in the Pipelines screen → metadata.timeoutMs)
   *  still take precedence; this default only applies when nothing else
   *  governs the run. */
  const DEFAULT_PIPELINE_TIMEOUT_MS = Number(
    process.env.RAGDOLL_DEFAULT_PIPELINE_TIMEOUT_MS ?? 10 * 60 * 1000
  );

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

  /**
   * ADR-0021 — periodic probe of every non-archived external connection.
   * Resolves each row through the runtime resolver (so secrets are
   * fetched the same way pipeline execution would), invokes the
   * registered driver's probe(), and writes the result back via
   * recordProbe.
   *
   * Errors per-connection are swallowed (logged + recorded) so one bad
   * row doesn't tank the whole sweep — the next tick will retry, and
   * the Builder / admin UI shows the red badge on the failing row.
   *
   * When the registry is absent (legacy harness, no Postgres) the
   * sweep no-ops with a clear log line.
   */
  async function connectionProbeSweep(): Promise<{
    total: number;
    ok: number;
    failed: number;
    skipped: number;
  }> {
    const repo = deps.repositories.externalConnections;
    if (!repo) {
      deps.logger?.info(
        "connection_probe_sweep skipped: externalConnections repo not wired"
      );
      return { total: 0, ok: 0, failed: 0, skipped: 0 };
    }
    const rows = await repo.listAll({ includeArchived: false });
    let ok = 0;
    let failed = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        // Build a ResolvedExternalConnection synthetically. We bypass
        // the resolver's cascade walk (we already know which row we're
        // probing) but go through SecretProvider so the credential
        // resolution path matches execution time.
        let secret: string | undefined;
        if (row.secretRefId) {
          try {
            secret = await deps.secretProvider.get(
              {
                scope: row.tenantId ? "tenant" : "global",
                tenantId: row.tenantId ?? undefined,
                key: row.secretRefId
              },
              row.tenantId ?? ""
            );
          } catch {
            // Carry on without a secret — the driver may not need it,
            // or its probe will surface a clear "missing secret" error.
          }
        }
        const result = await probeConnection({
          id: row.id,
          slug: row.slug,
          kind: row.kind,
          secret,
          options: row.options ?? {},
          cascadeReason:
            row.scope === "environment"
              ? "environment"
              : row.scope === "tenant"
                ? "tenant"
                : "global"
        });
        await repo.recordProbe(row.id, {
          ok: result.ok,
          error: result.error,
          at: new Date().toISOString()
        });
        if (result.ok) ok += 1;
        else failed += 1;
      } catch (e) {
        skipped += 1;
        deps.logger?.warn("connection_probe_sweep error", {
          connectionId: row.id,
          slug: row.slug,
          kind: row.kind,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }
    deps.logger?.info("connection_probe_sweep completed", {
      total: rows.length,
      ok,
      failed,
      skipped
    });
    return { total: rows.length, ok, failed, skipped };
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
      case "connection_probe_sweep":
        return connectionProbeSweep();
      default: {
        const exhaustive: never = job.type;
        throw new Error(`unsupported job type: ${String(exhaustive)}`);
      }
    }
  }

  return { handle };
}

