/**
 * Two execution paths the API exposes:
 *
 * - `enqueuePipelineRun` — async / queue-backed. Resolves the
 *   effective pipeline version (via activations or deployments),
 *   validates the spec, mints an executionId, writes the `running`
 *   record, and enqueues a BullMQ `run_pipeline` job. Returns the
 *   execution + job ids; the worker does the actual DAG execution.
 *
 * - `runSyncPipeline` — synchronous, in-process. Reuses the worker's
 *   DagExecutor inside the API pod so chat-style retrieval returns
 *   in one HTTP round-trip. Supports nested `pipeline_call` to a
 *   bounded depth and cycle detection across the call chain.
 *
 * - `buildApiDatasetResolver` builds the v2 DatasetResolver the
 *   in-process executor uses; nothing to do when the dataset repos
 *   aren't wired (legacy harness — falls back to literal collections).
 */
import { randomUUID } from "node:crypto";
import {
  redactValue,
  type ConfigValue,
  type PipelineSpec
} from "../../../../packages/core/src/index.ts";
import { ConfigResolver } from "../../../../packages/config-resolver/src/index.ts";
import {
  validatePipelineSpec,
  resolveActivation,
  effectiveVersionId,
  ActivationResolutionError
} from "../../../../packages/pipeline-spec/src/index.ts";
import { DagExecutor, buildDatasetResolver } from "../../../../packages/runtime/src/index.ts";
import { ExternalConnectionResolver } from "../../../../packages/external-connections/src/index.ts";
import type {
  PipelineActivationRow,
  PipelineActivationRepository,
  PipelineRow,
  PipelineVersionRow
} from "../../../../packages/db/src/index.ts";
import type {
  DatasetResolver
} from "../../../../packages/plugin-sdk/src/index.ts";
import type { QueueJob } from "../../../worker/src/index.ts";
import { error, nowIso, isObject } from "./http-utils.ts";
import { resolveDeployedVersion } from "./spec-helpers.ts";
import type { AppDeps, AppResponse, ApiQueueJob } from "./types.ts";

/**
 * Max depth for synchronous pipeline_call chains. Pipeline A → B → A
 * deadlocks otherwise; a hard cap of 8 is conservative for real RAG
 * compositions (you'd normally see 2-3 levels: planner → retriever
 * → answer-shaper) and trips fast on accidental cycles.
 */
export const MAX_SYNC_DEPTH = 8;

export type EnqueueRunOk = {
  ok: true;
  executionId: string;
  jobId: string;
  versionId: string;
  version: string;
  resolvedVia: "activation" | "deployment";
  activationLabel?: string;
};

export type EnqueueRunResult =
  | EnqueueRunOk
  | { ok: false; response: AppResponse };

/**
 * Enqueue a run_pipeline job and seed the executions table. The
 * `pipelineActivations` repo is required (createApp resolves it with
 * an InMemory fallback before calling here).
 */
export async function enqueuePipelineRun(args: {
  deps: AppDeps;
  pipelineActivations: PipelineActivationRepository;
  tenantId: string;
  pipeline: PipelineRow;
  environment: string;
  activationLabel?: string;
  input: unknown;
}): Promise<EnqueueRunResult> {
  const {
    deps,
    pipelineActivations,
    tenantId,
    pipeline,
    environment,
    activationLabel,
    input
  } = args;
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
    resolved = await resolveDeployedVersion(deps, pipelineId, environment, tenantId);
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
    // persist state on each attempt, so a failed first attempt that
    // wrote state turns retry #2 into a no-op (all docs "unchanged").
    // One shot; surface failures immediately.
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
    environment,
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

/**
 * Build the v2 DatasetResolver the API's in-process executor uses for
 * synchronous /invoke + /stream runs. Returns undefined when any of
 * the three dataset repos is missing (legacy harness path).
 */
export function buildApiDatasetResolver(
  deps: AppDeps
): DatasetResolver | undefined {
  if (!deps.datasets || !deps.datasetVersions || !deps.datasetAliases) {
    return undefined;
  }
  // Delegate to the shared builder in packages/runtime so the API and
  // the worker both run the SAME resolution logic (binding override →
  // slug cascade → backend connection injection → namespace policy).
  // Earlier attempts duplicated this inline in handlers.ts and silently
  // dropped the connection-injection path, which crashed every storage
  // plugin. The tenants/environments deps power the PR6 namespace
  // suffix expansion (`by-tenant`, `by-env`, `by-tenant-env`).
  return buildDatasetResolver({
    datasets: deps.datasets,
    datasetVersions: deps.datasetVersions,
    datasetAliases: deps.datasetAliases,
    connections: deps.connections,
    // Resolver needs the SecretProvider to attach binding-connection
    // credentials at resolve time. Without this, neo4j/postgres/mongo
    // drivers see `secret: undefined` and auth fails even though
    // /probe on the same connection succeeds.
    secrets: deps.secretProvider,
    pipelineDatasetBindings: deps.pipelineDatasetBindings,
    tenants: deps.tenants,
    environments: deps.environments
  });
}

/**
 * Run a pipeline version in-process and return its terminal output.
 * Skips the queue entirely — the API pod does the whole DAG
 * execution itself, so chat-style retrieval can return in one HTTP
 * round-trip. Reuses the same DagExecutor the worker uses (including
 * the Phase 5 dataset resolver) so v2 plugins behave identically on
 * both paths.
 */
export async function runSyncPipeline(args: {
  deps: AppDeps;
  apiDatasetResolver: DatasetResolver | undefined;
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
  /** Token-streaming callback for streaming-capable plugins. */
  onToken?: (event: { nodeId: string; token: string }) => void;
}): Promise<{ executionId: string; output: Record<string, unknown> }> {
  const { deps, apiDatasetResolver, tenantId, pipeline, versionRow, environment, input } = args;
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
  // Nested sync invocations. The closure captures tenantId + the call
  // stack so cycle detection works across arbitrary depths, and the
  // target pipeline's deployment lookup is done at the moment of the
  // call (so a target redeployed mid-run picks up the new version
  // on the next nested call).
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
    const subVersion = await resolveDeployedVersion(deps, target.id, subEnv, tenantId);
    if (!subVersion) {
      throw new Error(
        `pipeline_call: pipeline "${sub.slug}" has no active deployment in ${subEnv}`
      );
    }
    const nested = await runSyncPipeline({
      deps,
      apiDatasetResolver,
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
  // ADR-0021: external connection resolver, lazy-built so test paths
  // without a connections repo get `undefined` and `connection:`-bearing
  // nodes simply receive `input.connection = undefined` (no behaviour
  // change for legacy pipelines).
  const externalConnectionResolver = deps.connections
    ? new ExternalConnectionResolver(deps.connections, deps.secretProvider)
    : undefined;
  const executor = new DagExecutor({
    pluginRegistry: deps.pluginRegistry,
    secretProvider: deps.secretProvider,
    store: deps.executionStore,
    datasetResolver: apiDatasetResolver,
    externalConnectionResolver,
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
      actor: args.actorId ? { id: args.actorId, type: "user" } : undefined,
      deadline: args.deadlineMs ? new Date(args.deadlineMs) : undefined
    },
    input: (isObject(input) ? input : {}) as Record<string, unknown>
  });
  return { executionId, output };
}
