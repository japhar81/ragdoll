import type {
  ConfigScope,
  ConfigValueType,
  PluginCategory,
  UUID
} from "../../core/src/index.ts";
import type { Role } from "../../authz/src/index.ts";

// --- Control-plane entity row shapes -------------------------------------------------

export interface TenantRow {
  id: UUID;
  slug: string;
  name: string;
  status: string;
  metadata: Record<string, unknown>;
  /**
   * 'db' (default) keeps pipelines/configs/secrets in Postgres only.
   * 'git' mirrors the same state to a Git repo via @ragdoll/git-storage —
   * the repo is system of record, the DB is a cache kept fresh by polling.
   * Optional on the create payload; the DB column defaults to 'db' and
   * the persisted row always carries one of the two values back.
   */
  storageMode?: "db" | "git";
  createdAt: string;
  updatedAt: string;
}

/**
 * Side-table for `storage_mode='git'` tenants: where the repo lives,
 * how to authenticate, and the wrapped data-encryption key the secrets
 * bundle is encrypted with. See migration 007.
 */
export interface TenantGitConfigRow {
  tenantId: UUID;
  remoteUrl: string;
  branch: string;
  /** Folder prefix inside the repo; the layout below is
   *  `{pathPrefix}/{tenantSlug}/{envSlug}/...`. Empty string = repo root. */
  pathPrefix: string;
  authMethod: "https" | "ssh";
  /** UUID of a SecretRecord holding either an HTTPS PAT or an SSH key. */
  authSecretId: UUID;
  /** AES-256-GCM DEK, wrapped by the instance KEK. */
  dekWrapped: string;
  pollIntervalSec: number;
  lastSyncedSha?: string | null;
  lastSyncedAt?: string | null;
  lastSyncError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentRow {
  id: UUID;
  tenantId: UUID;
  name: string;
  description?: string | null;
  isProduction: boolean;
  createdAt: string;
}

export interface UserRow {
  id: UUID;
  email: string;
  displayName?: string | null;
  /**
   * scrypt hash for local-password users (see @ragdoll/auth `PasswordService`).
   * Null for SSO-only users, who authenticate via a `user_identities` row.
   */
  passwordHash?: string | null;
  /** `active` | `disabled`. Disabled users can authenticate to nothing. */
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoleRow {
  id: UUID;
  name: string;
  description?: string | null;
}

export interface UserRoleRow {
  userId: UUID;
  roleId: UUID;
  tenantId?: UUID | null;
  environment?: string | null;
  pipelineId?: UUID | null;
}

/**
 * A federated identity: maps an external IdP subject onto a local user so the
 * same person keeps one identity/grant set across OIDC, SAML, and local login.
 */
export interface UserIdentityRow {
  id: UUID;
  userId: UUID;
  /** Identity-provider slug (`local` is reserved for password auth). */
  provider: string;
  /** Stable external subject (OIDC `sub` / SAML NameID). */
  subject: string;
  email?: string | null;
  createdAt: string;
}

export type IdentityProviderKind = "oidc" | "saml";

/** A configurable SSO connection. Secrets are referenced, never stored here. */
export interface IdentityProviderRow {
  id: UUID;
  slug: string;
  kind: IdentityProviderKind;
  displayName: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Casbin `p` policy row: a role grants a permission (scope-independent). */
export interface RbacRolePermissionRow {
  role: string;
  permission: string;
}

/** Casbin `g` policy row: a user holds a role within a hierarchical scope. */
export interface RbacGrantRow {
  id: UUID;
  userId: UUID;
  role: string;
  /** `*` | `t/<tenantId>` | `t/<tenantId>/e/<env>` | `t/<tenantId>/p/<pipelineId>`. */
  scope: string;
  createdAt: string;
}

export type SignupMode = "admin_only" | "open_default_role" | "open_no_access";

export interface AuthSettingsRow {
  signupMode: SignupMode;
  /** Role assigned at global scope to self-signups when `open_default_role`. */
  defaultRole?: string | null;
  updatedAt: string;
}

/**
 * A public webhook URL bound to a tenant/pipeline/env (+optional activation
 * label). Only the hash + prefix are stored; the plaintext is shown once at
 * create time and POSTed by external systems to start a run.
 */
export interface WebhookTriggerRow {
  id: UUID;
  tenantId: UUID;
  pipelineId: UUID;
  environment: string;
  activationLabel?: string | null;
  name: string;
  prefix: string;
  hash: string;
  enabled: boolean;
  createdBy?: UUID | null;
  createdAt: string;
  lastTriggeredAt?: string | null;
  revokedAt?: string | null;
}

export interface PipelineRow {
  id: UUID;
  slug: string;
  name: string;
  description?: string | null;
  labels: Record<string, string>;
  folderId?: UUID | null;
  latestVersionId?: UUID | null;
  createdBy?: UUID | null;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineVersionRow {
  id: UUID;
  pipelineId: UUID;
  version: string;
  status: "draft" | "published" | "archived";
  spec: unknown;
  checksum: string;
  parentVersionId?: UUID | null;
  createdBy?: UUID | null;
  createdAt: string;
  publishedAt?: string | null;
}

export interface PipelineFolderRow {
  id: UUID;
  parentId?: UUID | null;
  name: string;
  createdAt: string;
}

export interface PipelineFolderTreeNode extends PipelineFolderRow {
  children: PipelineFolderTreeNode[];
}

export interface PipelineActivationRow {
  id: UUID;
  tenantId: UUID;
  pipelineId: UUID;
  environment: string;
  label: string;
  pipelineVersionId?: UUID | null;
  trackLatest: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface ScheduleRow {
  id: UUID;
  /** Null for `system` schedules — those have no tenant/pipeline scope. */
  tenantId: UUID | null;
  /** Null for `system` schedules — those have no tenant/pipeline scope. */
  pipelineId: UUID | null;
  /** Null for `system` schedules. */
  environment: string | null;
  activationLabel?: string | null;
  cron: string;
  timezone: string;
  input: Record<string, unknown>;
  enabled: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  createdAt: string;
  /**
   * Identifier of the principal that created the schedule. The scheduler
   * re-resolves their grants at fire time so a creator who lost
   * `pipeline:run` can't keep firing runs through schedules they made.
   * Optional for backward-compat with pre-Phase-2 rows; absent means the
   * legacy "trust the schedule" behaviour (no re-check).
   */
  createdBy?: UUID | null;
  /**
   * Type of queue job this schedule enqueues. Defaults to `run_pipeline`
   * (the only kind pre-Phase-12). Platform sweepers use `stale_exec_sweep`
   * and `retention_sweep` and carry tenant/pipeline/environment NULL.
   */
  jobType?: string;
  /**
   * Un-deletable platform schedule. The UI hides delete on these rows;
   * cadence is still editable.
   */
  system?: boolean;
  /** Display name for the schedule. Required on `system` rows so the UI
   *  has something to render in lieu of a pipeline link. */
  name?: string | null;
  /** Job-specific parameters merged onto the enqueued payload. */
  params?: Record<string, unknown>;
}

export interface PipelineDeploymentRow {
  id: UUID;
  pipelineId: UUID;
  pipelineVersionId: UUID;
  environment: string;
  tenantId?: UUID | null;
  status: string;
  deployedBy?: UUID | null;
  deployedAt: string;
}

export interface TenantPipelineRow {
  tenantId: UUID;
  pipelineId: UUID;
  environment: string;
  enabled: boolean;
  vectorIsolation: Record<string, unknown>;
  providerPolicy: Record<string, unknown>;
  rateLimitPolicy: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigDefinitionRow {
  key: string;
  type: ConfigValueType;
  defaultValue?: unknown;
  allowedScopes: ConfigScope[];
  required: boolean;
  secret: boolean;
  sensitive: boolean;
  overridable: boolean;
  inherited: boolean;
  nullable: boolean;
  tenantOverridable: boolean;
  runtimeOverridable: boolean;
  validation: Record<string, unknown>;
  description?: string | null;
}

export interface ConfigValueRow {
  id: UUID;
  key: string;
  value: unknown;
  scope: ConfigScope;
  scopeId?: string | null;
  locked: boolean;
  createdBy?: UUID | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogRow {
  id: UUID;
  actorId?: UUID | null;
  tenantId?: UUID | null;
  pipelineId?: UUID | null;
  action: string;
  targetType: string;
  targetId: string;
  beforeRedacted?: unknown;
  afterRedacted?: unknown;
  requestId?: string | null;
  sourceIp?: string | null;
  userAgent?: string | null;
  createdAt: string;
}

export interface UsageRecordRow {
  id: UUID;
  tenantId: UUID;
  pipelineId?: UUID | null;
  executionId?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  embeddingTokens: number;
  estimatedCostUsd: number;
  latencyMs?: number | null;
  success: boolean;
  createdAt: string;
}

export interface PluginRow {
  id: UUID;
  pluginId: string;
  category: PluginCategory;
  name: string;
  description?: string | null;
  createdAt: string;
}

export interface PluginVersionRow {
  id: UUID;
  pluginId: UUID;
  version: string;
  manifest: Record<string, unknown>;
  mode: "in_process" | "external";
  endpoint?: Record<string, unknown> | null;
  status: string;
  createdAt: string;
}

export interface ProviderRow {
  id: UUID;
  providerId: string;
  displayName: string;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModelRow {
  id: UUID;
  providerId: UUID;
  modelId: string;
  displayName?: string | null;
  contextWindow?: number | null;
  inputCostPer1m?: number | null;
  outputCostPer1m?: number | null;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsEmbeddings: boolean;
  metadata: Record<string, unknown>;
}

export interface DatasourceConnectionRow {
  id: UUID;
  /**
   * Owning tenant. `null` means "global" — applies to every tenant
   * as a fallback the per-tenant rows can override. Operators with
   * `config:edit_global` create globals; tenant-admins can only
   * create rows scoped to their own tenant.
   */
  tenantId?: UUID | null;
  /**
   * Per-environment scope. `null` means "applies to every environment
   * in this tenant" (the tenant-wide fallback). When set to an
   * environment name, this row beats the tenant-wide one for that env.
   * The resolver cascade is:
   *   (tenant=T, env=E) → (tenant=T, env=null) → (tenant=null, env=null)
   */
  environmentId?: string | null;
  name: string;
  datasourceType: string;
  secretRefId?: UUID | null;
  configRedacted: Record<string, unknown>;
  allowedHosts: string[];
  denyPrivateNetworks: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VectorCollectionRow {
  id: UUID;
  tenantId: UUID;
  pipelineId: UUID;
  environment: string;
  collectionName: string;
  isolationMode: string;
  embeddingProfile: Record<string, unknown>;
  createdAt: string;
}

export interface ApiKeyRow {
  id: string;
  tenantId?: string;
  /**
   * Optional environment scope (free string matching
   * `tenant_environments.name`). When set, the key's grants are synthesized
   * at scope `t/<tenant>/e/<environment>` so it cannot act outside that
   * environment — sibling-scope rules of {@link scopeCovers} apply.
   * `undefined` means "every environment in the tenant", which is the
   * back-compat behaviour for keys minted before this column existed.
   */
  environmentId?: string;
  principalId: string;
  name: string;
  prefix: string;
  hash: string;
  roles: Role[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  /**
   * Optional expiration. When set, {@link ApiKeyService.verify} rejects
   * the key once `now()` is past it — same constant-time error shape as
   * a revoked key. `undefined` means "no expiration".
   */
  expiresAt?: string;
}

// --- Repository interfaces -----------------------------------------------------------

export interface CrudRepository<T, K = string> {
  create(row: T): Promise<T>;
  get(id: K): Promise<T | undefined>;
  require(id: K): Promise<T>;
  update(id: K, patch: Partial<T>): Promise<T>;
  delete(id: K): Promise<void>;
  list(): Promise<T[]>;
}

export interface TenantRepository extends CrudRepository<TenantRow> {
  findBySlug(slug: string): Promise<TenantRow | undefined>;
}

export interface TenantGitConfigRepository {
  get(tenantId: UUID): Promise<TenantGitConfigRow | undefined>;
  upsert(row: TenantGitConfigRow): Promise<TenantGitConfigRow>;
  delete(tenantId: UUID): Promise<void>;
  /** Tenants in git mode whose `last_synced_at` is older than `nowIso - poll_interval_sec`. */
  listDue(nowIso: string): Promise<TenantGitConfigRow[]>;
  /** Stamps last_synced_sha / last_synced_at / last_sync_error after a poll. */
  recordSync(
    tenantId: UUID,
    result: { sha?: string | null; syncedAt: string; error?: string | null }
  ): Promise<void>;
}

export interface EnvironmentRepository
  extends CrudRepository<EnvironmentRow> {
  listByTenant(tenantId: UUID): Promise<EnvironmentRow[]>;
}

// --- Datasets (Phase 4 of dataset/RBAC/retrieval refactor) ---

export interface DatasetRow {
  id: UUID;
  scope: "global" | "tenant" | "environment";
  tenantId?: string | null;
  environmentId?: string | null;
  slug: string;
  displayName: string;
  description?: string | null;
  embeddingProfile: Record<string, unknown>;
  chunkSchema: Record<string, unknown>;
  modalities: string[];
  backends: Record<string, unknown>;
  currentVersionId?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  createdBy?: string | null;
  updatedAt: string;
}

export interface DatasetVersionRow {
  id: UUID;
  datasetId: UUID;
  versionLabel: string;
  schemaSpec: Record<string, unknown>;
  backendCollections: Record<string, string>;
  status: "building" | "ready" | "archived";
  docCount: number;
  sizeBytes: number;
  createdAt: string;
  readyAt?: string | null;
}

export interface DatasetAliasRow {
  id: UUID;
  datasetId: UUID;
  alias: string;
  versionId: UUID;
  updatedAt: string;
  updatedBy?: string | null;
}

/**
 * Dataset persistence. Lifecycle is a small handful of well-defined
 * operations rather than the generic CRUD shape because Datasets have
 * structural invariants that the repository enforces: the scope-shape
 * check; slug uniqueness within scope; and (later) the "delete refuses
 * if non-archived pipelines reference it" rule. See the corresponding
 * SQL migration `010_datasets.sql` for the matching CHECKs.
 */
export interface DatasetRepository {
  create(row: DatasetRow): Promise<DatasetRow>;
  get(id: UUID): Promise<DatasetRow | undefined>;
  /** Throws NotFoundError when id is unknown. */
  require(id: UUID): Promise<DatasetRow>;
  update(id: UUID, patch: Partial<DatasetRow>): Promise<DatasetRow>;
  delete(id: UUID): Promise<void>;
  /**
   * Resolve a slug at a scope. Walks env -> tenant -> global, first
   * match wins. tenantId/environmentId are the *request* scope, not the
   * dataset's defining scope — they parametrise the search.
   */
  resolveSlug(args: {
    slug: string;
    tenantId?: string;
    environmentId?: string;
  }): Promise<DatasetRow | undefined>;
  /** Every dataset visible at a scope, after env -> tenant -> global resolution. */
  listVisibleAt(args: {
    tenantId?: string;
    environmentId?: string;
  }): Promise<DatasetRow[]>;
  /** Raw filter — admin use. */
  listAll(filter?: { scope?: DatasetRow["scope"]; tenantId?: string; environmentId?: string; includeArchived?: boolean }): Promise<DatasetRow[]>;
}

// ---------------------------------------------------------------------------
// ADR-0021: External Connections Registry
// ---------------------------------------------------------------------------

/**
 * A named, RBAC'd, health-tracked connection to a non-Postgres external
 * backend (MongoDB, ClickHouse, HTTP API, …). The DSN / credential
 * itself lives in `secrets` and is pointed to by `secretRefId`; this
 * row carries only the operator-facing identity and per-kind options.
 *
 * Scope resolution mirrors datasets: env → tenant → global, first match
 * wins. Slug is unique-per-scope; the same `acme-reporting` slug can
 * exist at global AND in tenant A.
 */
export interface ExternalConnectionRow {
  id: UUID;
  scope: "global" | "tenant" | "environment";
  tenantId?: string | null;
  environmentId?: string | null;
  slug: string;
  displayName: string;
  description?: string | null;
  /** Open-ended kind tag — "postgres" | "mongodb" | "clickhouse" | "http" | …
   *  The driver registry picks an adapter based on this value. */
  kind: string;
  /** UUID of a row in `secrets`. The connection string / API key / mongo
   *  URI lives there and is fetched through SecretProvider at use time. */
  secretRefId?: string | null;
  /** Per-kind structured options that are NOT a secret. e.g. max pool
   *  size, default database, TLS verify mode. Driver factories interpret
   *  this; the registry treats it as an opaque jsonb. */
  options: Record<string, unknown>;
  lastProbedAt?: string | null;
  lastProbeOk?: boolean | null;
  lastProbeError?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalConnectionRepository {
  create(row: ExternalConnectionRow): Promise<ExternalConnectionRow>;
  get(id: UUID): Promise<ExternalConnectionRow | undefined>;
  /** Throws NotFoundError when id is unknown. */
  require(id: UUID): Promise<ExternalConnectionRow>;
  update(
    id: UUID,
    patch: Partial<ExternalConnectionRow>
  ): Promise<ExternalConnectionRow>;
  delete(id: UUID): Promise<void>;
  /** env → tenant → global slug resolution. */
  resolveSlug(args: {
    slug: string;
    tenantId?: string;
    environmentId?: string;
  }): Promise<ExternalConnectionRow | undefined>;
  /** Connections visible at a scope after the cascade. */
  listVisibleAt(args: {
    tenantId?: string;
    environmentId?: string;
  }): Promise<ExternalConnectionRow[]>;
  /** Admin filter. */
  listAll(filter?: {
    scope?: ExternalConnectionRow["scope"];
    tenantId?: string;
    environmentId?: string;
    kind?: string;
    includeArchived?: boolean;
  }): Promise<ExternalConnectionRow[]>;
  /** Record the result of a health probe. */
  recordProbe(
    id: UUID,
    result: { ok: boolean; error?: string; at: string }
  ): Promise<void>;
}

export interface DatasetVersionRepository {
  create(row: DatasetVersionRow): Promise<DatasetVersionRow>;
  get(id: UUID): Promise<DatasetVersionRow | undefined>;
  listByDataset(datasetId: UUID): Promise<DatasetVersionRow[]>;
  update(id: UUID, patch: Partial<DatasetVersionRow>): Promise<DatasetVersionRow>;
  delete(id: UUID): Promise<void>;
}

export interface DatasetAliasRepository {
  upsert(row: DatasetAliasRow): Promise<DatasetAliasRow>;
  resolve(datasetId: UUID, alias: string): Promise<DatasetAliasRow | undefined>;
  listByDataset(datasetId: UUID): Promise<DatasetAliasRow[]>;
  delete(datasetId: UUID, alias: string): Promise<void>;
}

export interface UserRepository extends CrudRepository<UserRow> {
  findByEmail(email: string): Promise<UserRow | undefined>;
}

export interface RoleRepository extends CrudRepository<RoleRow> {
  findByName(name: string): Promise<RoleRow | undefined>;
}

export interface UserRoleRepository {
  assign(row: UserRoleRow): Promise<UserRoleRow>;
  remove(row: UserRoleRow): Promise<void>;
  listForUser(userId: UUID): Promise<UserRoleRow[]>;
}

export interface UserIdentityRepository {
  create(row: UserIdentityRow): Promise<UserIdentityRow>;
  findBySubject(
    provider: string,
    subject: string
  ): Promise<UserIdentityRow | undefined>;
  listForUser(userId: UUID): Promise<UserIdentityRow[]>;
  delete(id: UUID): Promise<void>;
}

export interface IdentityProviderRepository
  extends CrudRepository<IdentityProviderRow> {
  findBySlug(slug: string): Promise<IdentityProviderRow | undefined>;
  listEnabled(): Promise<IdentityProviderRow[]>;
}

/** The Casbin `p`/`g` policy store. Used by @ragdoll/authz. */
export interface RbacPolicyRepository {
  /** Every role -> permission edge (the editable permission catalog). */
  listRolePermissions(): Promise<RbacRolePermissionRow[]>;
  addRolePermission(row: RbacRolePermissionRow): Promise<void>;
  removeRolePermission(row: RbacRolePermissionRow): Promise<void>;
  /** Replace the full permission set for a single role atomically. */
  setRolePermissions(role: string, permissions: string[]): Promise<void>;
  /** Every grant (user -> role @ scope). */
  listGrants(): Promise<RbacGrantRow[]>;
  listGrantsForUser(userId: UUID): Promise<RbacGrantRow[]>;
  addGrant(row: RbacGrantRow): Promise<RbacGrantRow>;
  removeGrant(id: UUID): Promise<void>;
}

export interface AuthSettingsRepository {
  get(): Promise<AuthSettingsRow>;
  set(row: AuthSettingsRow): Promise<AuthSettingsRow>;
}

export interface WebhookTriggerRepository {
  create(row: WebhookTriggerRow): Promise<WebhookTriggerRow>;
  get(id: UUID): Promise<WebhookTriggerRow | undefined>;
  findByPrefix(prefix: string): Promise<WebhookTriggerRow | undefined>;
  /** Triggers for a given tenant + pipeline (all envs). */
  listForPipeline(
    tenantId: UUID,
    pipelineId: UUID
  ): Promise<WebhookTriggerRow[]>;
  touch(id: UUID, at?: string): Promise<void>;
  delete(id: UUID): Promise<void>;
}

export interface PipelineRepository extends CrudRepository<PipelineRow> {
  findBySlug(slug: string): Promise<PipelineRow | undefined>;
  setLatestVersion(pipelineId: UUID, versionId: UUID | null): Promise<PipelineRow>;
  setFolder(pipelineId: UUID, folderId: UUID | null): Promise<PipelineRow>;
}

export interface PipelineVersionRepository extends CrudRepository<PipelineVersionRow> {
  listByPipeline(pipelineId: UUID): Promise<PipelineVersionRow[]>;
  findByVersion(pipelineId: UUID, version: string): Promise<PipelineVersionRow | undefined>;
}

export interface PipelineFolderRepository
  extends CrudRepository<PipelineFolderRow> {
  /** Rename a folder. Convenience over `update`. */
  rename(id: UUID, name: string): Promise<PipelineFolderRow>;
  /** Folders whose parent is `parentId` (pass `null` for root folders). */
  listChildren(parentId: UUID | null): Promise<PipelineFolderRow[]>;
  /** The full nested folder forest (root nodes with `children`). */
  tree(): Promise<PipelineFolderTreeNode[]>;
}

export interface PipelineActivationRepository
  extends CrudRepository<PipelineActivationRow> {
  listByTenantPipelineEnv(
    tenantId: UUID,
    pipelineId: UUID,
    environment: string
  ): Promise<PipelineActivationRow[]>;
  listByTenant(tenantId: UUID): Promise<PipelineActivationRow[]>;
  listByPipeline(pipelineId: UUID): Promise<PipelineActivationRow[]>;
}

export interface ScheduleRepository extends CrudRepository<ScheduleRow> {
  listEnabled(): Promise<ScheduleRow[]>;
  /** Enabled schedules whose `nextRunAt` is set and at/before `nowIso`. */
  listDue(nowIso: string): Promise<ScheduleRow[]>;
  markRun(
    id: UUID,
    lastRunIso: string,
    nextRunIso: string | null
  ): Promise<ScheduleRow>;
}

export interface PipelineDeploymentRepository extends CrudRepository<PipelineDeploymentRow> {
  getActiveDeployment(
    pipelineId: UUID,
    environment: string,
    tenantId?: UUID | null
  ): Promise<PipelineDeploymentRow | undefined>;
  listByPipeline(pipelineId: UUID): Promise<PipelineDeploymentRow[]>;
  /**
   * Atomically promote `row` to be the active deployment for its
   * `(pipelineId, environment, tenantId)` triple. Re-deploying to the same
   * triple swaps the active row in place — without it, the unique constraint
   * on (pipeline_id, environment, tenant_id) rejects every redeploy as a
   * duplicate-key conflict.
   *
   * Returns the resulting row (the freshly-inserted row on first deploy, the
   * updated row on every subsequent deploy).
   */
  upsertActive(row: PipelineDeploymentRow): Promise<PipelineDeploymentRow>;
}

export interface TenantPipelineKey {
  tenantId: UUID;
  pipelineId: UUID;
  environment: string;
}

export interface TenantPipelineRepository {
  upsert(row: TenantPipelineRow): Promise<TenantPipelineRow>;
  get(key: TenantPipelineKey): Promise<TenantPipelineRow | undefined>;
  require(key: TenantPipelineKey): Promise<TenantPipelineRow>;
  delete(key: TenantPipelineKey): Promise<void>;
  listByTenant(tenantId: UUID): Promise<TenantPipelineRow[]>;
}

export interface ConfigDefinitionRepository {
  upsert(row: ConfigDefinitionRow): Promise<ConfigDefinitionRow>;
  get(key: string): Promise<ConfigDefinitionRow | undefined>;
  require(key: string): Promise<ConfigDefinitionRow>;
  delete(key: string): Promise<void>;
  list(): Promise<ConfigDefinitionRow[]>;
}

export interface ConfigValueScopeFilter {
  key?: string;
  scope?: ConfigScope;
  scopeId?: string | null;
}

export interface ConfigValueRepository {
  upsert(row: Omit<ConfigValueRow, "id" | "createdAt" | "updatedAt"> & Partial<Pick<ConfigValueRow, "id" | "createdAt" | "updatedAt">>): Promise<ConfigValueRow>;
  get(id: UUID): Promise<ConfigValueRow | undefined>;
  delete(id: UUID): Promise<void>;
  listConfigValues(filter?: ConfigValueScopeFilter): Promise<ConfigValueRow[]>;
}

export interface RetentionSettingRow {
  resource: "executions" | "usage" | "audit";
  maxCount: number | null;
  maxAgeDays: number | null;
  updatedAt: string;
  updatedBy?: string | null;
}

export interface RetentionSettingsRepository {
  list(): Promise<RetentionSettingRow[]>;
  upsert(input: {
    resource: RetentionSettingRow["resource"];
    maxCount: number | null;
    maxAgeDays: number | null;
    updatedBy?: string;
  }): Promise<RetentionSettingRow>;
}

export interface AuditLogRepository {
  append(row: Omit<AuditLogRow, "id">): Promise<AuditLogRow>;
  list(filter?: { tenantId?: UUID; actorId?: UUID; limit?: number }): Promise<AuditLogRow[]>;
  /** Cursor-paginated list ordered by (created_at DESC, id DESC). The
   *  `total` is the COUNT(*) under the same filter — surfaced so the
   *  UI footer can render "N of M" instead of just the loaded slice. */
  listPage?(args: {
    tenantId?: UUID;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: AuditLogRow[]; nextCursor: string | null; total: number }>;
}

export interface UsageRecordRepository {
  append(row: Omit<UsageRecordRow, "id" | "createdAt">): Promise<UsageRecordRow>;
  list(filter?: { tenantId?: UUID; executionId?: string }): Promise<UsageRecordRow[]>;
  /** Cursor-paginated list ordered by (created_at DESC, id DESC). */
  listPage?(args: {
    tenantId?: UUID;
    limit: number;
    cursor?: string;
  }): Promise<{ rows: UsageRecordRow[]; nextCursor: string | null; total: number }>;
}

export interface PluginRepository extends CrudRepository<PluginRow> {
  findByPluginId(pluginId: string, category: PluginCategory): Promise<PluginRow | undefined>;
}

export interface PluginVersionRepository extends CrudRepository<PluginVersionRow> {
  listByPlugin(pluginId: UUID): Promise<PluginVersionRow[]>;
}

export interface ProviderRepository extends CrudRepository<ProviderRow> {
  findByProviderId(providerId: string): Promise<ProviderRow | undefined>;
}

export interface ProviderModelRepository extends CrudRepository<ProviderModelRow> {
  listByProvider(providerId: UUID): Promise<ProviderModelRow[]>;
}

/**
 * Per-(pipeline, tenant, env) dataset binding override.
 *
 * Pipeline specs reference datasets by `slug`. The default resolution
 * (datasets.resolveSlug) walks env→tenant→global; this table lets an
 * operator pin a specific dataset row for one pipeline under one
 * (tenant, env) without touching the spec or the global dataset list.
 *
 * Use cases:
 *   - "Tenant A's prod pipeline writes to a totally different OpenSearch
 *     than its dev/qa pipelines" (point them at different dataset rows).
 *   - "The 'docs' slug should resolve to the v2-schema dataset for tenant
 *     B specifically while everyone else stays on v1."
 */
export interface PipelineDatasetBindingRow {
  id: UUID;
  pipelineId: UUID;
  tenantId: UUID;
  /** `null` = applies to every env in this (pipeline, tenant). */
  environmentId?: string | null;
  /** The slug as it appears in the pipeline spec. */
  sourceSlug: string;
  /** What that slug should actually resolve to for this scope. */
  targetDatasetId: UUID;
  createdAt: string;
  createdBy?: UUID | null;
  updatedAt: string;
}

export interface PipelineDatasetBindingRepository
  extends CrudRepository<PipelineDatasetBindingRow> {
  listByPipeline(pipelineId: UUID): Promise<PipelineDatasetBindingRow[]>;
  /**
   * Resolver hot path. Returns the binding that wins the
   *   (pipeline, tenant, env, slug) → (pipeline, tenant, null, slug)
   * cascade, or undefined when no override is set (caller falls through
   * to the default dataset slug cascade).
   */
  resolveBinding(args: {
    pipelineId: UUID;
    tenantId: UUID;
    environmentId?: string;
    sourceSlug: string;
  }): Promise<PipelineDatasetBindingRow | undefined>;
}

export interface DatasourceConnectionRepository extends CrudRepository<DatasourceConnectionRow> {
  listByTenant(tenantId: UUID): Promise<DatasourceConnectionRow[]>;
  /**
   * Cascade resolver. Returns the most-specific connection matching
   * `name` for the given (tenantId, environmentId): an env-specific
   * row wins; otherwise the tenant-wide row with `environment_id IS
   * NULL`; otherwise undefined. Mirrors the dataset resolver's
   * env→tenant→global fall-through (datasets have one extra global
   * tier; connections stop at tenant).
   */
  resolveForEnv(
    tenantId: UUID,
    environmentId: string | undefined,
    name: string
  ): Promise<DatasourceConnectionRow | undefined>;
}

export interface VectorCollectionRepository extends CrudRepository<VectorCollectionRow> {
  findByName(collectionName: string): Promise<VectorCollectionRow | undefined>;
  listByTenantPipeline(
    tenantId: UUID,
    pipelineId: UUID,
    environment: string
  ): Promise<VectorCollectionRow[]>;
}

export interface ApiKeyRepository {
  create(row: ApiKeyRow): Promise<ApiKeyRow>;
  findByPrefix(prefix: string): Promise<ApiKeyRow | undefined>;
  touch(id: UUID, at?: string): Promise<void>;
  revoke(id: UUID, at?: string): Promise<void>;
  listByPrincipal(principalId: UUID): Promise<ApiKeyRow[]>;
}
