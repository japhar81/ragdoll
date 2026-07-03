/**
 * In-memory repositories — auth domain.
 *
 * Extracted from memory.ts so each domain's in-memory store lives
 * next to its sibling repos. The public barrel (memory.ts) re-exports
 * everything here so the existing import path keeps working.
 */
import { randomUUID } from "node:crypto";
import type { ExecutionNodeRecord, ExecutionRecord, ExecutionStore } from "../../../runtime/src/index.ts";
import type { UsageRecord, UUID } from "../../../core/src/index.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import { InMemoryCrudRepository } from "./base.ts";
import type * as T from "../types.ts";


export class InMemoryApiKeyRepository implements T.ApiKeyRepository {
  private rows = new Map<string, T.ApiKeyRow>();

  async create(row: T.ApiKeyRow): Promise<T.ApiKeyRow> {
    for (const existing of this.rows.values()) {
      if (existing.prefix === row.prefix) {
        throw new ConflictError("api_key", `prefix already exists: ${row.prefix}`);
      }
    }
    this.rows.set(row.id, structuredClone(row));
    return structuredClone(row);
  }

  async findByPrefix(prefix: string): Promise<T.ApiKeyRow | undefined> {
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

  async listByPrincipal(principalId: UUID): Promise<T.ApiKeyRow[]> {
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

export class InMemoryUserRepository
  extends InMemoryCrudRepository<T.UserRow>
  implements T.UserRepository
{
  constructor() {
    super("user");
  }
  async findByEmail(email: string): Promise<T.UserRow | undefined> {
    return (await this.list()).find((row) => row.email === email);
  }
}


export class InMemoryRoleRepository
  extends InMemoryCrudRepository<T.RoleRow>
  implements T.RoleRepository
{
  constructor() {
    super("role");
  }
  async findByName(name: string): Promise<T.RoleRow | undefined> {
    return (await this.list()).find((row) => row.name === name);
  }
}


export class InMemoryUserRoleRepository implements T.UserRoleRepository {
  private rows: T.UserRoleRow[] = [];

  private same(a: T.UserRoleRow, b: T.UserRoleRow): boolean {
    return (
      a.userId === b.userId &&
      a.roleId === b.roleId &&
      (a.tenantId ?? null) === (b.tenantId ?? null) &&
      (a.environment ?? null) === (b.environment ?? null) &&
      (a.pipelineId ?? null) === (b.pipelineId ?? null)
    );
  }

  async assign(row: T.UserRoleRow): Promise<T.UserRoleRow> {
    if (!this.rows.some((existing) => this.same(existing, row))) {
      this.rows.push({ ...row });
    }
    return { ...row };
  }

  async remove(row: T.UserRoleRow): Promise<void> {
    this.rows = this.rows.filter((existing) => !this.same(existing, row));
  }

  async listForUser(userId: UUID): Promise<T.UserRoleRow[]> {
    return this.rows.filter((row) => row.userId === userId).map((row) => ({ ...row }));
  }
}


export class InMemoryUserIdentityRepository
  implements T.UserIdentityRepository
{
  private rows: T.UserIdentityRow[] = [];

  async create(row: T.UserIdentityRow): Promise<T.UserIdentityRow> {
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
  ): Promise<T.UserIdentityRow | undefined> {
    const found = this.rows.find(
      (r) => r.provider === provider && r.subject === subject
    );
    return found ? { ...found } : undefined;
  }

  async listForUser(userId: UUID): Promise<T.UserIdentityRow[]> {
    return this.rows.filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }

  async delete(id: UUID): Promise<void> {
    this.rows = this.rows.filter((r) => r.id !== id);
  }
}


export class InMemoryIdentityProviderRepository
  extends InMemoryCrudRepository<T.IdentityProviderRow>
  implements T.IdentityProviderRepository
{
  constructor() {
    super("identity_provider");
  }
  async findBySlug(slug: string): Promise<T.IdentityProviderRow | undefined> {
    return (await this.list()).find((row) => row.slug === slug);
  }
  async listEnabled(): Promise<T.IdentityProviderRow[]> {
    return (await this.list()).filter((row) => row.enabled);
  }
}

export class InMemoryEventSubscriptionRepository
  extends InMemoryCrudRepository<T.EventSubscriptionRow>
  implements T.EventSubscriptionRepository
{
  constructor() {
    super("event_subscription");
  }
  async listActiveForTenant(
    tenantId: string | null
  ): Promise<T.EventSubscriptionRow[]> {
    return (await this.list()).filter(
      (row) =>
        row.active &&
        ((row.tenantId ?? null) === tenantId || (row.tenantId ?? null) === null)
    );
  }
  async listByTenant(
    tenantId?: string | null
  ): Promise<T.EventSubscriptionRow[]> {
    const all = await this.list();
    if (tenantId === undefined) return all;
    return all.filter((row) => (row.tenantId ?? null) === (tenantId ?? null));
  }
}


export class InMemoryRbacPolicyRepository implements T.RbacPolicyRepository {
  private rolePerms: T.RbacRolePermissionRow[] = [];
  private grants: T.RbacGrantRow[] = [];

  async listRolePermissions(): Promise<T.RbacRolePermissionRow[]> {
    return this.rolePerms.map((r) => ({ ...r }));
  }

  async addRolePermission(row: T.RbacRolePermissionRow): Promise<void> {
    if (
      !this.rolePerms.some(
        (r) => r.role === row.role && r.permission === row.permission
      )
    ) {
      this.rolePerms.push({ ...row });
    }
  }

  async removeRolePermission(row: T.RbacRolePermissionRow): Promise<void> {
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

  async listGrants(): Promise<T.RbacGrantRow[]> {
    return this.grants.map((g) => ({ ...g }));
  }

  async listGrantsForUser(userId: UUID): Promise<T.RbacGrantRow[]> {
    return this.grants.filter((g) => g.userId === userId).map((g) => ({ ...g }));
  }

  async addGrant(row: T.RbacGrantRow): Promise<T.RbacGrantRow> {
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
  implements T.AuthSettingsRepository
{
  private row: T.AuthSettingsRow = {
    signupMode: "admin_only",
    defaultRole: "viewer",
    updatedAt: new Date(0).toISOString()
  };

  async get(): Promise<T.AuthSettingsRow> {
    return { ...this.row };
  }

  async set(row: T.AuthSettingsRow): Promise<T.AuthSettingsRow> {
    this.row = { ...row, updatedAt: new Date().toISOString() };
    return { ...this.row };
  }
}


export class InMemoryWebhookTriggerRepository
  implements T.WebhookTriggerRepository
{
  private rows: T.WebhookTriggerRow[] = [];

  async create(row: T.WebhookTriggerRow): Promise<T.WebhookTriggerRow> {
    if (this.rows.some((r) => r.prefix === row.prefix)) {
      throw new ConflictError("webhook_trigger", `prefix exists: ${row.prefix}`);
    }
    this.rows.push({ ...row });
    return { ...row };
  }

  async get(id: string): Promise<T.WebhookTriggerRow | undefined> {
    const found = this.rows.find((r) => r.id === id);
    return found ? { ...found } : undefined;
  }

  async findByPrefix(prefix: string): Promise<T.WebhookTriggerRow | undefined> {
    const found = this.rows.find((r) => r.prefix === prefix);
    return found ? { ...found } : undefined;
  }

  async listForPipeline(
    tenantId: string,
    pipelineId: string
  ): Promise<T.WebhookTriggerRow[]> {
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

