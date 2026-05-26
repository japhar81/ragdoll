/**
 * Observability routes — audit log + usage + retention settings.
 *
 * These four endpoints (audit list, usage list, retention list,
 * retention patch) were the first to migrate out of app.ts because
 * they're read-mostly, mutually independent, and pinned by stable
 * `enforce(...)` permissions. The pattern they establish — a
 * `registerXxxRoutes(api, svc)` function taking the route registrar +
 * a service bundle — is what every other domain follows when it
 * migrates.
 */

import { enforce } from "../../../../../packages/auth/src/index.ts";
import { ok, error, isObject } from "../http-utils.ts";
import type { AppDeps } from "../types.ts";
import type { RetentionSettingsRepository } from "../../../../../packages/db/src/index.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";

interface ObservabilityServices {
  deps: AppDeps;
  audit: AuditWriter;
  retentionSettings: RetentionSettingsRepository;
}

export function registerObservabilityRoutes(
  api: RouteRegistry,
  svc: ObservabilityServices
): void {
  const { deps, retentionSettings, audit } = svc;

  api.route("GET", "/api/audit", async (ctx) => {
    enforce(ctx.principal, "audit:view");
    const tenantId = ctx.principal.roles.includes("platform_admin")
      ? (ctx.request.query.tenant_id ?? undefined)
      : ctx.principal.tenantId;
    const cursor =
      typeof ctx.request.query.cursor === "string"
        ? ctx.request.query.cursor
        : undefined;
    // When the caller passes `?limit=`, use cursor pagination; otherwise the
    // legacy "all rows" path runs unchanged for back-compat with API clients
    // that haven't migrated.
    if (ctx.request.query.limit !== undefined && deps.auditLogs.listPage) {
      const limit = Math.max(1, Math.min(200, Number(ctx.request.query.limit) || 50));
      const page = await deps.auditLogs.listPage({ tenantId, limit, cursor });
      return ok({
        logs: page.rows,
        nextCursor: page.nextCursor,
        total: page.total
      });
    }
    const limit = ctx.request.query.limit ? Number(ctx.request.query.limit) : undefined;
    const logs = await deps.auditLogs.list({ tenantId, limit });
    return ok({ logs });
  });

  api.route("GET", "/api/usage", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const tenantId = ctx.principal.roles.includes("platform_admin")
      ? (ctx.request.query.tenant_id ?? undefined)
      : ctx.principal.tenantId;
    const cursor =
      typeof ctx.request.query.cursor === "string"
        ? ctx.request.query.cursor
        : undefined;
    if (
      ctx.request.query.limit !== undefined &&
      deps.usageRecords.listPage &&
      ctx.request.query.execution_id === undefined
    ) {
      // Cursor path: paginated records, plus a summary that's local to the
      // returned page only. The web Usage screen recomputes summary across
      // pages client-side; deep aggregates use the non-paginated /api/usage.
      const limit = Math.max(1, Math.min(200, Number(ctx.request.query.limit) || 50));
      const page = await deps.usageRecords.listPage({ tenantId, limit, cursor });
      const summary = page.rows.reduce(
        (acc, record) => {
          acc.inputTokens += record.inputTokens;
          acc.outputTokens += record.outputTokens;
          acc.embeddingTokens += record.embeddingTokens;
          acc.estimatedCostUsd += record.estimatedCostUsd;
          acc.count += 1;
          return acc;
        },
        { inputTokens: 0, outputTokens: 0, embeddingTokens: 0, estimatedCostUsd: 0, count: 0 }
      );
      return ok({
        summary,
        records: page.rows,
        nextCursor: page.nextCursor,
        total: page.total
      });
    }
    const records = await deps.usageRecords.list({
      tenantId,
      executionId: ctx.request.query.execution_id
    });
    const summary = records.reduce(
      (acc, record) => {
        acc.inputTokens += record.inputTokens;
        acc.outputTokens += record.outputTokens;
        acc.embeddingTokens += record.embeddingTokens;
        acc.estimatedCostUsd += record.estimatedCostUsd;
        acc.count += 1;
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, embeddingTokens: 0, estimatedCostUsd: 0, count: 0 }
    );
    return ok({ summary, records });
  });

  // ---- retention settings -------------------------------------------------
  // Global-only platform config that drives the un-deletable retention sweep
  // worker job (see migration 012). Three rows, one per resource type.
  api.route("GET", "/api/retention", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const settings = await retentionSettings.list();
    return ok({ settings });
  });

  api.route("PATCH", "/api/retention/:resource", async (ctx) => {
    enforce(ctx.principal, "config:edit_global");
    const resource = ctx.params.resource;
    if (resource !== "executions" && resource !== "usage" && resource !== "audit") {
      return error(404, "not_found");
    }
    const body = ctx.request.body;
    if (!isObject(body)) {
      return error(422, "validation_failed", {
        issues: [{ message: "body required" }]
      });
    }
    // null clears a cap, omitted means "leave the existing value alone".
    // Read current to merge with patch so partial updates don't wipe the
    // unspecified column.
    const current = (await retentionSettings.list()).find(
      (r) => r.resource === resource
    );
    const maxCount =
      "maxCount" in body
        ? body.maxCount === null
          ? null
          : Number(body.maxCount)
        : (current?.maxCount ?? null);
    const maxAgeDays =
      "maxAgeDays" in body
        ? body.maxAgeDays === null
          ? null
          : Number(body.maxAgeDays)
        : (current?.maxAgeDays ?? null);
    if (maxCount !== null && (!Number.isFinite(maxCount) || maxCount < 0)) {
      return error(422, "validation_failed", {
        issues: [{ path: "maxCount", message: "non-negative number or null" }]
      });
    }
    if (
      maxAgeDays !== null &&
      (!Number.isFinite(maxAgeDays) || maxAgeDays < 0)
    ) {
      return error(422, "validation_failed", {
        issues: [{ path: "maxAgeDays", message: "non-negative integer or null" }]
      });
    }
    const updated = await retentionSettings.upsert({
      resource,
      maxCount,
      maxAgeDays: maxAgeDays === null ? null : Math.floor(maxAgeDays),
      updatedBy: ctx.principal.id
    });
    await audit(
      ctx,
      "retention.update",
      "retention",
      resource,
      current ?? undefined,
      updated
    );
    return ok({ setting: updated });
  });
}
