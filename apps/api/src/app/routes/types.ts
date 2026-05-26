/**
 * Route registration contract — used by per-domain modules in
 * `apps/api/src/app/routes/*` so the bulk of app.ts can shrink to dep
 * wiring + a sequence of `register*Routes(api, svc)` calls.
 *
 * `api.route(...)` mirrors the existing closure-local `route(...)`
 * inside createApp so migrated modules don't need to rewrite their
 * registration calls.
 *
 * `svc` carries the closure-local state each route handler needs
 * (resolved repos, the audit helper, the change-event bus, etc.).
 * Add fields here only when a newly-extracted domain needs them.
 */

import type {
  AppRequest,
  AppResponse,
  AppDeps
} from "../types.ts";
import type { Principal } from "../../../../../packages/auth/src/index.ts";
import type {
  AuditLogRepository,
  UsageRecordRepository,
  RetentionSettingsRepository
} from "../../../../../packages/db/src/index.ts";
import type { ChangeBus } from "../../../../../packages/events/src/index.ts";

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
 * The `audit` helper inside createApp closes over `deps`, the change
 * bus, and a SENSITIVE_ACTIONS table. Extracted modules accept it as
 * a service so the writes + live broadcast keep flowing exactly as
 * before — no double-implementations, no behavioural drift.
 */
export type AuditWriter = (
  ctx: RouteContext,
  action: string,
  targetType: string,
  targetId: string,
  before: unknown,
  after: unknown
) => Promise<void>;

/**
 * Slimmest possible per-domain dep bundle. Each register*Routes function
 * picks what it needs; we widen this as more domains migrate.
 */
export interface RouteServices {
  deps: AppDeps;
  changeBus: ChangeBus;
  audit: AuditWriter;
  retentionSettings: RetentionSettingsRepository;
  auditLogs: AuditLogRepository;
  usageRecords: UsageRecordRepository;
}
