import {
  PluginRegistry,
  type InProcessPlugin,
  type RegisteredPlugin
} from "../../plugin-sdk/src/index.ts";
import {
  ProviderRegistry,
  OpenAIProvider,
  AnthropicProvider,
  OllamaCompatibleProvider
} from "../../providers/src/index.ts";
import * as builtinRagModule from "../../../plugins/builtin-rag/src/index.ts";
import * as sampleTextModule from "../../../plugins/sample-text/index.ts";

/**
 * The set of plugin module namespaces we scan for `InProcessPlugin` exports.
 * Adding a new plugin export to any of these modules (e.g. another agent
 * extending builtin-rag) is automatically picked up because we iterate
 * `Object.values()` of each namespace.
 */
const PLUGIN_MODULES: Array<Record<string, unknown>> = [
  builtinRagModule as unknown as Record<string, unknown>,
  sampleTextModule as unknown as Record<string, unknown>
];

/**
 * Duck-types a module export as an `InProcessPlugin`.
 *
 * We deliberately avoid `instanceof` (plugins are plain objects) and instead
 * check for the structural contract: a `manifest` with a string `id` and an
 * `execute` function. Non-plugin exports (helpers, classes, constants) are
 * skipped safely.
 */
export function isInProcessPlugin(value: unknown): value is InProcessPlugin {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { manifest?: unknown; execute?: unknown };
  if (typeof candidate.execute !== "function") return false;
  const manifest = candidate.manifest as { id?: unknown } | undefined;
  if (!manifest || typeof manifest !== "object") return false;
  return typeof (manifest as { id?: unknown }).id === "string";
}

/**
 * Builds a `PluginRegistry` containing every `InProcessPlugin` exported by the
 * builtin-rag and sample-text modules. Each is registered as an in-process
 * plugin keyed by `category:id:version` (see `pluginKey`).
 *
 * Iteration is over `Object.values(moduleNamespace)`, so plugins added
 * concurrently to those modules are automatically included with no edits here.
 */
export function loadPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  for (const moduleNamespace of PLUGIN_MODULES) {
    for (const exported of Object.values(moduleNamespace)) {
      if (!isInProcessPlugin(exported)) continue;
      const plugin = exported;
      const registered: RegisteredPlugin = {
        mode: "in_process",
        manifest: plugin.manifest,
        implementation: plugin
      };
      registry.register(registered);
    }
  }
  return registry;
}

/**
 * Builds a `ProviderRegistry` with the OpenAI, Anthropic, and
 * Ollama-compatible adapters registered (keyed by adapter `id`).
 */
export function loadProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new OpenAIProvider());
  registry.register(new AnthropicProvider());
  registry.register(new OllamaCompatibleProvider());
  return registry;
}

export interface LoadedRegistries {
  plugins: PluginRegistry;
  providers: ProviderRegistry;
}

/**
 * Convenience loader returning both the plugin and provider registries.
 */
export function loadRegistries(): LoadedRegistries {
  return {
    plugins: loadPluginRegistry(),
    providers: loadProviderRegistry()
  };
}
