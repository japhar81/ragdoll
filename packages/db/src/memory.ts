import { randomUUID } from "node:crypto";
import type {
  ExecutionNodeRecord,
  ExecutionRecord,
  ExecutionStore
} from "../../runtime/src/index.ts";
import type { UsageRecord, UUID } from "../../core/src/index.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import type {
  ApiKeyRepository,
  ApiKeyRow,
  AuditLogRepository,
  AuditLogRow,
  ConfigDefinitionRepository,
  ConfigDefinitionRow,
  ConfigValueRepository,
  ConfigValueRow,
  ConfigValueScopeFilter,
  CrudRepository,
  DatasourceConnectionRepository,
  DatasourceConnectionRow,
  EnvironmentRepository,
  EnvironmentRow,
  PipelineActivationRepository,
  PipelineActivationRow,
  PipelineDeploymentRepository,
  PipelineDeploymentRow,
  PipelineFolderRepository,
  PipelineFolderRow,
  PipelineFolderTreeNode,
  PipelineRepository,
  PipelineRow,
  PipelineVersionRepository,
  PipelineVersionRow,
  ScheduleRepository,
  ScheduleRow,
  PluginRepository,
  PluginRow,
  PluginVersionRepository,
  PluginVersionRow,
  ProviderModelRepository,
  ProviderModelRow,
  ProviderRepository,
  ProviderRow,
  RoleRepository,
  RoleRow,
  TenantPipelineKey,
  TenantPipelineRepository,
  TenantPipelineRow,
  TenantRepository,
  TenantRow,
  UsageRecordRepository,
  UsageRecordRow,
  UserRepository,
  UserRoleRepository,
  UserRoleRow,
  UserRow,
  UserIdentityRepository,
  UserIdentityRow,
  IdentityProviderRepository,
  IdentityProviderRow,
  RbacPolicyRepository,
  RbacRolePermissionRow,
  RbacGrantRow,
  AuthSettingsRepository,
  AuthSettingsRow,
  WebhookTriggerRepository,
  WebhookTriggerRow,
  VectorCollectionRepository,
  VectorCollectionRow
} from "./types.ts";

/** Generic in-memory keyed store with CRUD semantics, keyed by `id`. */
export class InMemoryCrudRepository<T extends { id: string }>
  implements CrudRepository<T>
{
  protected rows = new Map<string, T>();
  private entity: string;

  constructor(entity: string) {
    this.entity = entity;
  }

  async create(row: T): Promise<T> {
    if (this.rows.has(row.id)) {
      throw new ConflictError(this.entity, `id already exists: ${row.id}`);
    }
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  async get(id: string): Promise<T | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async require(id: string): Promise<T> {
    const row = await this.get(id);
    if (!row) throw new NotFoundError(this.entity, id);
    return row;
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    const existing = this.rows.get(id);
    if (!existing) throw new NotFoundError(this.entity, id);
    const next = { ...existing, ...patch, id: existing.id };
    this.rows.set(id, next);
    return structuredClone(next);
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async list(): Promise<T[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
}

export class InMemoryTenantRepository
  extends InMemoryCrudRepository<TenantRow>
  implements TenantRepository
{
  constructor() {
    super("tenant");
  }
  async findBySlug(slug: string): Promise<TenantRow | undefined> {
    return (await this.list()).find((row) => row.slug === slug);
  }
}

export class InMemoryEnvironmentRepository
  extends InMemoryCrudRepository<EnvironmentRow>
  implements EnvironmentRepository
{
  constructor() {
    super("environment");
  }
  async listByTenant(tenantId: string): Promise<EnvironmentRow[]> {
    return (await this.list())
      .filter((row) => row.tenantId === tenantId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

export class InMemoryUserRepository
  extends InMemoryCrudRepository<UserRow>
  implements UserRepository
{
  constructor() {
    super("user");
  }
  async findByEmail(email: string): Promise<UserRow | undefined> {
    return (await this.list()).find((row) => row.email === email);
  }
}

export class InMemoryRoleRepository
  extends InMemoryCrudRepository<RoleRow>
  implements RoleRepository
{
  constructor() {
    super("role");
  }
  async findByName(name: string): Promise<RoleRow | undefined> {
    return (await this.list()).find((row) => row.name === name);
  }
}

export class InMemoryUserRoleRepository implements UserRoleRepository {
  private rows: UserRoleRow[] = [];

  private same(a: UserRoleRow, b: UserRoleRow): boolean {
    return (
      a.userId === b.userId &&
      a.roleId === b.roleId &&
      (a.tenantId ?? null) === (b.tenantId ?? null) &&
      (a.environment ?? null) === (b.environment ?? null) &&
      (a.pipelineId ?? null) === (b.pipelineId ?? null)
    );
  }

  async assign(row: UserRoleRow): Promise<UserRoleRow> {
    if (!this.rows.some((existing) => this.same(existing, row))) {
      this.rows.push({ ...row });
    }
    return { ...row };
  }

  async remove(row: UserRoleRow): Promise<void> {
    this.rows = this.rows.filter((existing) => !this.same(existing, row));
  }

  async listForUser(userId: UUID): Promise<UserRoleRow[]> {
    return this.rows.filter((row) => row.userId === userId).map((row) => ({ ...row }));
  }
}

export class InMemoryPipelineRepository
  extends InMemoryCrudRepository<PipelineRow>
  implements PipelineRepository
{
  constructor() {
    super("pipeline");
  }
  async findBySlug(slug: string): Promise<PipelineRow | undefined> {
    return (await this.list()).find((row) => row.slug === slug);
  }
  async setLatestVersion(
    pipelineId: UUID,
    versionId: UUID | null
  ): Promise<PipelineRow> {
    return this.update(pipelineId, {
      latestVersionId: versionId
    } as Partial<PipelineRow>);
  }
  async setFolder(
    pipelineId: UUID,
    folderId: UUID | null
  ): Promise<PipelineRow> {
    return this.update(pipelineId, {
      folderId
    } as Partial<PipelineRow>);
  }
}

export class InMemoryPipelineVersionRepository
  extends InMemoryCrudRepository<PipelineVersionRow>
  implements PipelineVersionRepository
{
  constructor() {
    super("pipeline_version");
  }
  async listByPipeline(pipelineId: UUID): Promise<PipelineVersionRow[]> {
    return (await this.list()).filter((row) => row.pipelineId === pipelineId);
  }
  async findByVersion(
    pipelineId: UUID,
    version: string
  ): Promise<PipelineVersionRow | undefined> {
    const matches = (await this.list()).filter(
      (row) => row.pipelineId === pipelineId && row.version === version
    );
    // A draft and a published row can share a version string; deployments
    // must resolve the published one. Prefer published > draft > archived.
    const rank = { published: 0, draft: 1, archived: 2 } as const;
    return matches.sort((a, b) => rank[a.status] - rank[b.status])[0];
  }
}

export class InMemoryPipelineDeploymentRepository
  extends InMemoryCrudRepository<PipelineDeploymentRow>
  implements PipelineDeploymentRepository
{
  constructor() {
    super("pipeline_deployment");
  }
  async getActiveDeployment(
    pipelineId: UUID,
    environment: string,
    tenantId?: UUID | null
  ): Promise<PipelineDeploymentRow | undefined> {
    return (await this.list()).find(
      (row) =>
        row.pipelineId === pipelineId &&
        row.environment === environment &&
        (row.tenantId ?? null) === (tenantId ?? null) &&
        row.status === "active"
    );
  }
  async listByPipeline(pipelineId: UUID): Promise<PipelineDeploymentRow[]> {
    return (await this.list()).filter((row) => row.pipelineId === pipelineId);
  }
}

export class InMemoryPipelineFolderRepository
  extends InMemoryCrudRepository<PipelineFolderRow>
  implements PipelineFolderRepository
{
  // Pipelines that live in folders are tracked here so delete() can block a
  // non-empty folder without coupling to the pipeline repository.
  private pipelinesByFolder = new Map<string, Set<string>>();

  constructor() {
    super("pipeline_folder");
  }

  /**
   * Test/wiring hook: record which folder a pipeline currently lives in so a
   * non-empty folder delete raises ConflictError. Pass `null` to detach.
   */
  trackPipelineFolder(pipelineId: string, folderId: string | null): void {
    for (const set of this.pipelinesByFolder.values()) {
      set.delete(pipelineId);
    }
    if (folderId !== null) {
      const set = this.pipelinesByFolder.get(folderId) ?? new Set<string>();
      set.add(pipelineId);
      this.pipelinesByFolder.set(folderId, set);
    }
  }

  override async create(row: PipelineFolderRow): Promise<PipelineFolderRow> {
    const dupe = (await this.list()).find(
      (existing) =>
        (existing.parentId ?? null) === (row.parentId ?? null) &&
        existing.name === row.name
    );
    if (dupe) {
      throw new ConflictError(
        "pipeline_folder",
        `name already exists under parent: ${row.name}`
      );
    }
    return super.create(row);
  }

  async rename(id: UUID, name: string): Promise<PipelineFolderRow> {
    const existing = await this.require(id);
    const dupe = (await this.list()).find(
      (row) =>
        row.id !== id &&
        (row.parentId ?? null) === (existing.parentId ?? null) &&
        row.name === name
    );
    if (dupe) {
      throw new ConflictError(
        "pipeline_folder",
        `name already exists under parent: ${name}`
      );
    }
    return this.update(id, { name } as Partial<PipelineFolderRow>);
  }

  async listChildren(parentId: UUID | null): Promise<PipelineFolderRow[]> {
    return (await this.list()).filter(
      (row) => (row.parentId ?? null) === (parentId ?? null)
    );
  }

  override async delete(id: string): Promise<void> {
    const childFolders = await this.listChildren(id);
    if (childFolders.length > 0) {
      throw new ConflictError(
        "pipeline_folder",
        `folder has ${childFolders.length} child folder(s): ${id}`
      );
    }
    const pipelines = this.pipelinesByFolder.get(id);
    if (pipelines && pipelines.size > 0) {
      throw new ConflictError(
        "pipeline_folder",
        `folder has ${pipelines.size} pipeline(s): ${id}`
      );
    }
    this.pipelinesByFolder.delete(id);
    await super.delete(id);
  }

  async tree(): Promise<PipelineFolderTreeNode[]> {
    const all = await this.list();
    const byParent = new Map<string, PipelineFolderRow[]>();
    for (const row of all) {
      const key = row.parentId ?? " root";
      const bucket = byParent.get(key) ?? [];
      bucket.push(row);
      byParent.set(key, bucket);
    }
    const build = (row: PipelineFolderRow): PipelineFolderTreeNode => ({
      ...row,
      children: (byParent.get(row.id) ?? [])
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(build)
    });
    return (byParent.get(" root") ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(build);
  }
}

export class InMemoryPipelineActivationRepository
  extends InMemoryCrudRepository<PipelineActivationRow>
  implements PipelineActivationRepository
{
  constructor() {
    super("pipeline_activation");
  }

  override async create(
    row: PipelineActivationRow
  ): Promise<PipelineActivationRow> {
    const dupe = (await this.list()).find(
      (existing) =>
        existing.tenantId === row.tenantId &&
        existing.pipelineId === row.pipelineId &&
        existing.environment === row.environment &&
        existing.label === row.label
    );
    if (dupe) {
      throw new ConflictError(
        "pipeline_activation",
        `label already exists for tenant+pipeline+environment: ${row.label}`
      );
    }
    return super.create(row);
  }

  async listByTenantPipelineEnv(
    tenantId: UUID,
    pipelineId: UUID,
    environment: string
  ): Promise<PipelineActivationRow[]> {
    return (await this.list()).filter(
      (row) =>
        row.tenantId === tenantId &&
        row.pipelineId === pipelineId &&
        row.environment === environment
    );
  }

  async listByTenant(tenantId: UUID): Promise<PipelineActivationRow[]> {
    return (await this.list()).filter((row) => row.tenantId === tenantId);
  }

  async listByPipeline(pipelineId: UUID): Promise<PipelineActivationRow[]> {
    return (await this.list()).filter((row) => row.pipelineId === pipelineId);
  }
}

export class InMemoryScheduleRepository
  extends InMemoryCrudRepository<ScheduleRow>
  implements ScheduleRepository
{
  constructor() {
    super("schedule");
  }

  async listEnabled(): Promise<ScheduleRow[]> {
    return (await this.list()).filter((row) => row.enabled);
  }

  async listDue(nowIso: string): Promise<ScheduleRow[]> {
    return (await this.list()).filter(
      (row) =>
        row.enabled &&
        row.nextRunAt !== null &&
        row.nextRunAt !== undefined &&
        row.nextRunAt <= nowIso
    );
  }

  async markRun(
    id: UUID,
    lastRunIso: string,
    nextRunIso: string | null
  ): Promise<ScheduleRow> {
    return this.update(id, {
      lastRunAt: lastRunIso,
      nextRunAt: nextRunIso
    } as Partial<ScheduleRow>);
  }
}

export class InMemoryTenantPipelineRepository implements TenantPipelineRepository {
  private rows = new Map<string, TenantPipelineRow>();

  private key(key: TenantPipelineKey): string {
    return `${key.tenantId}:${key.pipelineId}:${key.environment}`;
  }

  async upsert(row: TenantPipelineRow): Promise<TenantPipelineRow> {
    this.rows.set(this.key(row), structuredClone(row));
    return structuredClone(row);
  }

  async get(key: TenantPipelineKey): Promise<TenantPipelineRow | undefined> {
    const row = this.rows.get(this.key(key));
    return row ? structuredClone(row) : undefined;
  }

  async require(key: TenantPipelineKey): Promise<TenantPipelineRow> {
    const row = await this.get(key);
    if (!row) throw new NotFoundError("tenant_pipeline", this.key(key));
    return row;
  }

  async delete(key: TenantPipelineKey): Promise<void> {
    this.rows.delete(this.key(key));
  }

  async listByTenant(tenantId: UUID): Promise<TenantPipelineRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId)
      .map((row) => structuredClone(row));
  }
}

export class InMemoryConfigDefinitionRepository implements ConfigDefinitionRepository {
  private rows = new Map<string, ConfigDefinitionRow>();

  async upsert(row: ConfigDefinitionRow): Promise<ConfigDefinitionRow> {
    this.rows.set(row.key, structuredClone(row));
    return structuredClone(row);
  }

  async get(key: string): Promise<ConfigDefinitionRow | undefined> {
    const row = this.rows.get(key);
    return row ? structuredClone(row) : undefined;
  }

  async require(key: string): Promise<ConfigDefinitionRow> {
    const row = await this.get(key);
    if (!row) throw new NotFoundError("config_definition", key);
    return row;
  }

  async delete(key: string): Promise<void> {
    this.rows.delete(key);
  }

  async list(): Promise<ConfigDefinitionRow[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
}

export class InMemoryConfigValueRepository implements ConfigValueRepository {
  private rows = new Map<string, ConfigValueRow>();

  private uniqueKey(row: Pick<ConfigValueRow, "key" | "scope" | "scopeId">): string {
    return `${row.key}::${row.scope}::${row.scopeId ?? ""}`;
  }

  async upsert(
    input: Omit<ConfigValueRow, "id" | "createdAt" | "updatedAt"> &
      Partial<Pick<ConfigValueRow, "id" | "createdAt" | "updatedAt">>
  ): Promise<ConfigValueRow> {
    const now = new Date().toISOString();
    const unique = this.uniqueKey(input);
    const existing = [...this.rows.values()].find(
      (row) => this.uniqueKey(row) === unique
    );
    const row: ConfigValueRow = {
      id: existing?.id ?? input.id ?? randomUUID(),
      key: input.key,
      value: input.value,
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      locked: input.locked,
      createdBy: input.createdBy ?? null,
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now
    };
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  async get(id: UUID): Promise<ConfigValueRow | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  async delete(id: UUID): Promise<void> {
    this.rows.delete(id);
  }

  async listConfigValues(filter: ConfigValueScopeFilter = {}): Promise<ConfigValueRow[]> {
    return [...this.rows.values()]
      .filter((row) => {
        if (filter.key !== undefined && row.key !== filter.key) return false;
        if (filter.scope !== undefined && row.scope !== filter.scope) return false;
        if (
          filter.scopeId !== undefined &&
          (row.scopeId ?? null) !== (filter.scopeId ?? null)
        ) {
          return false;
        }
        return true;
      })
      .map((row) => structuredClone(row));
  }
}

export class InMemoryAuditLogRepository implements AuditLogRepository {
  private rows: AuditLogRow[] = [];

  async append(row: Omit<AuditLogRow, "id">): Promise<AuditLogRow> {
    const stored: AuditLogRow = { ...row, id: randomUUID() };
    this.rows.push(structuredClone(stored));
    return structuredClone(stored);
  }

  async list(
    filter: { tenantId?: UUID; actorId?: UUID; limit?: number } = {}
  ): Promise<AuditLogRow[]> {
    let result = this.rows.filter((row) => {
      if (filter.tenantId !== undefined && row.tenantId !== filter.tenantId) return false;
      if (filter.actorId !== undefined && row.actorId !== filter.actorId) return false;
      return true;
    });
    result = result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (filter.limit !== undefined) result = result.slice(0, filter.limit);
    return result.map((row) => structuredClone(row));
  }
}

export class InMemoryUsageRecordRepository implements UsageRecordRepository {
  private rows: UsageRecordRow[] = [];

  async append(row: Omit<UsageRecordRow, "id" | "createdAt">): Promise<UsageRecordRow> {
    const stored: UsageRecordRow = {
      ...row,
      id: randomUUID(),
      createdAt: new Date().toISOString()
    };
    this.rows.push(structuredClone(stored));
    return structuredClone(stored);
  }

  async list(
    filter: { tenantId?: UUID; executionId?: string } = {}
  ): Promise<UsageRecordRow[]> {
    return this.rows
      .filter((row) => {
        if (filter.tenantId !== undefined && row.tenantId !== filter.tenantId) return false;
        if (
          filter.executionId !== undefined &&
          row.executionId !== filter.executionId
        ) {
          return false;
        }
        return true;
      })
      .map((row) => structuredClone(row));
  }
}

export class InMemoryPluginRepository
  extends InMemoryCrudRepository<PluginRow>
  implements PluginRepository
{
  constructor() {
    super("plugin");
  }
  async findByPluginId(
    pluginId: string,
    category: PluginRow["category"]
  ): Promise<PluginRow | undefined> {
    return (await this.list()).find(
      (row) => row.pluginId === pluginId && row.category === category
    );
  }
}

export class InMemoryPluginVersionRepository
  extends InMemoryCrudRepository<PluginVersionRow>
  implements PluginVersionRepository
{
  constructor() {
    super("plugin_version");
  }
  async listByPlugin(pluginId: UUID): Promise<PluginVersionRow[]> {
    return (await this.list()).filter((row) => row.pluginId === pluginId);
  }
}

export class InMemoryProviderRepository
  extends InMemoryCrudRepository<ProviderRow>
  implements ProviderRepository
{
  constructor() {
    super("provider");
  }
  async findByProviderId(providerId: string): Promise<ProviderRow | undefined> {
    return (await this.list()).find((row) => row.providerId === providerId);
  }
}

export class InMemoryProviderModelRepository
  extends InMemoryCrudRepository<ProviderModelRow>
  implements ProviderModelRepository
{
  constructor() {
    super("provider_model");
  }
  async listByProvider(providerId: UUID): Promise<ProviderModelRow[]> {
    return (await this.list()).filter((row) => row.providerId === providerId);
  }
}

export class InMemoryDatasourceConnectionRepository
  extends InMemoryCrudRepository<DatasourceConnectionRow>
  implements DatasourceConnectionRepository
{
  constructor() {
    super("datasource_connection");
  }
  async listByTenant(tenantId: UUID): Promise<DatasourceConnectionRow[]> {
    return (await this.list()).filter((row) => row.tenantId === tenantId);
  }
}

export class InMemoryVectorCollectionRepository
  extends InMemoryCrudRepository<VectorCollectionRow>
  implements VectorCollectionRepository
{
  constructor() {
    super("vector_collection");
  }
  async findByName(collectionName: string): Promise<VectorCollectionRow | undefined> {
    return (await this.list()).find((row) => row.collectionName === collectionName);
  }
  async listByTenantPipeline(
    tenantId: UUID,
    pipelineId: UUID,
    environment: string
  ): Promise<VectorCollectionRow[]> {
    return (await this.list()).filter(
      (row) =>
        row.tenantId === tenantId &&
        row.pipelineId === pipelineId &&
        row.environment === environment
    );
  }
}

export class InMemoryApiKeyRepository implements ApiKeyRepository {
  private rows = new Map<string, ApiKeyRow>();

  async create(row: ApiKeyRow): Promise<ApiKeyRow> {
    for (const existing of this.rows.values()) {
      if (existing.prefix === row.prefix) {
        throw new ConflictError("api_key", `prefix already exists: ${row.prefix}`);
      }
    }
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  async findByPrefix(prefix: string): Promise<ApiKeyRow | undefined> {
    for (const row of this.rows.values()) {
      if (row.prefix === prefix) return structuredClone(row);
    }
    return undefined;
  }

  async touch(id: UUID, at: string = new Date().toISOString()): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError("api_key", id);
    row.lastUsedAt = at;
  }

  async revoke(id: UUID, at: string = new Date().toISOString()): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError("api_key", id);
    row.revokedAt = at;
  }

  async listByPrincipal(principalId: UUID): Promise<ApiKeyRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.principalId === principalId)
      .map((row) => structuredClone(row));
  }
}

/**
 * In-memory `ExecutionStore` mirroring the runtime contract. The runtime
 * package ships its own `InMemoryExecutionStore`; this one is convenient for
 * db-layer tests and parity checks without depending on a Postgres pool.
 */
export class InMemoryExecutionStore implements ExecutionStore {
  executions: ExecutionRecord[] = [];
  nodes: ExecutionNodeRecord[] = [];
  usage: UsageRecord[] = [];

  async start(record: ExecutionRecord): Promise<void> {
    this.executions.push(structuredClone(record));
  }

  async complete(record: ExecutionRecord): Promise<void> {
    this.executions = this.executions.filter(
      (existing) => existing.executionId !== record.executionId
    );
    this.executions.push(structuredClone(record));
  }

  async startNode(record: ExecutionNodeRecord): Promise<void> {
    this.nodes.push(structuredClone(record));
  }

  async completeNode(record: ExecutionNodeRecord): Promise<void> {
    this.nodes = this.nodes.filter(
      (existing) =>
        !(
          existing.executionId === record.executionId &&
          existing.nodeId === record.nodeId
        )
    );
    this.nodes.push(structuredClone(record));
  }

  async recordUsage(record: UsageRecord): Promise<void> {
    this.usage.push(structuredClone(record));
  }

  // Async read methods (the control-plane `ReadableExecutionStore` contract).
  async listExecutions(tenantId?: string): Promise<ExecutionRecord[]> {
    return this.executions
      .filter((e) => tenantId === undefined || e.tenantId === tenantId)
      .map((e) => structuredClone(e));
  }

  async getExecution(
    executionId: string
  ): Promise<ExecutionRecord | undefined> {
    const found = this.executions.find(
      (e) => e.executionId === executionId
    );
    return found ? structuredClone(found) : undefined;
  }

  async listNodes(executionId: string): Promise<ExecutionNodeRecord[]> {
    return this.nodes
      .filter((n) => n.executionId === executionId)
      .map((n) => structuredClone(n));
  }
}

// --- Auth / RBAC -----------------------------------------------------------

export class InMemoryUserIdentityRepository
  implements UserIdentityRepository
{
  private rows: UserIdentityRow[] = [];

  async create(row: UserIdentityRow): Promise<UserIdentityRow> {
    if (
      this.rows.some(
        (r) => r.provider === row.provider && r.subject === row.subject
      )
    ) {
      throw new ConflictError("user_identity", `${row.provider}:${row.subject}`);
    }
    this.rows.push({ ...row });
    return { ...row };
  }

  async findBySubject(
    provider: string,
    subject: string
  ): Promise<UserIdentityRow | undefined> {
    const found = this.rows.find(
      (r) => r.provider === provider && r.subject === subject
    );
    return found ? { ...found } : undefined;
  }

  async listForUser(userId: UUID): Promise<UserIdentityRow[]> {
    return this.rows.filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }

  async delete(id: UUID): Promise<void> {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
}

export class InMemoryIdentityProviderRepository
  extends InMemoryCrudRepository<IdentityProviderRow>
  implements IdentityProviderRepository
{
  constructor() {
    super("identity_provider");
  }
  async findBySlug(slug: string): Promise<IdentityProviderRow | undefined> {
    return (await this.list()).find((row) => row.slug === slug);
  }
  async listEnabled(): Promise<IdentityProviderRow[]> {
    return (await this.list()).filter((row) => row.enabled);
  }
}

export class InMemoryRbacPolicyRepository implements RbacPolicyRepository {
  private rolePerms: RbacRolePermissionRow[] = [];
  private grants: RbacGrantRow[] = [];

  async listRolePermissions(): Promise<RbacRolePermissionRow[]> {
    return this.rolePerms.map((r) => ({ ...r }));
  }

  async addRolePermission(row: RbacRolePermissionRow): Promise<void> {
    if (
      !this.rolePerms.some(
        (r) => r.role === row.role && r.permission === row.permission
      )
    ) {
      this.rolePerms.push({ ...row });
    }
  }

  async removeRolePermission(row: RbacRolePermissionRow): Promise<void> {
    this.rolePerms = this.rolePerms.filter(
      (r) => !(r.role === row.role && r.permission === row.permission)
    );
  }

  async setRolePermissions(
    role: string,
    permissions: string[]
  ): Promise<void> {
    this.rolePerms = this.rolePerms.filter((r) => r.role !== role);
    for (const permission of new Set(permissions)) {
      this.rolePerms.push({ role, permission });
    }
  }

  async listGrants(): Promise<RbacGrantRow[]> {
    return this.grants.map((g) => ({ ...g }));
  }

  async listGrantsForUser(userId: UUID): Promise<RbacGrantRow[]> {
    return this.grants.filter((g) => g.userId === userId).map((g) => ({ ...g }));
  }

  async addGrant(row: RbacGrantRow): Promise<RbacGrantRow> {
    const dup = this.grants.find(
      (g) =>
        g.userId === row.userId && g.role === row.role && g.scope === row.scope
    );
    if (dup) return { ...dup };
    this.grants.push({ ...row });
    return { ...row };
  }

  async removeGrant(id: UUID): Promise<void> {
    this.grants = this.grants.filter((g) => g.id !== id);
  }
}

export class InMemoryAuthSettingsRepository
  implements AuthSettingsRepository
{
  private row: AuthSettingsRow = {
    signupMode: "admin_only",
    defaultRole: "viewer",
    updatedAt: new Date(0).toISOString()
  };

  async get(): Promise<AuthSettingsRow> {
    return { ...this.row };
  }

  async set(row: AuthSettingsRow): Promise<AuthSettingsRow> {
    this.row = { ...row, updatedAt: new Date().toISOString() };
    return { ...this.row };
  }
}

export class InMemoryWebhookTriggerRepository
  implements WebhookTriggerRepository
{
  private rows: WebhookTriggerRow[] = [];

  async create(row: WebhookTriggerRow): Promise<WebhookTriggerRow> {
    if (this.rows.some((r) => r.prefix === row.prefix)) {
      throw new ConflictError("webhook_trigger", `prefix exists: ${row.prefix}`);
    }
    this.rows.push({ ...row });
    return { ...row };
  }

  async get(id: string): Promise<WebhookTriggerRow | undefined> {
    const found = this.rows.find((r) => r.id === id);
    return found ? { ...found } : undefined;
  }

  async findByPrefix(prefix: string): Promise<WebhookTriggerRow | undefined> {
    const found = this.rows.find((r) => r.prefix === prefix);
    return found ? { ...found } : undefined;
  }

  async listForPipeline(
    tenantId: string,
    pipelineId: string
  ): Promise<WebhookTriggerRow[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && r.pipelineId === pipelineId)
      .map((r) => ({ ...r }));
  }

  async touch(id: string, at: string = new Date().toISOString()): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.lastTriggeredAt = at;
  }

  async delete(id: string): Promise<void> {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
}
