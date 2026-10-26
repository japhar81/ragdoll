/**
 * Postgres repository over `connection_credential_grants` (ADR-0039,
 * migration 030). Short-lived, single-(execution, node, connection) tokens the
 * sidecar presents to re-materialise one connection's credential.
 *
 * `create` is inherited from PostgresCrudRepository — the generic
 * camelCase→snake_case insert + `RETURNING *` is exactly right here, and the
 * `token UNIQUE` collision surfaces as a ConflictError like every other repo.
 * The grant-specific verbs (lookup-by-token, redemption stamp, bulk revoke,
 * expiry sweep) are added below. The store never decides validity: the caller
 * checks `revoked_at` / `expires_at`.
 */
import type { PoolLike } from "../pool.ts";
import { PostgresCrudRepository } from "./base.ts";
import type * as T from "../types.ts";

export class PostgresConnectionCredentialGrantRepository
  extends PostgresCrudRepository<T.ConnectionCredentialGrantRow>
  implements T.ConnectionCredentialGrantRepository
{
  constructor(pool: PoolLike) {
    super(pool, "connection_credential_grants", "connection_credential_grant");
  }

  async getByToken(
    token: string
  ): Promise<T.ConnectionCredentialGrantRow | undefined> {
    return (
      await this.queryRows(
        `SELECT * FROM connection_credential_grants WHERE token = $1`,
        [token]
      )
    )[0];
  }

  async recordRedemption(token: string, at: string): Promise<void> {
    await this.pool.query(
      `UPDATE connection_credential_grants
         SET redeem_count = redeem_count + 1,
             last_redeemed_at = $2
       WHERE token = $1`,
      [token, at]
    );
  }

  async revokeForExecution(executionId: string, at: string): Promise<number> {
    // `revoked_at IS NULL` so already-revoked grants are not touched and not
    // counted — the affected-row count is the number this call actually
    // flipped.
    const result = await this.pool.query(
      `UPDATE connection_credential_grants
         SET revoked_at = $2
       WHERE execution_id = $1 AND revoked_at IS NULL`,
      [executionId, at]
    );
    return result.rowCount ?? 0;
  }

  async deleteExpired(now: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM connection_credential_grants WHERE expires_at <= $1`,
      [now]
    );
    return result.rowCount ?? 0;
  }
}
