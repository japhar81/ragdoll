/**
 * Identity provider admin: list / create / update / delete the rows
 * the SSO start + callback routes look up. Secrets in `config` are
 * write-only — the projection redacts them on read.
 */
import { randomUUID } from "node:crypto";
import { enforce } from "../../../../../packages/auth/src/index.ts";
import type {
  IdentityProviderRow,
  IdentityProviderRepository
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import { publicIdp } from "../projections.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";

interface IdentityProvidersServices {
  audit: AuditWriter;
  identityProviders: IdentityProviderRepository;
}

export function registerIdentityProvidersRoutes(
  api: RouteRegistry,
  svc: IdentityProvidersServices
): void {
  const { audit, identityProviders } = svc;

  api.route("GET", "/api/identity-providers", async (ctx) => {
    enforce(ctx.principal, "idp:manage");
    const list = await identityProviders.list();
    return ok({ providers: list.map(publicIdp) });
  });

  api.route("POST", "/api/identity-providers", async (ctx) => {
    enforce(ctx.principal, "idp:manage");
    const body = ctx.request.body;
    if (
      !isObject(body) ||
      typeof body.slug !== "string" ||
      (body.kind !== "oidc" && body.kind !== "saml") ||
      typeof body.displayName !== "string"
    ) {
      return error(422, "validation_failed", {
        issues: [{ message: "slug, kind ('oidc'|'saml') and displayName are required" }]
      });
    }
    if (await identityProviders.findBySlug(body.slug)) {
      return error(409, "conflict", { message: "slug already exists" });
    }
    const now = nowIso();
    const row: IdentityProviderRow = {
      id: typeof body.id === "string" ? body.id : randomUUID(),
      slug: body.slug,
      kind: body.kind,
      displayName: body.displayName,
      enabled: body.enabled !== false,
      config: isObject(body.config) ? body.config : {},
      createdAt: now,
      updatedAt: now
    };
    const created = await identityProviders.create(row);
    await audit(ctx, "idp.create", "identity_provider", created.id, undefined, publicIdp(created));
    return ok({ provider: publicIdp(created) }, 201);
  });

  api.route("PUT", "/api/identity-providers/:id", async (ctx) => {
    enforce(ctx.principal, "idp:manage");
    const before = await identityProviders.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    const body = ctx.request.body;
    if (!isObject(body)) return error(422, "validation_failed", { issues: [] });
    const patch: Partial<IdentityProviderRow> = { updatedAt: nowIso() };
    if (typeof body.displayName === "string") patch.displayName = body.displayName;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (isObject(body.config)) {
      // Merge so a redacted secret left untouched by the UI is preserved.
      const merged = { ...(before.config as Record<string, unknown>) };
      for (const [k, v] of Object.entries(body.config)) {
        if (v === "REDACTED") continue;
        merged[k] = v;
      }
      patch.config = merged;
    }
    const updated = await identityProviders.update(ctx.params.id, patch);
    await audit(ctx, "idp.update", "identity_provider", updated.id, publicIdp(before), publicIdp(updated));
    return ok({ provider: publicIdp(updated) });
  });

  api.route("DELETE", "/api/identity-providers/:id", async (ctx) => {
    enforce(ctx.principal, "idp:manage");
    const before = await identityProviders.get(ctx.params.id);
    if (!before) return error(404, "not_found");
    await identityProviders.delete(ctx.params.id);
    await audit(ctx, "idp.delete", "identity_provider", ctx.params.id, publicIdp(before), undefined);
    return { status: 204, body: undefined, headers: {} };
  });
}
