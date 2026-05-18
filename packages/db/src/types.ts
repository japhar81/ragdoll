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
  createdAt: string;
  updatedAt: string;
}

export interface UserRow {
  id: UUID;
  email: string;
  displayName?: string | null;
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
  tenantId: UUID;
  pipelineId: UUID;
  environment: string;
  activationLabel?: string | null;
  cron: string;
  timezone: string;
  input: Record<string, unknown>;
  enabled: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  createdAt: string;
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
  tenantId: UUID;
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
  principalId: string;
  name: string;
  prefix: string;
  hash: string;
  roles: Role[];
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
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

export interface AuditLogRepository {
  append(row: Omit<AuditLogRow, "id">): Promise<AuditLogRow>;
  list(filter?: { tenantId?: UUID; actorId?: UUID; limit?: number }): Promise<AuditLogRow[]>;
}

export interface UsageRecordRepository {
  append(row: Omit<UsageRecordRow, "id" | "createdAt">): Promise<UsageRecordRow>;
  list(filter?: { tenantId?: UUID; executionId?: string }): Promise<UsageRecordRow[]>;
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

export interface DatasourceConnectionRepository extends CrudRepository<DatasourceConnectionRow> {
  listByTenant(tenantId: UUID): Promise<DatasourceConnectionRow[]>;
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
