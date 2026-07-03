/**
 * Webhook subscription admin (ADR 0036 Phase 1c): list / create / delete the
 * per-tenant `event_subscriptions` the worker's webhook-delivery plugin reads.
 * A subscription says "POST every matching `post` PlatformEvent to `url`,
 * signed with `secret`". Scoped to the caller's tenant; the `secret` is
 * write-only (redacted on read).
 */
import { randomUUID } from "node:crypto";
import { enforce } from "../../../../../packages/auth/src/index.ts";
import type {
  EventSubscriptionRow,
  EventSubscriptionRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";

interface EventSubscriptionServices {
  audit: AuditWriter;
  eventSubscriptions?: EventSubscriptionRepository;
}

/** Redact the signing secret on read (present-or-not is all a caller sees). */
function publicSubscription(row: EventSubscriptionRow) {
  return {
    id: row.id,
    tenantId: row.tenantId ?? null,
    events: row.events,
    phases: row.phases,
    url: row.url,
    hasSecret: Boolean(row.secret),
    active: row.active,
    description: row.description ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function registerEventSubscriptionRoutes(
  api: RouteRegistry,
  svc: EventSubscriptionServices
): void {
  const { audit, eventSubscriptions } = svc;

  api.route("GET", "/api/event-subscriptions", async (ctx) => {
    enforce(ctx.principal, "config:edit_tenant", {
      tenantId: ctx.principal.tenantId
    });
    if (!eventSubscriptions) return error(501, "not_configured");
    const rows = await eventSubscriptions.listByTenant(
      ctx.principal.tenantId ?? null
    );
    return ok({ subscriptions: rows.map(publicSubscription) });
  });

  api.route("POST", "/api/event-subscriptions", async (ctx) => {
    enforce(ctx.principal, "config:edit_tenant", {
      tenantId: ctx.principal.tenantId
    });
    if (!eventSubscriptions) return error(501, "not_configured");
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      !Array.isArray(body.events) ||
      body.events.length === 0 ||
      !body.events.every((e) => typeof e === "string") ||
      !isHttpUrl(body.url)
    ) {
      return error(422, "validation_failed", {
        issues: [
          { message: "events (non-empty string[]) and a http(s) url are required" }
        ]
      });
    }
    const phases =
      Array.isArray(body.phases) && body.phases.every((p) => p === "pre" || p === "post")
        ? (body.phases as string[])
        : ["post"];
    const now = nowIso();
    const row = await eventSubscriptions.create({
      id: randomUUID(),
      tenantId: ctx.principal.tenantId ?? null,
      events: body.events as string[],
      phases,
      url: body.url,
      secret: typeof body.secret === "string" ? body.secret : null,
      active: body.active === false ? false : true,
      description: typeof body.description === "string" ? body.description : null,
      createdBy: ctx.principal.id ?? null,
      createdAt: now,
      updatedAt: now
    });
    await audit(ctx, "event_subscription.create", "event_subscription", row.id, undefined, {
      events: row.events,
      url: row.url
    });
    return ok({ subscription: publicSubscription(row) }, 201);
  });

  api.route("DELETE", "/api/event-subscriptions/:id", async (ctx) => {
    enforce(ctx.principal, "config:edit_tenant", {
      tenantId: ctx.principal.tenantId
    });
    if (!eventSubscriptions) return error(501, "not_configured");
    const existing = await eventSubscriptions.get(ctx.params.id);
    // Tenant isolation: a caller can only delete their own tenant's rows
    // (platform-scoped rows require a global-scope principal, which
    // `enforce` above with a null tenantId already gates).
    if (
      !existing ||
      (existing.tenantId ?? null) !== (ctx.principal.tenantId ?? null)
    ) {
      return error(404, "not_found");
    }
    await eventSubscriptions.delete(ctx.params.id);
    await audit(ctx, "event_subscription.delete", "event_subscription", ctx.params.id, existing, undefined);
    return { status: 204, body: undefined, headers: {} };
  });
}
