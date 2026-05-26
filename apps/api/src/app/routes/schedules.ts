/**
 * Schedule CRUD with cron parsing + next-run computation.
 *
 * `system: true` rows (the un-deletable retention + stale-exec
 * sweepers) bypass the per-tenant grant check and require
 * `config:edit_global`; ordinary user schedules use
 * `config:edit_tenant`.
 */
import { randomUUID } from "node:crypto";
import { enforce } from "../../../../../packages/auth/src/index.ts";
import {
  parseCron,
  nextAfter,
  CronParseError
} from "../../../../../packages/cron/src/index.ts";
import type {
  ScheduleRow,
  ScheduleRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";

interface SchedulesServices {
  schedules: ScheduleRepository;
  audit: AuditWriter;
}

export function registerSchedulesRoutes(
  api: RouteRegistry,
  svc: SchedulesServices
): void {
  const { schedules, audit } = svc;

  function scheduleNextRun(
    cron: string,
    timezone?: string
  ): { ok: true; next: string } | { ok: false; message: string } {
    try {
      parseCron(cron, timezone);
    } catch (e) {
      if (e instanceof CronParseError) {
        return { ok: false, message: e.message };
      }
      throw e;
    }
    return {
      ok: true,
      next: nextAfter(cron, new Date(), timezone).toISOString()
    };
  }

  api.route("GET", "/api/schedules", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    let rows = await schedules.list();
    const tenant = ctx.request.query.tenant;
    const pipeline = ctx.request.query.pipeline;
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId
    ) {
      rows = rows.filter((row) => row.tenantId === ctx.principal.tenantId);
    }
    if (tenant) rows = rows.filter((row) => row.tenantId === tenant);
    if (pipeline) rows = rows.filter((row) => row.pipelineId === pipeline);
    return ok({ schedules: rows });
  });

  api.route("POST", "/api/schedules", async (ctx) => {
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.tenantId !== "string" ||
      typeof body.pipelineId !== "string" ||
      typeof body.environment !== "string" ||
      typeof body.cron !== "string"
    ) {
      return error(422, "validation_failed", {
        issues: [
          { message: "tenantId, pipelineId, environment and cron are required" }
        ]
      });
    }
    enforce(ctx.principal, "config:edit_tenant", { tenantId: body.tenantId });
    const tz = typeof body.timezone === "string" ? body.timezone : "UTC";
    const next = scheduleNextRun(body.cron, tz);
    if (!next.ok) {
      return error(422, "validation_failed", {
        issues: [{ path: "cron", message: next.message }]
      });
    }
    const row: ScheduleRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      tenantId: body.tenantId,
      pipelineId: body.pipelineId,
      environment: body.environment,
      activationLabel:
        typeof body.activationLabel === "string" ? body.activationLabel : null,
      cron: body.cron,
      timezone: tz,
      input: isObject(body.input) ? body.input : {},
      enabled: body.enabled !== false,
      lastRunAt: null,
      nextRunAt: next.next,
      createdAt: nowIso()
    };
    const created = await schedules.create(row);
    await audit(ctx, "schedule.create", "schedule", created.id, undefined, created);
    return ok({ schedule: created }, 201);
  });

  api.route("PUT", "/api/schedules/:id", async (ctx) => {
    const before = await schedules.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    // System schedules (un-deletable platform sweepers) bypass the
    // tenant-scoped grant check — they're platform-wide config.
    if (before.system) {
      enforce(ctx.principal, "config:edit_global", {});
    } else {
      enforce(ctx.principal, "config:edit_tenant", {
        tenantId: before.tenantId ?? undefined
      });
    }
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<ScheduleRow> = {};
    if (typeof body.environment === "string") patch.environment = body.environment;
    if ("activationLabel" in body) {
      patch.activationLabel =
        typeof body.activationLabel === "string" ? body.activationLabel : null;
    }
    if (typeof body.timezone === "string") patch.timezone = body.timezone;
    if (isObject(body.input)) patch.input = body.input;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.cron === "string") {
      const tz = patch.timezone ?? before.timezone;
      const next = scheduleNextRun(body.cron, tz);
      if (!next.ok) {
        return error(422, "validation_failed", {
          issues: [{ path: "cron", message: next.message }]
        });
      }
      patch.cron = body.cron;
      patch.nextRunAt = next.next;
    }
    const updated = await schedules.update(ctx.params.id, patch);
    await audit(ctx, "schedule.update", "schedule", updated.id, before, updated);
    return ok({ schedule: updated });
  });

  api.route("PATCH", "/api/schedules/:id", async (ctx) => {
    const before = await schedules.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    if (before.system) {
      enforce(ctx.principal, "config:edit_global", {});
    } else {
      enforce(ctx.principal, "config:edit_tenant", {
        tenantId: before.tenantId ?? undefined
      });
    }
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.enabled !== "boolean") {
      return error(422, "validation_failed", {
        issues: [{ path: "enabled", message: "enabled (boolean) is required" }]
      });
    }
    const updated = await schedules.update(ctx.params.id, { enabled: body.enabled });
    await audit(ctx, "schedule.toggle", "schedule", updated.id, before, updated);
    return ok({ schedule: updated });
  });

  api.route("DELETE", "/api/schedules/:id", async (ctx) => {
    const before = await schedules.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    // System schedules are un-deletable — the worker can't run without
    // its stale-exec / retention sweepers.
    if (before.system) {
      return error(403, "system_schedule_undeletable", {
        message:
          "System schedules cannot be deleted. Disable or edit the cadence instead."
      });
    }
    enforce(ctx.principal, "config:edit_tenant", {
      tenantId: before.tenantId ?? undefined
    });
    await schedules.delete(ctx.params.id);
    await audit(ctx, "schedule.delete", "schedule", ctx.params.id, before, undefined);
    return { status: 204, body: undefined, headers: {} };
  });
}
