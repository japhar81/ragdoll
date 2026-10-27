/**
 * ADR-0039: connection credentials for external (sidecar) plugins — the
 * platform-runtime glue that turns an in-core connection driver into a
 * credential a sidecar can hold and refresh.
 *
 * Two halves live here, both deliberately transport-free so they unit-test
 * without a worker, an HTTP server, or a real database:
 *
 *   - {@link buildConnectionCredentialRuntimeOptions} — the executor-option
 *     trio the worker/API wire into the DagExecutor: materialise a credential
 *     via the driver's opt-in hook, mint a revocable refresh grant, and revoke
 *     a run's grants when it ends.
 *   - {@link redeemConnectionCredentialGrant} — the API callback logic: given a
 *     grant token, validate it (unknown / revoked / expired), re-resolve the
 *     connection, re-materialise a fresh credential, and stamp the redemption.
 *
 * The grant is the whole authorisation: it is minted ONLY after the runtime has
 * already enforced `connection:use`, it is scoped to exactly one
 * (execution, node, connection), it expires with the run, and it is revocable.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type {
  ConnectionCredentialGrantRepository
} from "../../db/src/types.ts";
import {
  materializeExternalCredential,
  type CredentialMaterializationContext,
  type ExternalCredential,
  type MaterializedExternalCredential,
  type ResolvedExternalConnection
} from "../../connection-sdk/src/index.ts";

/** The API path the sidecar POSTs `{ token }` to for a fresh credential. */
export const CONNECTION_CREDENTIAL_REFRESH_PATH =
  "/api/internal/connection-credentials/refresh";

/** Default grant TTL when a run carries no deadline (1 hour — the platform
 *  default per-pipeline timeout). A grant never outlives its run's deadline. */
const DEFAULT_MAX_TTL_MS = 60 * 60 * 1000;

export interface ConnectionCredentialCallbackOptions {
  /** The shared, durable grant store (Postgres in prod; the worker writes and
   *  the API reads the SAME store). */
  grants: ConnectionCredentialGrantRepository;
  /** Absolute base URL of the API as reachable BY THE SIDECAR (no trailing
   *  slash required). The refresh path is appended to it. */
  callbackBaseUrl: string;
  /** Cap on grant lifetime when the run has no deadline. Default 1h. */
  maxTtlMs?: number;
}

/**
 * The executor-option trio (ADR-0039). Shaped to drop straight into
 * `new DagExecutor({ ...buildConnectionCredentialRuntimeOptions(...) })`.
 */
export interface ConnectionCredentialRuntimeOptions {
  materializeExternalCredential: (
    connection: ResolvedExternalConnection,
    context?: CredentialMaterializationContext
  ) => Promise<MaterializedExternalCredential | undefined>;
  issueConnectionRefreshGrant: (args: {
    executionId: string;
    nodeId: string;
    tenantId: string;
    environment: string;
    connectionSlug: string;
    deadline?: Date;
    /** ADR-0040: driver-nominated, identifiers-only selectors to persist on the
     *  grant and replay on the refresh callback. Omitted by connection-only
     *  drivers. */
    refreshContext?: Record<string, unknown>;
  }) => Promise<{ url: string; token: string; expiresAt?: string } | undefined>;
  revokeConnectionRefreshGrants: (executionId: string) => Promise<void>;
}

export function buildConnectionCredentialRuntimeOptions(
  opts: ConnectionCredentialCallbackOptions
): ConnectionCredentialRuntimeOptions {
  const maxTtlMs = opts.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
  const base = opts.callbackBaseUrl.replace(/\/+$/, "");
  const url = `${base}${CONNECTION_CREDENTIAL_REFRESH_PATH}`;
  return {
    materializeExternalCredential: (connection, context) =>
      materializeExternalCredential(connection, context),
    issueConnectionRefreshGrant: async (args) => {
      const now = Date.now();
      // Bound the grant by the run deadline AND an absolute ceiling, whichever
      // is sooner — a leaked token is useless once the run (or the ceiling)
      // passes, even before explicit revocation.
      const deadlineMs = args.deadline ? args.deadline.getTime() : now + maxTtlMs;
      const expiresAtMs = Math.min(deadlineMs, now + maxTtlMs);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(expiresAtMs).toISOString();
      await opts.grants.create({
        id: randomUUID(),
        token,
        executionId: args.executionId,
        nodeId: args.nodeId,
        tenantId: args.tenantId,
        environment: args.environment,
        connectionSlug: args.connectionSlug,
        expiresAt,
        revokedAt: null,
        redeemCount: 0,
        lastRedeemedAt: null,
        createdAt: new Date(now).toISOString(),
        // ADR-0040: persist the driver's refresh selectors so the API callback
        // (which has no node config / input ports) can replay them. `null` for
        // connection-only drivers — the column stays empty.
        materializationContext: args.refreshContext ?? null
      });
      return { url, token, expiresAt };
    },
    revokeConnectionRefreshGrants: async (executionId) => {
      await opts.grants.revokeForExecution(executionId, new Date().toISOString());
    }
  };
}

/** Outcome of a grant redemption — mapped to an HTTP status by the route. */
export type RedeemStatus =
  | "ok"
  | "unknown_token"
  | "revoked"
  | "expired"
  | "no_connection"
  | "not_materializable";

export interface RedeemResult {
  status: RedeemStatus;
  credential?: ExternalCredential;
  /** The grant row (when the token was known) — the route reads it for audit. */
  grant?: Awaited<ReturnType<ConnectionCredentialGrantRepository["getByToken"]>>;
}

/**
 * Redeem a refresh grant for a fresh credential. Pure logic over the grant
 * store + the connection resolver — the HTTP route is a thin wrapper that maps
 * {@link RedeemStatus} to a status code and writes the audit entry.
 */
export async function redeemConnectionCredentialGrant(args: {
  token: string;
  grants: ConnectionCredentialGrantRepository;
  resolver: {
    resolve(a: {
      slug: string;
      tenantId?: string;
      environmentId?: string;
    }): Promise<ResolvedExternalConnection | undefined>;
  };
  now?: Date;
}): Promise<RedeemResult> {
  const now = args.now ?? new Date();
  const grant = await args.grants.getByToken(args.token);
  if (!grant) return { status: "unknown_token" };
  if (grant.revokedAt) return { status: "revoked", grant };
  if (new Date(grant.expiresAt).getTime() <= now.getTime()) {
    return { status: "expired", grant };
  }
  const conn = await args.resolver.resolve({
    slug: grant.connectionSlug,
    tenantId: grant.tenantId,
    environmentId: grant.environment
  });
  if (!conn) return { status: "no_connection", grant };
  // ADR-0040: the callback has no live node config / input ports — rebuild the
  // materialisation context from the grant and replay the driver's nominated
  // `refreshContext` (persisted on issue). A run-context-dependent driver reads
  // its selectors back from `context.refreshContext`; a connection-only driver
  // (no persisted context) ignores all of it, exactly as on the first call.
  const context: CredentialMaterializationContext = {
    tenantId: grant.tenantId,
    environment: grant.environment,
    executionId: grant.executionId,
    nodeId: grant.nodeId,
    config: {},
    inputs: {},
    refreshContext: grant.materializationContext ?? undefined
  };
  const credential = await materializeExternalCredential(conn, context);
  if (!credential) return { status: "not_materializable", grant };
  await args.grants.recordRedemption(args.token, now.toISOString());
  // Strip the core-only `refreshContext` — only the wire credential goes back
  // to the sidecar. The persisted selectors are unchanged by a refresh.
  const { refreshContext: _refreshContext, ...wireCredential } = credential;
  return { status: "ok", credential: wireCredential, grant };
}
