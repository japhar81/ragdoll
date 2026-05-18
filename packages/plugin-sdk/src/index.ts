import type {
  ConfigDefinition,
  PluginCategory,
  PluginRef,
  RuntimeContext,
  SecretRef
} from "../../core/src/index.ts";

/**
 * Dependency-free JSON-Schema subset used to describe a plugin's `config` and
 * `secrets` shapes. It is intentionally minimal so the web UI can render a real
 * form (inputs, selects, ranges, secret pickers) instead of a raw JSON
 * textarea. No JSON-Schema library is pulled in; the shape below is all the
 * control plane and UI agree on.
 *
 * - `enum`    constrains a string/number field to a fixed set of choices.
 * - `default` seeds the form control with the value the plugin itself defaults
 *             to at runtime.
 * - `format`  is a semantic hint. The well-known value `"secret-ref"` marks a
 *             field that holds a reference to a managed secret (never a raw
 *             value); the UI renders a secret picker and the value never leaves
 *             the server.
 */
export interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  items?: JsonSchemaLike;
  additionalProperties?: boolean;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  format?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  category: PluginCategory;
  description: string;
  configSchema?: JsonSchemaLike;
  secretsSchema?: JsonSchemaLike;
  inputSchema?: JsonSchemaLike;
  outputSchema?: JsonSchemaLike;
  configDefinitions?: ConfigDefinition[];
  capabilities?: string[];
  ui?: {
    icon?: string;
    color?: string;
    /**
     * Per-field rendering hints keyed by config/secret property name. Values
     * are opaque to the control plane and consumed by the UI form renderer,
     * e.g. `{ temperature: { widget: "range", min: 0, max: 2, step: 0.1 },
     * apiKey: { widget: "secret" } }`.
     */
    formHints?: Record<string, unknown>;
    paletteGroup?: string;
    /**
     * Tier-2 custom editor seam (type + contract only; no host implementation
     * lives in this package). When set, this is an ESM module URL the web app
     * may dynamically import to render a bespoke config editor for this plugin
     * instead of the schema-driven form.
     *
     * Contract the module MUST satisfy:
     *
     *   The module either default-exports OR exports a named `ConfigEditor`
     *   that is a React component with the signature:
     *
     *     (props: {
     *       value: Record<string, unknown>;
     *       schema?: JsonSchemaLike;
     *       onChange: (next: Record<string, unknown>) => void;
     *     }) => ReactNode
     *
     *   - `value`    is the current (non-secret) config object.
     *   - `schema`   is the plugin's `configSchema` (if any) for reference.
     *   - `onChange` MUST be called with the full next config object on edit;
     *     the host treats config as a controlled value.
     *
     * Secret values are NEVER passed to or returned from a custom editor; the
     * editor may only emit secret *references*. Custom editors are untrusted
     * code: hosts SHOULD load them admin-only/registered and sandboxed. See
     * ADR 0008.
     */
    module?: string;
  };
}

export interface PluginExecutionInput {
  context: RuntimeContext;
  node: {
    id: string;
    plugin: PluginRef;
    config?: Record<string, unknown>;
    secrets?: Record<string, SecretRef>;
  };
  inputs: Record<string, unknown>;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

export interface PluginExecutionOutput {
  outputs: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  usage?: {
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    embeddingTokens?: number;
    estimatedCostUsd?: number;
  };
  artifacts?: Array<{ kind: string; uri?: string; data?: unknown; sensitive?: boolean }>;
}

export interface InProcessPlugin {
  manifest: PluginManifest;
  execute(input: PluginExecutionInput): Promise<PluginExecutionOutput>;
  healthCheck?(): Promise<{ ok: boolean; message?: string }>;
}

export interface ExternalPluginEndpoint {
  mode: "http" | "grpc";
  baseUrl: string;
  healthPath?: string;
  executePath?: string;
  timeoutMs?: number;
}

export interface RegisteredPlugin {
  manifest: PluginManifest;
  mode: "in_process" | "external";
  implementation?: InProcessPlugin;
  external?: ExternalPluginEndpoint;
}

export class PluginRegistry {
  private plugins = new Map<string, RegisteredPlugin>();

  register(plugin: RegisteredPlugin): void {
    this.plugins.set(pluginKey(plugin.manifest), plugin);
  }

  get(ref: PluginRef): RegisteredPlugin | undefined {
    return this.plugins.get(pluginKey(ref));
  }

  require(ref: PluginRef): RegisteredPlugin {
    const plugin = this.get(ref);
    if (!plugin) throw new MissingPluginError(ref);
    return plugin;
  }

  list(category?: PluginCategory): RegisteredPlugin[] {
    return [...this.plugins.values()].filter((plugin) => !category || plugin.manifest.category === category);
  }
}

export class MissingPluginError extends Error {
  constructor(ref: PluginRef) {
    super(`Missing plugin ${pluginKey(ref)}`);
    this.name = "MissingPluginError";
  }
}

export function pluginKey(ref: Pick<PluginRef, "category" | "id" | "version">): string {
  return `${ref.category}:${ref.id}:${ref.version}`;
}

export async function executeRegisteredPlugin(
  plugin: RegisteredPlugin,
  input: PluginExecutionInput
): Promise<PluginExecutionOutput> {
  if (plugin.mode === "in_process" && plugin.implementation) {
    return plugin.implementation.execute(input);
  }
  throw new Error("External plugin execution is scaffolded; deploy plugin gateway before enabling external plugins");
}
