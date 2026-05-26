/**
 * Auth settings singleton: signup mode + default role for SSO-only
 * accounts that need an initial role grant.
 */
import { enforce } from "../../../../../packages/auth/src/index.ts";
import type {
  AuthSettingsRepository,
  SignupMode
} from "../../../../../packages/db/src/index.ts";
import { ok, error, isObject, nowIso } from "../http-utils.ts";
import type { RouteRegistry, AuditWriter } from "./types.ts";

interface AuthSettingsServices {
  audit: AuditWriter;
  authSettings: AuthSettingsRepository;
}

export function registerAuthSettingsRoutes(
  api: RouteRegistry,
  svc: AuthSettingsServices
): void {
  const { audit, authSettings } = svc;

  api.route("GET", "/api/auth/settings", async (ctx) => {
    enforce(ctx.principal, "auth:settings");
    return ok({ settings: await authSettings.get() });
  });

  api.route("PUT", "/api/auth/settings", async (ctx) => {
    enforce(ctx.principal, "auth:settings");
    const body = ctx.request.body;
    const modes: SignupMode[] = ["admin_only", "open_default_role", "open_no_access"];
    if (!isObject(body) || !modes.includes(body.signupMode as SignupMode)) {
      return error(422, "validation_failed", {
        issues: [{ path: "signupMode", message: `signupMode must be one of ${modes.join(", ")}` }]
      });
    }
    const saved = await authSettings.set({
      signupMode: body.signupMode as SignupMode,
      defaultRole:
        typeof body.defaultRole === "string" ? body.defaultRole : null,
      updatedAt: nowIso()
    });
    await audit(ctx, "auth.settings.update", "auth_settings", "singleton", undefined, saved);
    return ok({ settings: saved });
  });
}
