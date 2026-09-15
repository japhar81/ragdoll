/**
 * Worker plugin-registry boot: load the external `host: "worker"` (in-process
 * git) plugin sources from the shared plugin_sources store, then best-effort
 * push + discover the `host: "sidecar"` ones.
 *
 * Why this is its own module (and why the ordering matters):
 *
 * The worker validates every `run_pipeline` job against its registry
 * (`validatePipelineSpec(spec, deps.plugins)`). If a plugin the pipeline uses
 * isn't registered, validation fails with "plugin <id> is not registered", the
 * run is dead-lettered (run_pipeline is attempts:1 → no redelivery), and it
 * stays broken until the worker restarts.
 *
 * The original boot did the load, the sidecar push, AND the sidecar discovery
 * in one block and only committed the loaded registry (`plugins = holder`)
 * AFTER all three. So ANY throw after the holder was built — including a
 * transient DB blip inside `pushSidecarSources`' own `store.list()` — silently
 * discarded the fully-loaded worker-host registry and left the worker running
 * on the static built-ins, dead-lettering every external-plugin run until a
 * redeploy. The API showed the sources as loaded (it loads independently), so
 * the Plugin Sources page was green while runs failed — a confusing asymmetry.
 *
 * This helper fixes that: the loaded holder is the return value, so the
 * best-effort sidecar steps can NEVER discard it; a sidecar that's down only
 * affects sidecar plugins. If the load ITSELF fails (e.g. the DB wasn't
 * reachable yet) it THROWS, and the caller fail-fasts (exit → orchestrator
 * restart) rather than serving jobs with a static registry.
 */
import {
  loadPluginRegistryWithStore,
  pushSidecarSources,
  registerSidecarGitPlugins,
  type DbPluginSourceStore,
  type SourceLoadStatus
} from "../../../packages/plugin-loader/src/index.ts";
import type { PluginRegistry } from "../../../packages/plugin-sdk/src/index.ts";

interface WorkerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface InitWorkerPluginRegistryDeps {
  store: DbPluginSourceStore;
  logger: WorkerLogger;
  // Injectable for tests; default to the real implementations.
  loadRegistry?: typeof loadPluginRegistryWithStore;
  pushSidecar?: typeof pushSidecarSources;
  registerSidecar?: typeof registerSidecarGitPlugins;
}

/**
 * Build the worker's plugin registry. Returns the loaded holder. Throws only
 * when the store-backed load itself fails — callers should treat that as fatal
 * (do NOT fall back to a static registry and then consume jobs).
 */
export async function initWorkerPluginRegistry(
  deps: InitWorkerPluginRegistryDeps
): Promise<PluginRegistry> {
  const load = deps.loadRegistry ?? loadPluginRegistryWithStore;
  const push = deps.pushSidecar ?? pushSidecarSources;
  const register = deps.registerSidecar ?? registerSidecarGitPlugins;

  // Load the in-process (worker-host) git sources. A throw here (e.g. the DB
  // wasn't reachable) propagates — the caller fail-fasts.
  const { holder, statuses } = await load({ store: deps.store });

  // Surface any per-source failures LOUDLY: buildPluginRegistry records a
  // failed source and keeps going (it doesn't throw), so without this a git
  // source that failed to clone would silently leave its plugins unregistered
  // and its runs dead-lettering.
  const failed = statuses.filter((s: SourceLoadStatus) => s.status === "failed");
  if (failed.length > 0) {
    deps.logger.error("worker plugin sources failed to load", {
      failed: failed.map((s) => ({ id: s.id, error: s.error, stage: s.errorStage }))
    });
  }
  deps.logger.info("worker plugin registry built from plugin_sources store", {
    loaded: statuses.filter((s: SourceLoadStatus) => s.status === "loaded").length,
    failed: failed.length
  });

  // Sidecar push + discovery is best-effort and INDEPENDENT of the holder we
  // just built — a sidecar that's down (or a DB blip in the push) must not
  // take the worker-host plugins down with it.
  try {
    const pushed = await push(deps.store);
    if (pushed.pushed) {
      deps.logger.info("worker sidecar_sources_pushed", {
        sources: pushed.report?.sources?.length ?? 0
      });
    }
    await register(holder);
  } catch (e) {
    deps.logger.warn(
      "worker sidecar plugin discovery failed (worker-host plugins unaffected)",
      { error: e instanceof Error ? e.message : String(e) }
    );
  }

  return holder;
}
