/**
 * Boot loader for operator-installed platform plugins (in-process code).
 *
 * `RAGDOLL_PLATFORM_PLUGINS` is a comma/whitespace-separated list of module
 * specifiers (package names or paths). Each module default-exports a
 * PlatformPlugin, a PlatformPlugin[], or a registrar `(registry) => void`.
 * Loaded ONCE at boot — vetted, security-critical code (it can veto/mutate
 * platform operations), NOT runtime-fetched. Mirrors the identity/authz
 * provider loaders; fail-closed at the call site.
 */

import {
  PlatformPluginRegistry,
  type PlatformPlugin
} from "./plugin.ts";

export type PlatformPluginModuleExport =
  | PlatformPlugin
  | PlatformPlugin[]
  | ((registry: PlatformPluginRegistry) => void | Promise<void>);

function isPlatformPlugin(v: unknown): v is PlatformPlugin {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as PlatformPlugin).name === "string" &&
    Array.isArray((v as PlatformPlugin).subscriptions)
  );
}

/** Parse the env list into module specifiers (trimmed, deduped, order kept). */
export function parsePlatformPluginModules(
  env: { RAGDOLL_PLATFORM_PLUGINS?: string } = process.env
): string[] {
  const raw = env.RAGDOLL_PLATFORM_PLUGINS;
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const spec = part.trim();
    if (!spec || seen.has(spec)) continue;
    seen.add(spec);
    out.push(spec);
  }
  return out;
}

/** Apply one module's export to the registry. */
export async function applyPlatformPluginExport(
  registry: PlatformPluginRegistry,
  exported: unknown
): Promise<void> {
  if (typeof exported === "function") {
    await (exported as (r: PlatformPluginRegistry) => void | Promise<void>)(
      registry
    );
    return;
  }
  const plugins = Array.isArray(exported) ? exported : [exported];
  for (const p of plugins) {
    if (!isPlatformPlugin(p)) {
      throw new Error(
        "platform plugin module export is not a PlatformPlugin, PlatformPlugin[], or registrar function"
      );
    }
    registry.register(p);
  }
}

/**
 * Load every module in `RAGDOLL_PLATFORM_PLUGINS` into a registry (built on
 * top of `base` if given). `importer` is injectable for tests. Returns the
 * registry + the loaded specifiers.
 */
export async function loadPlatformPlugins(opts: {
  env?: { RAGDOLL_PLATFORM_PLUGINS?: string };
  base?: PlatformPluginRegistry;
  importer?: (spec: string) => Promise<unknown>;
} = {}): Promise<{ registry: PlatformPluginRegistry; loaded: string[] }> {
  const {
    env = process.env,
    base = new PlatformPluginRegistry(),
    importer = (spec) => import(spec)
  } = opts;
  const specs = parsePlatformPluginModules(env);
  for (const spec of specs) {
    const mod = (await importer(spec)) as { default?: unknown };
    const exported =
      mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
    await applyPlatformPluginExport(base, exported);
  }
  return { registry: base, loaded: specs };
}
