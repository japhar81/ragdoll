/**
 * Secret CRUD: list / create / rotate / delete.
 *
 * `deps.secretProvider` does the encryption / persistence — these
 * routes only do request validation, scope inference (tenant header →
 * fallback into the ref), and audit writes. The values themselves
 * never leave the server unredacted.
 */
import { enforce } from "../../../../../packages/auth/src/index.ts";
import type { SecretRef } from "../../../../../packages/core/src/index.ts";
import { ok, error, isObject } from "../http-utils.ts";
import { buildSecretRef } from "../spec-helpers.ts";
import { interceptMutation } from "../platform-intercept.ts";
import type { AppDeps } from "../types.ts";
import type { RouteContext, RouteRegistry, AuditWriter } from "./types.ts";

interface SecretsServices {
  deps: AppDeps;
  audit: AuditWriter;
  tenantScope: (ctx: RouteContext) => string | undefined;
}

export function registerSecretsRoutes(
  api: RouteRegistry,
  svc: SecretsServices
): void {
  const { deps, audit, tenantScope } = svc;

  api.route("GET", "/api/secrets", async (ctx) => {
    enforce(ctx.principal, "secret:manage_tenant");
    const tenantId = tenantScope(ctx);
    const scope: Partial<SecretRef> = tenantId ? { tenantId } : {};
    const records = await deps.secretProvider.list(scope);
    return ok({
      secrets: records.map((record) => ({
        id: record.id,
        provider: record.provider,
        ref: record.ref,
        version: record.version,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        metadata: record.metadata,
        value: "REDACTED"
      }))
    });
  });

  api.route("POST", "/api/secrets", async (ctx) => {
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.key !== "string" || typeof body.value !== "string") {
      return error(422, "validation_failed", {
        issues: [{ message: "key and value are required" }]
      });
    }
    const ref = buildSecretRef(body, tenantScope(ctx));
    enforce(ctx.principal, "secret:manage_tenant", { tenantId: ref.tenantId });
    const createBlocked = await interceptMutation(
      deps,
      ctx,
      "secret.create",
      "secret",
      body.key,
      undefined
    );
    if (createBlocked) return createBlocked;
    const record = await deps.secretProvider.put(
      ref,
      body.value,
      isObject(body.metadata) ? body.metadata : undefined
    );
    await audit(ctx, "secret.create", "secret", record.id, undefined, {
      ref: record.ref,
      version: record.version,
      value: "REDACTED"
    });
    return ok(
      {
        secret: {
          id: record.id,
          ref: record.ref,
          version: record.version,
          value: "REDACTED"
        }
      },
      201
    );
  });

  api.route("PUT", "/api/secrets/:id", async (ctx) => {
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.key !== "string" || typeof body.value !== "string") {
      return error(422, "validation_failed", {
        issues: [{ message: "key and value are required to rotate" }]
      });
    }
    const ref = buildSecretRef(body, tenantScope(ctx));
    enforce(ctx.principal, "secret:manage_tenant", { tenantId: ref.tenantId });
    const rotateBlocked = await interceptMutation(
      deps,
      ctx,
      "secret.rotate",
      "secret",
      ctx.params.id,
      undefined
    );
    if (rotateBlocked) return rotateBlocked;
    const record = await deps.secretProvider.put(
      ref,
      body.value,
      isObject(body.metadata) ? body.metadata : undefined
    );
    await audit(ctx, "secret.rotate", "secret", record.id, undefined, {
      ref: record.ref,
      version: record.version,
      value: "REDACTED"
    });
    return ok({
      secret: { id: record.id, ref: record.ref, version: record.version, value: "REDACTED" }
    });
  });

  api.route("DELETE", "/api/secrets/:id", async (ctx) => {
    const body = ctx.request.body;
    if (!isObject(body) || typeof body.key !== "string") {
      return error(422, "validation_failed", {
        issues: [{ message: "key (and scope) required to identify the secret" }]
      });
    }
    const ref = buildSecretRef(body, tenantScope(ctx));
    enforce(ctx.principal, "secret:manage_tenant", { tenantId: ref.tenantId });
    const deleteBlocked = await interceptMutation(
      deps,
      ctx,
      "secret.delete",
      "secret",
      ctx.params.id,
      { ref }
    );
    if (deleteBlocked) return deleteBlocked;
    await deps.secretProvider.delete(ref, ref.tenantId);
    await audit(ctx, "secret.delete", "secret", ctx.params.id, { ref }, undefined);
    return { status: 204, body: undefined, headers: {} };
  });
}
