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
import {
  BUILTIN_SOURCES,
  refreshPluginRegistry,
  applyExternalPlugins,
  pushSidecarSources
} from "../../../../../packages/plugin-loader/src/index.ts";
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
    // Built-in rows ALWAYS surface, even before the first refresh.
    // The boot path uses the legacy synchronous `loadRegistries()`
    // which doesn't populate `holder.statuses()` — without this,
    // an operator visiting the screen at boot would see an empty
    // catalog. The descriptors are the source of truth for the
    // catalog row shape; the holder's status overlay (when present)
    // adds the live `loaded / failed / pluginCount` envelope.
    const statuses = holder.statuses();
    const statusById = new Map(statuses.map((s) => [s.id, s]));
    const rows = await store.list({ enabledOnly: false });
    const sources = [
      // Built-ins from the in-code descriptor list — same set the
      // loader uses every refresh, kept here so the catalog is
      // honest before any refresh has run.
      ...BUILTIN_SOURCES.map((b) => {
        const live = statusById.get(b.id);
        return {
          id: b.id,
          kind: b.kind,
          displayName: b.displayName,
          description: b.description,
          enabled: true,
          builtin: true,
          subpath: b.subpath,
          status: live?.status,
          pluginCount: live?.pluginCount,
          loadedAt: live?.loadedAt,
          error: live?.error,
          errorStage: live?.errorStage
        };
      }),
      // External (DB-backed) sources: marry the row + the live status.
      // `host: "worker"` rows have a live worker-side status in the
      // holder; `host: "sidecar"` rows don't (the sidecar loads them) —
      // their status comes from the row's last-load fields, which
      // `pushSidecarSources` stamps via markLoadResult.
      ...rows.map((row) => {
        const live = statusById.get(row.id);
        const derivedStatus =
          live?.status ??
          (row.lastLoadOk === true
            ? "loaded"
            : row.lastLoadOk === false
              ? "failed"
              : undefined);
        return {
          id: row.id,
          kind: row.kind,
          host: row.host ?? "worker",
          displayName: row.displayName,
          description: row.description,
          enabled: row.enabled,
          builtin: false,
          gitUrl: row.gitUrl,
          ref: row.ref,
          subpath: row.subpath,
          lastCommitSha: live?.commitSha ?? row.lastCommitSha,
          lastFetchedAt: live?.loadedAt ?? row.lastFetchedAt,
          status: derivedStatus,
          pluginCount: live?.pluginCount ?? 0,
          error: live?.error ?? row.lastLoadError,
          errorStage: live?.errorStage
        };
      })
    ];
    return ok({ sources });
  });

  // PLUGIN-ARCH-1 close-out: CRUD on the plugin sources catalog.
  // The store-level methods are present on `DbPluginSourceStore` and
  // the in-memory shim used by tests; both are gated behind
  // `plugin:manage` here. Built-in (`builtin` / `sample-text`) source
  // ids are reserved — the API refuses to create / patch / delete
  // them so the safety-net rows never disappear.
  const RESERVED_SOURCE_IDS = new Set(["builtin", "sample-text"]);

  api.route("POST", "/api/plugins/sources", async (ctx) => {
    enforce(ctx.principal, "plugin:manage");
    const store = deps.pluginSourceStore;
    if (!store) return error(503, "plugin_source_store_not_wired");
    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const id = String(body.id ?? "").trim();
    const gitUrl = String(body.gitUrl ?? "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) {
      return error(400, "invalid_source_id");
    }
    if (RESERVED_SOURCE_IDS.has(id.toLowerCase())) {
      return error(400, "reserved_source_id");
    }
    if (!gitUrl) return error(400, "git_url_required");
    if (!store.create) return error(501, "store_does_not_support_create");
    const created = await store.create({
      id,
      gitUrl,
      ref: typeof body.ref === "string" ? body.ref : undefined,
      subpath: typeof body.subpath === "string" ? body.subpath : undefined,
      displayName:
        typeof body.displayName === "string" ? body.displayName : undefined,
      description:
        typeof body.description === "string" ? body.description : undefined,
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      // PLUGIN-ARCH-2: `worker` (TS in-process, default) or `sidecar`
      // (pushed to the python-plugins sidecar). Anything else falls
      // back to `worker`.
      host: body.host === "sidecar" ? "sidecar" : "worker",
      requireSignature:
        body.requireSignature === undefined
          ? false
          : Boolean(body.requireSignature),
      allowedSigners:
        typeof body.allowedSigners === "string"
          ? body.allowedSigners
          : undefined
    });
    return ok({ source: created });
  });

  api.route("PATCH", "/api/plugins/sources/:id", async (ctx) => {
    enforce(ctx.principal, "plugin:manage");
    const store = deps.pluginSourceStore;
    if (!store) return error(503, "plugin_source_store_not_wired");
    const id = ctx.params.id;
    if (RESERVED_SOURCE_IDS.has(id.toLowerCase())) {
      return error(400, "reserved_source_id");
    }
    if (!store.update) return error(501, "store_does_not_support_update");
    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<NonNullable<typeof store.update>>[1] = {};
    if (typeof body.gitUrl === "string") patch.gitUrl = body.gitUrl;
    if (typeof body.ref === "string") patch.ref = body.ref;
    if (typeof body.subpath === "string") patch.subpath = body.subpath;
    if (typeof body.displayName === "string")
      patch.displayName = body.displayName;
    if (typeof body.description === "string")
      patch.description = body.description;
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.host === "worker" || body.host === "sidecar")
      patch.host = body.host;
    if (body.requireSignature !== undefined)
      patch.requireSignature = Boolean(body.requireSignature);
    if (typeof body.allowedSigners === "string")
      patch.allowedSigners = body.allowedSigners;
    try {
      const updated = await store.update(id, patch);
      return ok({ source: updated });
    } catch (e) {
      const msg = (e as Error).message;
      if (/not found/i.test(msg)) return error(404, "not_found");
      throw e;
    }
  });

  api.route("DELETE", "/api/plugins/sources/:id", async (ctx) => {
    enforce(ctx.principal, "plugin:manage");
    const store = deps.pluginSourceStore;
    if (!store) return error(503, "plugin_source_store_not_wired");
    const id = ctx.params.id;
    if (RESERVED_SOURCE_IDS.has(id.toLowerCase())) {
      return error(400, "reserved_source_id");
    }
    if (!store.remove) return error(501, "store_does_not_support_delete");
    await store.remove(id);
    return ok({ ok: true });
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
    // PLUGIN-ARCH-2 single source of truth: push the `host: "sidecar"`
    // rows to the python-plugins sidecar FIRST so it clones + imports
    // them, THEN rebuild the registry. `applyExternalPlugins`
    // (postRegister) re-layers the env-driven sidecar plugins
    // (hardcoded built-ins + the git-loaded ones discovered via
    // /manifests, which now reflect what we just pushed) — without it,
    // a refresh would drop every external plugin.
    const sidecar = await pushSidecarSources(store);
    const report = await refreshPluginRegistry({
      holder,
      store,
      postRegister: applyExternalPlugins
    });
    return ok({ ...report, sidecar });
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
