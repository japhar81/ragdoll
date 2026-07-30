/**
 * ADR-0021: External Connections — platform-runtime side.
 *
 * The author-facing surface (driver types, `defineConnectionDriverPlugin`, the
 * driver registry, and the `TokenSource` credential helper) lives in the
 * dependency-free `@ragdoll/connection-sdk` package and is RE-EXPORTED here so
 * every existing `@ragdoll/external-connections` import keeps working. What
 * remains here is the one piece that needs the platform's secret store:
 *
 *   - `ExternalConnectionResolver`: given a slug + (tenant, env), walks the
 *     repo cascade, fetches the secret, and assembles the resolved object.
 *
 * Keeping the resolver here — and NOT in the SDK — is deliberate: a published
 * plugin depends on `@ragdoll/connection-sdk` alone and never inherits the
 * platform's secret-resolution runtime (or `@ragdoll/db` / `@ragdoll/secrets`).
 */

import type { ConnectionRepository, ConnectionRow } from "../../db/src/types.ts";
import { type SecretProvider, resolveConnectionSecret } from "../../secrets/src/index.ts";
import type {
  ResolvedExternalConnection,
  ResolveConnectionArgs
} from "../../connection-sdk/src/index.ts";

// Re-export the entire authoring surface so `@ragdoll/external-connections`
// remains a superset of the SDK for internal callers.
export * from "../../connection-sdk/src/index.ts";
export type { ConnectionRow, ConnectionRepository };

export class ExternalConnectionResolver {
  private repo: ConnectionRepository;
  private secrets: SecretProvider;

  constructor(repo: ConnectionRepository, secrets: SecretProvider) {
    this.repo = repo;
    this.secrets = secrets;
  }

  async resolve(
    args: ResolveConnectionArgs
  ): Promise<ResolvedExternalConnection | undefined> {
    const row = await this.repo.resolveSlug(args);
    if (!row) return undefined;
    // Cascade the secret across scopes (env → tenant → global) keyed
    // off the runtime tenant boundary, INDEPENDENTLY of the
    // connection's own scope. A tenant connection can use a global
    // credential and a global connection (running under a tenant) can
    // use a tenant credential — see `resolveConnectionSecret`. An
    // unresolved secret still surfaces the connection row; the driver
    // factory decides whether to fail.
    // Same cascade args are reused by the on-demand resolver below so a
    // dynamic re-resolution (token refresh) walks the identical scope path as
    // the initial resolve — a rotated stored secret is picked up in place.
    const secretRefKey = row.secretRefKey;
    const cascade = {
      tenantId: row.tenantId ?? args.tenantId ?? undefined,
      environment: args.environmentId ?? undefined
    };
    let secret: string | undefined;
    if (secretRefKey) {
      secret = await resolveConnectionSecret(this.secrets, {
        key: secretRefKey,
        ...cascade
      });
    }
    return {
      id: row.id,
      slug: row.slug,
      kind: row.kind,
      secret,
      resolveSecret: secretRefKey
        ? () =>
            resolveConnectionSecret(this.secrets, { key: secretRefKey, ...cascade })
        : undefined,
      options: row.config ?? {},
      cascadeReason:
        row.scope === "environment"
          ? "environment"
          : row.scope === "tenant"
            ? "tenant"
            : "global"
    };
  }
}
