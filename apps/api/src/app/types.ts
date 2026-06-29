/**
 * Request / response / dependency contracts for the framework-agnostic
 * RAGdoll API. The framework wrapper (apps/api/src/server.ts) translates
 * Fastify Request/Reply into AppRequest/AppResponse so this file —
 * along with app.ts — has zero http-framework dependencies.
 */

import type {
  ConfigDefinitionRepository,
  ConfigValueRepository,
  AuditLogRepository,
  UsageRecordRepository,
  RetentionSettingsRepository,
  PluginRepository,
  ProviderRepository,
  ConnectionRepository,
  PipelineDatasetBindingRepository,
  VectorCollectionRepository,
  TenantRepository,
  PipelineRepository,
  PipelineVersionRepository,
  PipelineDeploymentRepository,
  PipelineFolderRepository,
  PipelineActivationRepository,
  ScheduleRepository,
  TenantGitConfigRepository,
  TenantPipelineRepository,
  EnvironmentRepository,
  DatasetRepository,
  DatasetVersionRepository,
  DatasetAliasRepository,
  UserRepository,
  UserIdentityRepository,
  IdentityProviderRepository,
  RbacPolicyRepository,
  AuthSettingsRepository,
  RoleRepository,
  WebhookTriggerRepository,
  PoolLike
} from "../../../../packages/db/src/index.ts";
import type {
  ExecutionStore,
  ExecutionRecord,
  ExecutionNodeRecord
} from "../../../../packages/runtime/src/index.ts";
import type { SecretProvider } from "../../../../packages/secrets/src/index.ts";
import type { PluginRegistry } from "../../../../packages/plugin-sdk/src/index.ts";
import type { ProviderRegistry } from "../../../../packages/providers/src/index.ts";
import type { StructuredLogger } from "../../../../packages/observability/src/index.ts";
import type { QueuePort, QueueJob } from "../../../worker/src/index.ts";
import type {
  AuthResolver,
  ApiKeyService,
  Authorizer,
  AccountService,
  SessionTokenService
} from "../../../../packages/auth/src/index.ts";
import type { ChangeBus } from "../../../../packages/events/src/index.ts";
import type {
  SsoStateStore,
  IdentityProviderRegistry
} from "../../../../packages/auth/src/index.ts";

/**
 * The shared queue contract specifies `QueueJob.type` includes `"run_pipeline"`
 * and `"ingest_datasource"`. The worker package's current `QueueJob` union does
 * not yet list `"run_pipeline"`, so we widen the type locally to stay
 * forward-compatible without editing the worker package.
 */
export type ApiQueueJobType = QueueJob["type"] | "run_pipeline";
export interface ApiQueueJob<T> extends Omit<QueueJob<T>, "type"> {
  type: ApiQueueJobType;
}

export interface AppRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface AppResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface CursorPage<T> {
  rows: T[];
  /** Opaque continuation token, or null when there are no more rows. */
  nextCursor: string | null;
  /** Total rows under the same filter (NOT the cursor slice). Drives
   *  the SVAR grid footer "N of M" display. */
  total: number;
}

/**
 * An execution store the API can both write to (when seeding from a queued
 * run) and read traces from. The runtime `ExecutionStore` only defines writes;
 * for the control plane we also need read access via async query methods, so
 * the app accepts a `ReadableExecutionStore`. The InMemory store implements
 * the async methods over its in-process arrays (which it still exposes as the
 * optional sync `executions`/`nodes` for tests); a Postgres-backed reader
 * queries the executions / execution_nodes tables.
 */
export interface ReadableExecutionStore extends ExecutionStore {
  /** `pipelineId` scopes to a single pipeline's runs; omit for all pipelines. */
  listExecutions(
    tenantId?: string,
    pipelineId?: string
  ): Promise<ExecutionRecord[]>;
  /**
   * Cursor-paginated list ordered by (started_at DESC, id DESC). Optional
   * on the interface so the in-memory test store can fall back to the
   * full `listExecutions` slicing — Postgres-backed deployments override.
   * `pipelineId` scopes the page (and its total) to one pipeline's runs.
   */
  listExecutionsPage?(args: {
    tenantId?: string;
    pipelineId?: string;
    limit: number;
    cursor?: string;
  }): Promise<CursorPage<ExecutionRecord>>;
  getExecution(executionId: string): Promise<ExecutionRecord | undefined>;
  listNodes(executionId: string): Promise<ExecutionNodeRecord[]>;
  /** Optional sync arrays kept by the InMemory store for tests. */
  executions?: ExecutionRecord[];
  nodes?: ExecutionNodeRecord[];
}

export interface AppDeps {
  tenants: TenantRepository;
  pipelines: PipelineRepository;
  pipelineVersions: PipelineVersionRepository;
  deployments: PipelineDeploymentRepository;
  /**
   * Org/versioning/scheduler repositories. Optional so older harnesses that
   * predate Wave B (e.g. the cross-component e2e harness) still construct a
   * valid `AppDeps`; when omitted `createApp` falls back to fresh InMemory
   * instances so the new routes remain fully functional.
   */
  pipelineFolders?: PipelineFolderRepository;
  pipelineActivations?: PipelineActivationRepository;
  schedules?: ScheduleRepository;
  tenantPipelines?: TenantPipelineRepository;
  environments?: EnvironmentRepository;
  /**
   * Datasets / dataset versions / dataset aliases (Phase 4). Optional so
   * the legacy harness still constructs a valid AppDeps; when omitted
   * createApp falls back to fresh InMemory instances.
   */
  datasets?: DatasetRepository;
  datasetVersions?: DatasetVersionRepository;
  datasetAliases?: DatasetAliasRepository;
  configDefinitions: ConfigDefinitionRepository;
  configValues: ConfigValueRepository;
  auditLogs: AuditLogRepository;
  usageRecords: UsageRecordRepository;
  /** Retention caps for executions/usage/audit. Optional so legacy harnesses
   *  still build a valid AppDeps; createApp falls back to an InMemory impl. */
  retentionSettings?: RetentionSettingsRepository;
  plugins: PluginRepository;
  providers: ProviderRepository;
  /** ADR-0023 Unified Connections Registry. Consolidates the old
   *  `datasources` (ADR-0020) and `externalConnections` (ADR-0021)
   *  fields into one. */
  connections: ConnectionRepository;
  /** Per-(pipeline, tenant, env) dataset binding overrides (PR3). */
  pipelineDatasetBindings?: PipelineDatasetBindingRepository;
  vectorCollections: VectorCollectionRepository;
  executionStore: ReadableExecutionStore;
  auth: AuthResolver;
  queue: QueuePort;
  secretProvider: SecretProvider;
  pluginRegistry: PluginRegistry;
  /** PLUGIN-ARCH-1: when present, /api/plugins/sources + /api/plugins/refresh
   *  light up. Holder owns the current `PluginRegistry` reference; refresh
   *  rebuilds + swaps it atomically (in-flight requests keep the snapshot
   *  they already resolved). Optional so legacy harnesses + tests without
   *  a source store still construct a valid `AppDeps`. */
  pluginRegistryHolder?: import("../../../../packages/plugin-loader/src/index.ts").PluginRegistryHolder;
  pluginSourceStore?: import("../../../../packages/plugin-loader/src/index.ts").PluginSourceStore;
  providerRegistry: ProviderRegistry;
  logger: StructuredLogger;
  /** RAGDOLL_ENV; the dev auth fallback is rejected when this is "production". */
  env?: string;
  /** Optional Postgres pool, threaded through so /readyz can ping the DB.
   *  Omit on in-memory harnesses; the readiness check skips DB when absent. */
  pool?: PoolLike;
  /**
   * Auth / RBAC stores. Optional so legacy harnesses still construct a valid
   * `AppDeps`; `createApp` falls back to fresh InMemory instances. When
   * `authorizer` is wired, route-level `enforce(...)` becomes scoped
   * default-deny RBAC; otherwise the legacy flat role map is used.
   */
  users?: UserRepository;
  userIdentities?: UserIdentityRepository;
  identityProviders?: IdentityProviderRepository;
  rbacPolicies?: RbacPolicyRepository;
  authSettings?: AuthSettingsRepository;
  roles?: RoleRepository;
  webhookTriggers?: WebhookTriggerRepository;
  /**
   * Per-tenant Git storage config (migration 007). Optional so legacy
   * harnesses keep working; the storage routes 404 when omitted.
   */
  tenantGitConfigs?: TenantGitConfigRepository;
  /** Resolves a principal's scoped grants; attaches the per-request decider. */
  authorizer?: Authorizer;
  /** Session signer used for login/SSO; required for the auth routes. */
  sessions?: SessionTokenService;
  /** Built from the stores when omitted (needs `sessions`). */
  accounts?: AccountService;
  /**
   * Issues / lists / revokes API keys. SHOULD be the same instance handed to
   * the `AuthResolver` so a key minted via `POST /api/api-keys` is immediately
   * verifiable. When omitted `createApp` falls back to a fresh in-memory
   * service (its keys then won't be recognised by an unrelated resolver).
   */
  apiKeys?: ApiKeyService;
  /**
   * Change-event bus. Every audited mutation publishes a ChangeEvent;
   * the WebSocket endpoint (`/api/events`) fans events out to subscribed
   * clients so the web UI updates in real time. Multi-replica deploys MUST
   * pass a Redis-backed bus so events cross processes; when omitted
   * `createApp` falls back to in-process pubsub (single-replica + tests).
   */
  changeBus?: ChangeBus;
  /**
   * Store for pending SSO state (10-minute TTL between OIDC/SAML start and
   * callback). Multi-replica deploys MUST pass a Redis-backed store so a
   * callback that lands on a different api pod than the start can find
   * the entry; when omitted, the auth-sso route falls back to an
   * in-process Map (single-replica + tests). See ADR 0005.
   */
  ssoStateStore?: SsoStateStore;
  /**
   * Identity-provider registry (ADR 0035). Holds the built-in OIDC + SAML
   * providers; server.ts loads a custom provider from
   * RAGDOLL_IDENTITY_PROVIDER and passes the populated registry here. When
   * omitted, the app builds a default registry (built-ins only) — keeps
   * tests + minimal embeds working unchanged.
   */
  identityProviderRegistry?: IdentityProviderRegistry;
}

export interface App {
  handle(request: AppRequest): Promise<AppResponse>;
}
