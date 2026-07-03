/**
 * Shared test harness for the framework-agnostic API. Builds `createApp` with
 * fully in-memory dependencies plus a deterministic fake in-process plugin so
 * the suite runs offline with zero install.
 */
import { createApp, type AppDeps, type AppRequest } from "../src/app.ts";
import {
  AuthResolver,
  DevAuthProvider,
  ApiKeyService,
  SessionTokenService,
  Authorizer
} from "../../../packages/auth/src/index.ts";
import {
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
  InMemoryEventSubscriptionRepository,
  InMemoryWebhookDeliveryFailureRepository,
  InMemoryUsageRecordRepository,
  InMemoryPluginRepository,
  InMemoryProviderRepository,
  InMemoryConnectionRepository,
  InMemoryPipelineDatasetBindingRepository,
  InMemoryDatasetRepository,
  InMemoryDatasetVersionRepository,
  InMemoryDatasetAliasRepository,
  InMemoryVectorCollectionRepository,
  InMemoryExecutionStore,
  InMemoryApiKeyRepository,
  InMemoryUserRepository,
  InMemoryUserIdentityRepository,
  InMemoryIdentityProviderRepository,
  InMemoryRbacPolicyRepository,
  InMemoryAuthSettingsRepository,
  InMemoryRoleRepository,
  InMemoryWebhookTriggerRepository
} from "../../../packages/db/src/index.ts";
import {
  DatabaseEncryptedSecretProvider,
  InMemorySecretRepository,
  StaticKeyProvider
} from "../../../packages/secrets/src/index.ts";
import { ConsoleJsonLogger } from "../../../packages/observability/src/index.ts";
import { InMemoryQueue } from "../../../apps/worker/src/index.ts";
import type { ChangeBus } from "../../../packages/events/src/index.ts";
import { PluginRegistry, type InProcessPlugin } from "../../../packages/plugin-sdk/src/index.ts";
import * as pluginLoaderForTests from "../../../packages/plugin-loader/src/index.ts";
import { ProviderRegistry, type ProviderAdapter } from "../../../packages/providers/src/index.ts";
import type { PipelineSpec } from "../../../packages/core/src/index.ts";

/** Deterministic echo plugin used by deployable test pipelines. */
export const fakeEchoPlugin: InProcessPlugin = {
  manifest: {
    id: "fake_echo",
    name: "Fake Echo",
    version: "1.0.0",
    category: "transformer",
    description: "Returns its inputs verbatim for tests.",
    configSchema: {
      type: "object",
      properties: {
        label: { type: "string", default: "echo", description: "Test label." }
      },
      additionalProperties: false
    },
    capabilities: ["query"],
    ui: {
      icon: "repeat",
      paletteGroup: "Test",
      formHints: { label: { widget: "text" } }
    }
  },
  async execute(input) {
    return { outputs: { echoed: input.inputs }, usage: { inputTokens: 1, outputTokens: 1 } };
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

export interface Harness {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  queue: InMemoryQueue;
  /** Session signer (mint Bearer tokens directly in tests). */
  sessions: SessionTokenService;
  request(req: Partial<AppRequest> & { method: string; path: string }): Promise<{
    status: number;
    body: any;
    headers: Record<string, string>;
  }>;
}

export interface BuildOptions {
  env?: string;
  /** Roles assigned to the dev fallback principal. */
  devRoles?: string[];
  /** Tenant assigned to the dev fallback principal. */
  devTenant?: string;
  /**
   * Wire the full auth/RBAC stack (sessions, accounts, Authorizer + scoped
   * default-deny) and DISABLE the dev provider, exercising the real production
   * code path. Existing tests omit this and keep the legacy dev/flat-RBAC
   * behaviour unchanged.
   */
  withAuth?: boolean;
  /** Inject a specific change-event bus so a test can subscribe and assert
   *  what gets published. When omitted createApp uses its in-process fallback
   *  (invisible to the test). */
  changeBus?: ChangeBus;
  /** Inject a platform-plugin dispatcher so a test can exercise the PRE-lane
   *  mutation gate (ADR 0036). */
  platformDispatcher?: AppDeps["platformDispatcher"];
}

export function buildHarness(options: BuildOptions = {}): Harness {
  const pluginRegistry = new PluginRegistry();
  pluginRegistry.register({
    mode: "in_process",
    manifest: fakeEchoPlugin.manifest,
    implementation: fakeEchoPlugin
  });
  const pluginRegistryHolderForDeps = new pluginLoaderForTests.PluginRegistryHolder(
    pluginRegistry,
    []
  );
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(fakeProvider);

  const queue = new InMemoryQueue();

  const sessions = new SessionTokenService("test-session-secret");
  // One ApiKeyService shared by the resolver and the app so a key minted via
  // POST /api/api-keys is immediately verifiable.
  const apiKeys = new ApiKeyService(new InMemoryApiKeyRepository());
  const auth = new AuthResolver({
    sessions,
    apiKeys,
    // Strict default-deny harness: no header-trusting dev provider.
    dev: options.withAuth
      ? undefined
      : new DevAuthProvider({
          roles: (options.devRoles as any) ?? ["platform_admin"],
          tenantId: options.devTenant
        })
  });

  const rbacPolicies = new InMemoryRbacPolicyRepository();
  const authStack = options.withAuth
    ? {
        users: new InMemoryUserRepository(),
        userIdentities: new InMemoryUserIdentityRepository(),
        identityProviders: new InMemoryIdentityProviderRepository(),
        rbacPolicies,
        authSettings: new InMemoryAuthSettingsRepository(),
        roles: new InMemoryRoleRepository(),
        webhookTriggers: new InMemoryWebhookTriggerRepository(),
        authorizer: new Authorizer({ store: rbacPolicies }),
        sessions
      }
    : {};

  const deps: AppDeps = {
    ...authStack,
    tenants: new InMemoryTenantRepository(),
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
    eventSubscriptions: new InMemoryEventSubscriptionRepository(),
    webhookFailures: new InMemoryWebhookDeliveryFailureRepository(),
    auditLogs: new InMemoryAuditLogRepository(),
    usageRecords: new InMemoryUsageRecordRepository(),
    plugins: new InMemoryPluginRepository(),
    providers: new InMemoryProviderRepository(),
    connections: new InMemoryConnectionRepository(),
    pipelineDatasetBindings: new InMemoryPipelineDatasetBindingRepository(),
    datasets: new InMemoryDatasetRepository(),
    datasetVersions: new InMemoryDatasetVersionRepository(),
    datasetAliases: new InMemoryDatasetAliasRepository(),
    vectorCollections: new InMemoryVectorCollectionRepository(),
    executionStore: new InMemoryExecutionStore(),
    auth,
    apiKeys,
    changeBus: options.changeBus,
    platformDispatcher: options.platformDispatcher,
    queue,
    secretProvider: new DatabaseEncryptedSecretProvider(
      new InMemorySecretRepository(),
      new StaticKeyProvider("test-key")
    ),
    // PLUGIN-ARCH-1: wire the holder + an empty in-memory source store
    // so tests can exercise /api/plugins/sources + /api/plugins/refresh
    // without spinning up Postgres. The holder wraps the same registry
    // we built above so /api/plugins keeps returning the seeded
    // fake_echo plugin from the legacy path. Critically:
    // `pluginRegistry` is the holder (not the raw registry) so a
    // `holder.swap()` reaches routes that destructure deps.pluginRegistry
    // — exactly the wiring `apps/api/src/server.ts` uses in prod.
    pluginRegistry: pluginRegistryHolderForDeps,
    pluginRegistryHolder: pluginRegistryHolderForDeps,
    pluginSourceStore: new pluginLoaderForTests.InMemoryPluginSourceStore([]),
    providerRegistry,
    logger: new ConsoleJsonLogger(),
    env: options.env ?? "development"
  };

  const app = createApp(deps);

  async function request(
    req: Partial<AppRequest> & { method: string; path: string }
  ) {
    const res = await app.handle({
      method: req.method,
      path: req.path,
      query: req.query ?? {},
      headers: req.headers ?? {},
      body: req.body
    });
    // Phase 13: /stream and friends return async-iterable bodies for real
    // chunked SSE. Tests assert against a single string, so consume the
    // stream here and join the chunks; the wire is exactly what the
    // Fastify-driven stack would have piped.
    const body = res.body as unknown;
    if (
      body &&
      typeof body === "object" &&
      typeof (body as AsyncIterable<string>)[Symbol.asyncIterator] === "function"
    ) {
      const chunks: string[] = [];
      for await (const chunk of body as AsyncIterable<string>) {
        chunks.push(chunk);
      }
      return { ...res, body: chunks.join("") };
    }
    return res;
  }

  return { app, deps, queue, request, sessions };
}

/** A minimal valid pipeline spec referencing only the fake echo plugin. */
export function echoSpec(name = "echo-pipeline"): PipelineSpec {
  return {
    apiVersion: "rag-platform/v1",
    kind: "Pipeline",
    metadata: { name },
    spec: {
      nodes: [
        { id: "in", type: "input" },
        {
          id: "echo",
          plugin: { category: "transformer", id: "fake_echo", version: "1.0.0" }
        },
        { id: "out", type: "output" }
      ],
      edges: [
        { from: "in", to: "echo" },
        { from: "echo", to: "out" }
      ]
    }
  };
}
