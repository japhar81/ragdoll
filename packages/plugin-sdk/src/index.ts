import type {
  ConfigDefinition,
  PipelineSpec,
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

/**
 * Named input or output port on a plugin. Declared ports let edges target a
 * specific slot (`fromPort` / `toPort`) instead of dumping every upstream
 * output into the downstream `inputs` bag. A plugin that declares ports also
 * gets independently-wireable outputs in the builder — wire `if_then.then` and
 * `if_then.else` to different downstream nodes; runtime treats an
 * undefined-on-emit port as a dead branch and skips its descendants. Plugins
 * with no declared ports keep the legacy "merge everything" wiring.
 */
export interface PortDef {
  /** Port name, e.g. "documents", "then", "else". Must be unique per side. */
  name: string;
  /** Human-readable description shown in the builder. */
  description?: string;
  /** When true, the runtime considers the port mandatory: a node will be
   *  skipped if a required input port has no live upstream value. */
  required?: boolean;
  /** Optional JSON-Schema-like shape describing the payload on this port. */
  schema?: JsonSchemaLike;
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
  /** Named input ports (declared contract). Undeclared plugins keep
   *  legacy merge wiring; declared plugins receive `inputs[portName]`. */
  inputPorts?: PortDef[];
  /** Named output ports (declared contract). The plugin's `outputs` map keys
   *  should match these names; an absent key on a declared port marks that
   *  branch dead so downstream nodes wired to it are skipped. */
  outputPorts?: PortDef[];
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
  /**
   * Recursively execute a body pipeline spec from inside a plugin. Used by
   * iteration plugins (for/foreach/while) to evaluate their body N times. Only
   * provided to in-process plugins — external plugins must implement their own
   * iteration if they need it. Returns the body's terminal outputs as a plain
   * object (same shape an outer pipeline returns to its caller).
   */
  runSubgraph?: (spec: PipelineSpec, initialInput: Record<string, unknown>) => Promise<Record<string, unknown>>;
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

/** Default execute/health timeout. Crawls are slow, so this is generous. */
const DEFAULT_EXTERNAL_TIMEOUT_MS = 300000;

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/**
 * Reduces a {@link RuntimeContext} to a JSON-safe wire object for an external
 * plugin. Strips the AbortSignal and any functions, turns the `deadline` Date
 * into an ISO string (or `null`), and collapses the resolved config down to
 * `{ values: { key: { value } } }` so secret/sensitivity metadata never leaves
 * the control plane.
 */
function toWireContext(context: PluginExecutionInput["context"]): Record<string, unknown> {
  const values: Record<string, { value: unknown }> = {};
  const resolved = context.resolvedConfig?.values ?? {};
  for (const [key, entry] of Object.entries(resolved)) {
    values[key] = { value: entry?.value };
  }
  let deadline: string | null = null;
  if (context.deadline instanceof Date && !Number.isNaN(context.deadline.getTime())) {
    deadline = context.deadline.toISOString();
  }
  return {
    requestId: context.requestId,
    executionId: context.executionId,
    tenantId: context.tenantId,
    pipelineId: context.pipelineId,
    pipelineVersionId: context.pipelineVersionId,
    environment: context.environment,
    deadline,
    resolvedConfig: { values }
  };
}

/**
 * Builds the exact JSON-safe request body for the external plugin HTTP
 * contract v1. Kept as a standalone function so tests can assert the wire
 * shape and the Python server can be validated against the same structure.
 */
export function buildExternalRequestBody(
  plugin: RegisteredPlugin,
  input: PluginExecutionInput
): Record<string, unknown> {
  return {
    plugin: {
      category: plugin.manifest.category,
      id: plugin.manifest.id,
      version: plugin.manifest.version
    },
    node: {
      id: input.node.id,
      config: input.node.config ?? {},
      secrets: input.node.secrets ?? {}
    },
    inputs: input.inputs,
    config: input.config,
    secrets: input.secrets,
    context: toWireContext(input.context)
  };
}

/**
 * Calls the external plugin health endpoint
 * (`GET {baseUrl}{healthPath ?? "/healthz"}`). Resolves (never rejects) so
 * callers can probe liveness without try/catch; on any transport/parse error
 * it returns `{ ok: false, message }`.
 */
export async function externalPluginHealth(
  endpoint: ExternalPluginEndpoint
): Promise<{ ok: boolean; plugins?: string[]; message?: string }> {
  if (endpoint.mode === "grpc") {
    return { ok: false, message: "grpc external transport not implemented" };
  }
  const url = joinUrl(endpoint.baseUrl, endpoint.healthPath ?? "/healthz");
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    if (!response.ok) {
      return { ok: false, message: `health check failed with HTTP ${response.status}` };
    }
    const body = (await response.json()) as { ok?: unknown; plugins?: unknown };
    const plugins = Array.isArray(body.plugins)
      ? body.plugins.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    return { ok: body.ok === true, plugins };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function executeExternalHttp(
  plugin: RegisteredPlugin,
  endpoint: ExternalPluginEndpoint,
  input: PluginExecutionInput
): Promise<PluginExecutionOutput> {
  const url = joinUrl(endpoint.baseUrl, endpoint.executePath ?? "/execute");
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildExternalRequestBody(plugin, input)),
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`External plugin request timed out after ${timeoutMs}ms`);
    }
    throw new Error(
      `External plugin request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown;
  let rawText = "";
  try {
    rawText = await response.text();
    parsed = rawText.length > 0 ? JSON.parse(rawText) : undefined;
  } catch {
    parsed = undefined;
  }
  const body = (parsed ?? {}) as {
    error?: unknown;
    outputs?: unknown;
    metadata?: unknown;
    usage?: unknown;
    artifacts?: unknown;
  };

  if (typeof body.error === "string") {
    throw new Error(body.error);
  }
  if (!response.ok) {
    const detail = rawText.trim().length > 0 ? `: ${rawText.trim()}` : "";
    throw new Error(`External plugin returned HTTP ${response.status}${detail}`);
  }

  const result: PluginExecutionOutput = {
    outputs:
      body.outputs && typeof body.outputs === "object"
        ? (body.outputs as Record<string, unknown>)
        : {}
  };
  if (body.metadata && typeof body.metadata === "object") {
    result.metadata = body.metadata as Record<string, unknown>;
  }
  if (body.usage && typeof body.usage === "object") {
    result.usage = body.usage as PluginExecutionOutput["usage"];
  }
  if (Array.isArray(body.artifacts)) {
    result.artifacts = body.artifacts as PluginExecutionOutput["artifacts"];
  }
  return result;
}

export async function executeRegisteredPlugin(
  plugin: RegisteredPlugin,
  input: PluginExecutionInput
): Promise<PluginExecutionOutput> {
  if (plugin.mode === "in_process" && plugin.implementation) {
    return plugin.implementation.execute(input);
  }
  if (plugin.mode === "external" && plugin.external) {
    if (plugin.external.mode === "grpc") {
      throw new Error("grpc external transport not implemented");
    }
    return executeExternalHttp(plugin, plugin.external, input);
  }
  throw new Error("External plugin execution is scaffolded; deploy plugin gateway before enabling external plugins");
}
