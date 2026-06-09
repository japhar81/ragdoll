import { randomUUID } from "node:crypto";
import type {
  ExecutionNodeRecord,
  ExecutionRecord,
  ExecutionStore
} from "../../../runtime/src/index.ts";
import type { UsageRecord, UUID } from "../../../core/src/index.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
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
  ConnectionRepository,
  ConnectionRow,
  DatasetRepository,
  DatasetRow,
  DatasetVersionRepository,
  DatasetVersionRow,
  DatasetAliasRepository,
  DatasetAliasRow,
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
  RetentionSettingRow,
  RetentionSettingsRepository,
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
  TenantGitConfigRepository,
  TenantGitConfigRow,
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
} from "../types.ts";

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

