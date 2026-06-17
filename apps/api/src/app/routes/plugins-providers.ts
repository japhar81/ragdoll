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
import { refreshPluginRegistry } from "../../../../../packages/plugin-loader/src/index.ts";
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

  // PLUGIN-ARCH-1: enumerate the source list (built-ins + DB rows) with
  // per-source load status. Drives the admin catalog's "where did each
  // plugin come from + which sources are healthy" view.
  api.route("GET", "/api/plugins/sources", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const holder = deps.pluginRegistryHolder;
    const store = deps.pluginSourceStore;
    if (!holder || !store) {
      // Legacy harness — no source store wired. Return the synthetic
      // "built-ins only" shape so the UI gets a stable wire contract
      // even on a degraded deployment.
      return ok({ sources: [] });
    }
    // Pull live status from the holder (the last build/refresh result)
    // + zip with the source rows so disabled / not-yet-loaded sources
    // still appear in the response.
    const statuses = holder.statuses();
    const statusById = new Map(statuses.map((s) => [s.id, s]));
    const rows = await store.list({ enabledOnly: false });
    const sources = [
      // Built-ins surface as the synthetic ids the loader uses.
      ...statuses
        .filter((s) => s.kind === "local")
        .map((s) => ({
          id: s.id,
          kind: s.kind,
          enabled: true,
          builtin: true,
          status: s.status,
          pluginCount: s.pluginCount,
          loadedAt: s.loadedAt,
          error: s.error,
          errorStage: s.errorStage
        })),
      // External (DB-backed) sources: marry the row + the live status.
      ...rows.map((row) => {
        const live = statusById.get(row.id);
        return {
          id: row.id,
          kind: row.kind,
          displayName: row.displayName,
          description: row.description,
          enabled: row.enabled,
          builtin: false,
          gitUrl: row.gitUrl,
          ref: row.ref,
          subpath: row.subpath,
          lastCommitSha: live?.commitSha ?? row.lastCommitSha,
          lastFetchedAt: live?.loadedAt ?? row.lastFetchedAt,
          status: live?.status ?? (row.lastLoadOk === false ? "failed" : undefined),
          pluginCount: live?.pluginCount ?? 0,
          error: live?.error ?? row.lastLoadError,
          errorStage: live?.errorStage
        };
      })
    ];
    return ok({ sources });
  });

  // PLUGIN-ARCH-1: admin-only refresh. Rebuilds the registry off-line
  // against the source store, atomically swaps the holder's pointer.
  // In-flight requests keep their snapshot of the prior registry; new
  // requests see the post-swap registry. Returns the diff (added /
  // removed / updated plugin keys) + per-source status so the admin
  // sees exactly what changed.
  api.route("POST", "/api/plugins/refresh", async (ctx) => {
    // ADR-0024 reused: `plugin:manage` already gates plugin lifecycle
    // changes. Refresh is a registry-altering action, so the same gate
    // is the right one — operators with plugin-management already
    // have it; everyone else can still GET /sources but not refresh.
    enforce(ctx.principal, "plugin:manage");
    const holder = deps.pluginRegistryHolder;
    const store = deps.pluginSourceStore;
    if (!holder || !store) {
      return error(503, "plugin_source_store_not_wired");
    }
    const report = await refreshPluginRegistry({ holder, store });
    return ok(report);
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
