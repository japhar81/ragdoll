/**
 * Plugin catalog + provider catalog routes.
 *
 * - `/api/plugins` and `/api/plugins/:category/:id/:version` project
 *   registered in-process plugins onto the wire shape the Builder
 *   consumes (manifest + UI hints + ports).
 * - `/api/plugins/:id/docs` serves the narrative markdown next to
 *   each plugin id (used by the Builder Docs tab + the MCP server).
 * - `/api/providers` and `/api/providers/:id/models` enumerate the
 *   model provider adapters loaded at boot.
 *
 * Read-only; the only side effect is reading a markdown file off disk
 * for the docs endpoint. Permission `execution:view_logs` is reused
 * across all five — it is the broadest "logged-in" gate.
 */
import { enforce } from "../../../../../packages/auth/src/index.ts";
import { ok, error } from "../http-utils.ts";
import { readPluginDoc, projectPlugin } from "../spec-helpers.ts";
import type { PluginRef } from "../../../../../packages/core/src/index.ts";
import type { AppDeps } from "../types.ts";
import type { RouteRegistry } from "./types.ts";

interface PluginsProvidersServices {
  deps: AppDeps;
}

export function registerPluginsProvidersRoutes(
  api: RouteRegistry,
  svc: PluginsProvidersServices
): void {
  const { deps } = svc;

  api.route("GET", "/api/plugins", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const plugins = deps.pluginRegistry.list().map(projectPlugin);
    return ok({ plugins });
  });

  api.route("GET", "/api/plugins/:category/:id/:version", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const found = deps.pluginRegistry.get({
      category: ctx.params.category as PluginRef["category"],
      id: ctx.params.id,
      version: ctx.params.version
    });
    if (!found) return error(404, "not_found");
    return ok({ plugin: projectPlugin(found) });
  });

  // Narrative plugin documentation (docs/plugins/<id>.md) — what the node
  // does, inputs/outputs, gotchas, typical pipeline position, examples.
  api.route("GET", "/api/plugins/:id/docs", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const id = ctx.params.id;
    // Plugin ids are lowercase alphanumeric + underscore. Reject anything else
    // so the id can never escape `docs/plugins/` via `..`, slashes, etc.
    if (!/^[a-z0-9_]+$/.test(id)) return error(404, "not_found");
    const doc = await readPluginDoc(id);
    if (doc === undefined) return error(404, "not_found");
    return ok({ pluginId: id, doc });
  });

  api.route("GET", "/api/providers", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const providers = deps.providerRegistry.list().map((provider) => ({
      id: provider.id,
      displayName: provider.displayName
    }));
    return ok({ providers });
  });

  api.route("GET", "/api/providers/:id/models", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    let provider;
    try {
      provider = deps.providerRegistry.require(ctx.params.id);
    } catch {
      return error(404, "not_found");
    }
    return ok({ provider: provider.id, models: await provider.models() });
  });
}
