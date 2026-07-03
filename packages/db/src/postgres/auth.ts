/**
 * Postgres repositories — auth domain.
 *
 * Extracted from postgres-repos.ts so each domain's repository code
 * lives next to the other repos that share its table neighbourhood.
 * The public barrel `postgres-repos.ts` re-exports everything here.
 */
import type { UUID } from "../../../core/src/index.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import type { PoolLike } from "../pool.ts";
import { withTransaction } from "../pool.ts";
import {
  PostgresCrudRepository,
  toUuidOrNull,
  rowFromDb,
  camelToSnake,
  snakeToCamel
} from "./base.ts";
import type * as T from "../types.ts";


export class PostgresApiKeyRepository implements T.ApiKeyRepository {
  private pool: PoolLike;

  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async create(row: T.ApiKeyRow): Promise<T.ApiKeyRow> {
    try {
      const result = await this.pool.query<Record<string, unknown>>(
        `INSERT INTO api_keys
           (id, tenant_id, environment_id, principal_id, name, prefix, hash, roles, created_at, last_used_at, revoked_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          row.id,
          row.tenantId ?? null,
          row.environmentId ?? null,
          row.principalId,
          row.name,
          row.prefix,
          row.hash,
          row.roles,
          row.createdAt,
          row.lastUsedAt ?? null,
          row.revokedAt ?? null,
          row.expiresAt ?? null
        ]
      );
      return mapApiKey(result.rows[0]);
    } catch (error) {
      if (
        error instanceof Error &&
        /duplicate key|unique constraint/i.test(error.message)
      ) {
        throw new ConflictError("api_key", error.message);
      }
      throw error;
    }
  }

  async findByPrefix(prefix: string): Promise<T.ApiKeyRow | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM api_keys WHERE prefix = $1`,
      [prefix]
    );
    return result.rows[0] ? mapApiKey(result.rows[0]) : undefined;
  }

  async touch(id: UUID, at: string = new Date().toISOString()): Promise<void> {
    const result = await this.pool.query(
      `UPDATE api_keys SET last_used_at = $2 WHERE id = $1`,
      [id, at]
    );
    if (!result.rowCount) throw new NotFoundError("api_key", id);
  }

  async revoke(id: UUID, at: string = new Date().toISOString()): Promise<void> {
    const result = await this.pool.query(
      `UPDATE api_keys SET revoked_at = $2 WHERE id = $1`,
      [id, at]
    );
    if (!result.rowCount) throw new NotFoundError("api_key", id);
  }

  async listByPrincipal(principalId: UUID): Promise<T.ApiKeyRow[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM api_keys WHERE principal_id = $1`,
      [principalId]
    );
    return result.rows.map(mapApiKey);
  }
}

function mapApiKey(row: Record<string, unknown>): T.ApiKeyRow {
  return {
    id: row.id as string,
    tenantId: (row.tenant_id as string | null) ?? undefined,
    environmentId: (row.environment_id as string | null) ?? undefined,
    principalId: row.principal_id as string,
    name: row.name as string,
    prefix: row.prefix as string,
    hash: row.hash as string,
    roles: ((row.roles as string[] | null) ?? []) as T.ApiKeyRow["roles"],
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : (row.created_at as string),
    lastUsedAt:
      row.last_used_at instanceof Date
        ? row.last_used_at.toISOString()
        : ((row.last_used_at as string | null) ?? undefined),
    revokedAt:
      row.revoked_at instanceof Date
        ? row.revoked_at.toISOString()
        : ((row.revoked_at as string | null) ?? undefined),
    expiresAt:
      row.expires_at instanceof Date
        ? row.expires_at.toISOString()
        : ((row.expires_at as string | null) ?? undefined)
  };
}

// --- Auth / RBAC -----------------------------------------------------------


export class PostgresUserRepository
  extends PostgresCrudRepository<T.UserRow>
  implements T.UserRepository
{
  constructor(pool: PoolLike) {
    super(pool, "users", "user");
  }
  async findByEmail(email: string): Promise<T.UserRow | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM users WHERE lower(email) = lower($1)`,
      [email]
    );
    return result.rows[0] ? rowFromDb<T.UserRow>(result.rows[0]) : undefined;
  }
}


export class PostgresRoleRepository
  extends PostgresCrudRepository<T.RoleRow>
  implements T.RoleRepository
{
  constructor(pool: PoolLike) {
    super(pool, "roles", "role");
  }
  async findByName(name: string): Promise<T.RoleRow | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM roles WHERE name = $1`,
      [name]
    );
    return result.rows[0] ? rowFromDb<T.RoleRow>(result.rows[0]) : undefined;
  }
}


export class PostgresUserIdentityRepository
  implements T.UserIdentityRepository
{
  private pool: PoolLike;
  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async create(row: T.UserIdentityRow): Promise<T.UserIdentityRow> {
    try {
      const r = await this.pool.query<Record<string, unknown>>(
        `INSERT INTO user_identities (id, user_id, provider, subject, email)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [row.id, row.userId, row.provider, row.subject, row.email ?? null]
      );
      return rowFromDb<T.UserIdentityRow>(r.rows[0]);
    } catch (error) {
      if (
        error instanceof Error &&
        /duplicate key|unique constraint/i.test(error.message)
      ) {
        throw new ConflictError("user_identity", error.message);
      }
      throw error;
    }
  }

  async findBySubject(
    provider: string,
    subject: string
  ): Promise<T.UserIdentityRow | undefined> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM user_identities WHERE provider = $1 AND subject = $2`,
      [provider, subject]
    );
    return r.rows[0] ? rowFromDb<T.UserIdentityRow>(r.rows[0]) : undefined;
  }

  async listForUser(userId: string): Promise<T.UserIdentityRow[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM user_identities WHERE user_id = $1 ORDER BY created_at`,
      [userId]
    );
    return r.rows.map((row) => rowFromDb<T.UserIdentityRow>(row));
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM user_identities WHERE id = $1`, [id]);
  }
}


export class PostgresIdentityProviderRepository
  extends PostgresCrudRepository<T.IdentityProviderRow>
  implements T.IdentityProviderRepository
{
  constructor(pool: PoolLike) {
    super(pool, "identity_providers", "identity_provider", ["config"]);
  }
  async findBySlug(slug: string): Promise<T.IdentityProviderRow | undefined> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM identity_providers WHERE slug = $1`,
      [slug]
    );
    return r.rows[0] ? rowFromDb<T.IdentityProviderRow>(r.rows[0]) : undefined;
  }
  async listEnabled(): Promise<T.IdentityProviderRow[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM identity_providers WHERE enabled = true ORDER BY display_name`
    );
    return r.rows.map((row) => rowFromDb<T.IdentityProviderRow>(row));
  }
}

export class PostgresEventSubscriptionRepository
  extends PostgresCrudRepository<T.EventSubscriptionRow>
  implements T.EventSubscriptionRepository
{
  constructor(pool: PoolLike) {
    // events/phases are text[] (not JSONB), so no json columns to declare.
    super(pool, "event_subscriptions", "event_subscription", []);
  }
  async listActiveForTenant(
    tenantId: string | null
  ): Promise<T.EventSubscriptionRow[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM event_subscriptions
        WHERE active = true
          AND (tenant_id IS NOT DISTINCT FROM $1 OR tenant_id IS NULL)`,
      [tenantId]
    );
    return r.rows.map((row) => rowFromDb<T.EventSubscriptionRow>(row));
  }
  async listByTenant(
    tenantId?: string | null
  ): Promise<T.EventSubscriptionRow[]> {
    if (tenantId === undefined) {
      const r = await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM event_subscriptions ORDER BY created_at DESC`
      );
      return r.rows.map((row) => rowFromDb<T.EventSubscriptionRow>(row));
    }
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM event_subscriptions
        WHERE tenant_id IS NOT DISTINCT FROM $1 ORDER BY created_at DESC`,
      [tenantId]
    );
    return r.rows.map((row) => rowFromDb<T.EventSubscriptionRow>(row));
  }
}

export class PostgresWebhookDeliveryFailureRepository
  extends PostgresCrudRepository<T.WebhookDeliveryFailureRow>
  implements T.WebhookDeliveryFailureRepository
{
  constructor(pool: PoolLike) {
    super(pool, "webhook_delivery_failures", "webhook_delivery_failure", [
      "event"
    ]);
  }
  async listByTenant(
    tenantId?: string | null
  ): Promise<T.WebhookDeliveryFailureRow[]> {
    if (tenantId === undefined) {
      const r = await this.pool.query<Record<string, unknown>>(
        `SELECT * FROM webhook_delivery_failures
          ORDER BY replayed_at NULLS FIRST, failed_at DESC`
      );
      return r.rows.map((row) => rowFromDb<T.WebhookDeliveryFailureRow>(row));
    }
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM webhook_delivery_failures
        WHERE tenant_id IS NOT DISTINCT FROM $1
        ORDER BY replayed_at NULLS FIRST, failed_at DESC`,
      [tenantId]
    );
    return r.rows.map((row) => rowFromDb<T.WebhookDeliveryFailureRow>(row));
  }
  async markReplayed(id: string, at: string): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_delivery_failures SET replayed_at = $2 WHERE id = $1`,
      [id, at]
    );
  }
}


export class PostgresRbacPolicyRepository implements T.RbacPolicyRepository {
  private pool: PoolLike;
  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async listRolePermissions(): Promise<T.RbacRolePermissionRow[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT role, permission FROM rbac_role_permissions`
    );
    return r.rows.map((row) => ({
      role: row.role as string,
      permission: row.permission as string
    }));
  }

  async addRolePermission(row: T.RbacRolePermissionRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO rbac_role_permissions (role, permission)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [row.role, row.permission]
    );
  }

  async removeRolePermission(row: T.RbacRolePermissionRow): Promise<void> {
    await this.pool.query(
      `DELETE FROM rbac_role_permissions WHERE role = $1 AND permission = $2`,
      [row.role, row.permission]
    );
  }

  async setRolePermissions(
    role: string,
    permissions: string[]
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `DELETE FROM rbac_role_permissions WHERE role = $1`,
        [role]
      );
      for (const permission of new Set(permissions)) {
        await client.query(
          `INSERT INTO rbac_role_permissions (role, permission)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [role, permission]
        );
      }
    });
  }

  async listGrants(): Promise<T.RbacGrantRow[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM rbac_grants`
    );
    return r.rows.map((row) => rowFromDb<T.RbacGrantRow>(row));
  }

  async listGrantsForUser(userId: string): Promise<T.RbacGrantRow[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM rbac_grants WHERE user_id = $1`,
      [userId]
    );
    return r.rows.map((row) => rowFromDb<T.RbacGrantRow>(row));
  }

  async addGrant(row: T.RbacGrantRow): Promise<T.RbacGrantRow> {
    const r = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO rbac_grants (id, user_id, role, scope)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, role, scope) DO UPDATE SET role = EXCLUDED.role
       RETURNING *`,
      [row.id, row.userId, row.role, row.scope]
    );
    return rowFromDb<T.RbacGrantRow>(r.rows[0]);
  }

  async removeGrant(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM rbac_grants WHERE id = $1`, [id]);
  }
}


export class PostgresAuthSettingsRepository
  implements T.AuthSettingsRepository
{
  private pool: PoolLike;
  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async get(): Promise<T.AuthSettingsRow> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT signup_mode, default_role, updated_at FROM auth_settings WHERE id = true`
    );
    if (!r.rows[0]) {
      return {
        signupMode: "admin_only",
        defaultRole: "viewer",
        updatedAt: new Date(0).toISOString()
      };
    }
    return rowFromDb<T.AuthSettingsRow>(r.rows[0]);
  }

  async set(row: T.AuthSettingsRow): Promise<T.AuthSettingsRow> {
    const r = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO auth_settings (id, signup_mode, default_role, updated_at)
       VALUES (true, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET
         signup_mode = EXCLUDED.signup_mode,
         default_role = EXCLUDED.default_role,
         updated_at = now()
       RETURNING signup_mode, default_role, updated_at`,
      [row.signupMode, row.defaultRole ?? null]
    );
    return rowFromDb<T.AuthSettingsRow>(r.rows[0]);
  }
}

// --- Webhook triggers ------------------------------------------------------


export class PostgresWebhookTriggerRepository
  implements T.WebhookTriggerRepository
{
  private pool: PoolLike;
  constructor(pool: PoolLike) {
    this.pool = pool;
  }

  async create(row: T.WebhookTriggerRow): Promise<T.WebhookTriggerRow> {
    try {
      const r = await this.pool.query<Record<string, unknown>>(
        `INSERT INTO webhook_triggers (
           id, tenant_id, pipeline_id, environment, activation_label,
           name, prefix, hash, enabled, created_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          row.id,
          row.tenantId,
          row.pipelineId,
          row.environment,
          row.activationLabel ?? null,
          row.name,
          row.prefix,
          row.hash,
          row.enabled,
          toUuidOrNull(row.createdBy)
        ]
      );
      return rowFromDb<T.WebhookTriggerRow>(r.rows[0]);
    } catch (e) {
      if (
        e instanceof Error &&
        /duplicate key|unique constraint/i.test(e.message)
      ) {
        throw new ConflictError("webhook_trigger", e.message);
      }
      throw e;
    }
  }

  async get(id: string): Promise<T.WebhookTriggerRow | undefined> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM webhook_triggers WHERE id = $1`,
      [id]
    );
    return r.rows[0] ? rowFromDb<T.WebhookTriggerRow>(r.rows[0]) : undefined;
  }

  async findByPrefix(prefix: string): Promise<T.WebhookTriggerRow | undefined> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM webhook_triggers WHERE prefix = $1`,
      [prefix]
    );
    return r.rows[0] ? rowFromDb<T.WebhookTriggerRow>(r.rows[0]) : undefined;
  }

  async listForPipeline(
    tenantId: string,
    pipelineId: string
  ): Promise<T.WebhookTriggerRow[]> {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM webhook_triggers
       WHERE tenant_id = $1 AND pipeline_id = $2
       ORDER BY created_at DESC`,
      [tenantId, pipelineId]
    );
    return r.rows.map((row) => rowFromDb<T.WebhookTriggerRow>(row));
  }

  async touch(id: string, at: string = new Date().toISOString()): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_triggers SET last_triggered_at = $2 WHERE id = $1`,
      [id, at]
    );
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM webhook_triggers WHERE id = $1`, [id]);
  }
}

/**
 * Postgres-backed `IngestStateRepository`. Each row is one source document
 * the `delta_filter` plugin has previously ingested for the named
 * (tenant, pipeline, stateKey) bucket. The plugin computes new/modified/
 * deleted in memory and hands the full new set to `replaceAll`, which we
 * apply transactionally so a partial failure can't leave the bucket
 * half-updated.
 */
