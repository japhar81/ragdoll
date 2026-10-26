/**
 * In-memory ConnectionCredentialGrantRepository for tests + offline mode
 * (ADR-0039 — credential grants for external/sidecar plugins).
 *
 * A grant is a short-lived, single-(execution, node, connection) token the
 * sidecar presents to re-materialise one connection's credential. The store
 * is deliberately dumb: it holds rows keyed by token and never decides
 * validity. `getByToken` returns the row as-is (revoked/expired included) and
 * the caller enforces `revokedAt` / `expiresAt`. Mirrors the Postgres SQL
 * invariants from migration 030 (token UNIQUE, revoke-only-the-live, delete
 * past-expiry).
 */
import type * as T from "../types.ts";

export class InMemoryConnectionCredentialGrantRepository
  implements T.ConnectionCredentialGrantRepository
{
  protected rows = new Map<string, T.ConnectionCredentialGrantRow>();

  async create(
    row: T.ConnectionCredentialGrantRow
  ): Promise<T.ConnectionCredentialGrantRow> {
    this.rows.set(row.token, structuredClone(row));
    return structuredClone(row);
  }

  async getByToken(
    token: string
  ): Promise<T.ConnectionCredentialGrantRow | undefined> {
    const row = this.rows.get(token);
    return row ? structuredClone(row) : undefined;
  }

  async recordRedemption(token: string, at: string): Promise<void> {
    const existing = this.rows.get(token);
    if (!existing) return;
    existing.redeemCount += 1;
    existing.lastRedeemedAt = at;
  }

  async revokeForExecution(executionId: string, at: string): Promise<number> {
    let changed = 0;
    for (const row of this.rows.values()) {
      if (row.executionId !== executionId) continue;
      // Already-revoked grants are left untouched and NOT counted — the
      // return value is "rows this call actually flipped", matching the
      // SQL `WHERE revoked_at IS NULL` affected-row count.
      if (row.revokedAt) continue;
      row.revokedAt = at;
      changed += 1;
    }
    return changed;
  }

  async deleteExpired(now: string): Promise<number> {
    let removed = 0;
    for (const [token, row] of this.rows) {
      // All timestamps are ISO-8601 UTC, so lexical compare matches
      // chronological order. `<=` so a grant invalid exactly at `now`
      // (expiry already reached) is swept.
      if (row.expiresAt <= now) {
        this.rows.delete(token);
        removed += 1;
      }
    }
    return removed;
  }
}
