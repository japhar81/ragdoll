/**
 * Cross-component e2e harness.
 *
 * Wires the framework-agnostic control-plane API (`createApp`) and the
 * framework-agnostic worker (`createWorker`) so they observe the SAME
 * in-memory stores:
 *
 *   - one `InMemoryQueue`            (API enqueues, worker drains)
 *   - one `InMemoryExecutionStore`   (API seeds + reads, worker/runtime writes)
 *   - one secret provider            (API stores, runtime resolves node secrets)
 *   - one in-memory vector store     (worker writes, assertions read)
 *   - one set of repository objects  (pipeline versions / config / vector
 *     collections / usage shared by reference between API + worker)
 *
 * Everything runs offline with `node:test` + `--experimental-strip-types`:
 * no install, no network, no parameter properties / enums / namespaces.
 */
import { createApp } from "../../apps/api/src/app.ts";
import type { AppDeps, AppRequest } from "../../apps/api/src/app.ts";
import { createWorker } from "../../apps/worker/src/handlers.ts";
import type { WorkerDeps, WorkerRepositories } from "../../apps/worker/src/handlers.ts";
import { InMemoryQueue } from "../../apps/worker/src/index.ts";
import type { QueueJob } from "../../apps/worker/src/index.ts";
import {
  AuthResolver,
  DevAuthProvider,
  ApiKeyService
} from "../../packages/auth/src/index.ts";
import {
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
  InMemoryProviderModelRepository,
  InMemoryConnectionRepository,
  InMemoryVectorCollectionRepository,
  InMemoryExecutionStore,
  InMemoryApiKeyRepository
} from "../../packages/db/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../packages/secrets/src/index.ts";
import { ConsoleJsonLogger } from "../../packages/observability/src/index.ts";
import {
  PluginRegistry,
  type InProcessPlugin
} from "../../packages/plugin-sdk/src/index.ts";
import { ProviderRegistry, type ProviderAdapter } from "../../packages/providers/src/index.ts";
import {
  InMemoryVectorStore,
  type VectorStore
} from "../../packages/vector/src/index.ts";
import type { PipelineSpec } from "../../packages/core/src/index.ts";

/* -------------------------------------------------------------------------- */
/*  Deterministic, offline, in-process fake LLM plugin                         */
/* -------------------------------------------------------------------------- */

/**
 * A deterministic LLM plugin. It resolves a node secret (so the e2e exercises
 * the secret provider end to end through the runtime) and emits a usage record
 * so the API can later report it. Mirrors the fake plugins in
 * apps/api/test/helpers.ts and apps/worker/test/handlers.test.ts.
 */
export const fakeLlmPlugin: InProcessPlugin = {
  manifest: {
    id: "fake_llm",
    name: "Fake LLM",
    version: "1.0.0",
    category: "llm",
    description: "Deterministic offline LLM used by e2e pipelines."
  },
  async execute({ inputs, secrets }) {
    // The secret was injected via the secret provider; never echo it back.
    const hasKey = typeof secrets.apiKey === "string" && secrets.apiKey.length > 0;
    return {
      outputs: {
        answer: `echo:${JSON.stringify(inputs)}`,
        keyResolved: hasKey
      },
      usage: {
        provider: "fake",
        model: "fake-1",
        inputTokens: 7,
        outputTokens: 11
      }
    };
  },
  async healthCheck() {
    return { ok: true, message: "fake llm ready" };
  }
};

export const fakeProvider: ProviderAdapter = {
  id: "fake",
  displayName: "Fake Provider",
  async chat() {
    return { text: "ok", model: "fake-1", provider: "fake" };
  },
  async models() {
    return [{ id: "fake-1", displayName: "Fake One" }];
  },
  async healthCheck() {
    return { ok: true };
  }
};

/* -------------------------------------------------------------------------- */
/*  Harness                                                                   */
/* -------------------------------------------------------------------------- */

export interface E2EHarness {
  app: ReturnType<typeof createApp>;
  worker: ReturnType<typeof createWorker>;
  queue: InMemoryQueue;
  deps: AppDeps;
  vectorStore: VectorStore & InMemoryVectorStore;
  request(
    req: Partial<AppRequest> & { method: string; path: string }
  ): Promise<{ status: number; body: any; headers: Record<string, string> }>;
  /** Drains every queued job through the SAME worker instance. */
  drain(): Promise<
    Map<string, { status: string; result?: unknown; error?: string }>
  >;
}

export interface BuildOptions {
  env?: string;
  devRoles?: string[];
  devTenant?: string;
}

export function buildE2EHarness(options: BuildOptions = {}): E2EHarness {
  // ---- shared registries -------------------------------------------------
  const pluginRegistry = new PluginRegistry();
  pluginRegistry.register({
    mode: "in_process",
    manifest: fakeLlmPlugin.manifest,
    implementation: fakeLlmPlugin
  });
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(fakeProvider);

  // ---- shared stores (single instances seen by API AND worker) -----------
  const queue = new InMemoryQueue();
  const executionStore = new InMemoryExecutionStore();
  const secretProvider = new DatabaseEncryptedSecretProvider(
    new InMemorySecretRepository(),
    new StaticKeyProvider("e2e-key")
  );
  // A fresh isolated store per harness (not the process-wide singleton) so
  // parallel test files never bleed into each other.
  const vectorStore = new InMemoryVectorStore();

  // ---- shared repositories (shared by reference) -------------------------
  const pipelineVersions = new InMemoryPipelineVersionRepository();
  const deployments = new InMemoryPipelineDeploymentRepository();
  const configDefinitions = new InMemoryConfigDefinitionRepository();
  const configValues = new InMemoryConfigValueRepository();
  const providers = new InMemoryProviderRepository();
  const vectorCollections = new InMemoryVectorCollectionRepository();
  const connections = new InMemoryConnectionRepository();
  const usageRecords = new InMemoryUsageRecordRepository();

  const apiKeys = new ApiKeyService(new InMemoryApiKeyRepository());
  const auth = new AuthResolver({
    apiKeys,
    dev: new DevAuthProvider({
      roles: (options.devRoles as any) ?? ["platform_admin"],
      tenantId: options.devTenant
    })
  });

  const deps: AppDeps = {
    tenants: new InMemoryTenantRepository(),
    pipelines: new InMemoryPipelineRepository(),
    pipelineVersions,
    deployments,
    configDefinitions,
    configValues,
    auditLogs: new InMemoryAuditLogRepository(),
    usageRecords,
    plugins: new InMemoryPluginRepository(),
    providers,
    connections,
    vectorCollections,
    executionStore,
    auth,
    apiKeys,
    queue,
    secretProvider,
    pluginRegistry,
    providerRegistry,
    logger: new ConsoleJsonLogger(),
    env: options.env ?? "development"
  };

  const app = createApp(deps);

  const workerRepositories: WorkerRepositories = {
    pipelineVersions,
    configDefinitions,
    configValues,
    providers,
    providerModels: new InMemoryProviderModelRepository(),
    vectorCollections,
    connections,
    usageRecords
  };

  const workerDeps: WorkerDeps = {
    store: executionStore,
    plugins: pluginRegistry,
    providers: providerRegistry,
    secretProvider,
    vectorStore,
    repositories: workerRepositories,
    maxRetries: 0
  };

  const worker = createWorker(workerDeps);

  async function request(
    req: Partial<AppRequest> & { method: string; path: string }
  ) {
    return app.handle({
      method: req.method,
      path: req.path,
      query: req.query ?? {},
      headers: req.headers ?? {},
      body: req.body
    });
  }

  async function drain() {
    return queue.drain((job: QueueJob, signal) => worker.handle(job, signal));
  }

  return {
    app,
    worker,
    queue,
    deps,
    vectorStore,
    request,
    drain
  };
}

/* -------------------------------------------------------------------------- */
/*  Spec fixtures                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A minimal valid pipeline that runs the fake LLM. The llm node references a
 * tenant-scoped secret so the runtime resolves it through the shared secret
 * provider during execution.
 */
export function llmSpec(name = "e2e-llm-pipeline", tenantId = "tenant-a"): PipelineSpec {
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name },
    spec: {
      nodes: [
        { id: "in", type: "input" },
        {
          id: "llm",
          plugin: { category: "llm", id: "fake_llm", version: "1.0.0" },
          secrets: {
            apiKey: {
              provider: "database_encrypted",
              scope: "tenant",
              tenantId,
              key: "fake.api_key"
            }
          }
        },
        { id: "out", type: "output" }
      ],
      edges: [
        { from: "in", to: "llm" },
        { from: "llm", to: "out" }
      ]
    }
  };
}
