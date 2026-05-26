/**
 * Route-registration primitives shared by every per-domain module in
 * `apps/api/src/app/routes/*`. Each module declares its OWN deps
 * interface for the fields it needs (no giant union here) — keeps the
 * surface area honest and lets each migration land independently.
 */

import type { AppRequest, AppResponse, AppDeps } from "../types.ts";
import type { Principal } from "../../../../../packages/auth/src/index.ts";

export interface RouteContext {
  request: AppRequest;
  params: Record<string, string>;
  principal: Principal;
  deps: AppDeps;
}

export type Handler = (ctx: RouteContext) => Promise<AppResponse>;

export interface RouteRegistry {
  route(method: string, pattern: string, handler: Handler): void;
}

/**
 * `audit` closes over deps, the change bus, and a SENSITIVE_ACTIONS
 * table inside createApp. Migrated modules accept it as a service so
 * writes + live broadcasts keep flowing exactly as before.
 */
export type AuditWriter = (
  ctx: RouteContext,
  action: string,
  targetType: string,
  targetId: string,
  before: unknown,
  after: unknown
) => Promise<void>;
