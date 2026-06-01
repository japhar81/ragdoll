/**
 * External plugin transport — connect-rpc (Connect HTTP/JSON | gRPC | gRPC-Web).
 *
 * Split out from `./index.ts` so the browser bundle never reaches the
 * connect-rpc / gRPC / protobuf import chain through pipeline-spec or any
 * other intermediate package. Imports from `@ragdoll/plugin-sdk/transport`
 * only — DAG executor + tests are the only callers.
 *
 * One client per call. Connect's clients are cheap to construct; pooling lives
 * inside the transport (HTTP/2 connection reuse for `grpc`, keep-alive for
 * `connect`/`grpc-web`). Cancellation flows via AbortSignal; deadlines are
 * translated to per-call abort timers.
 */
import { create } from "@bufbuild/protobuf";
import type { JsonObject } from "@bufbuild/protobuf";
import { createClient, type Transport } from "@connectrpc/connect";
import {
  createConnectTransport,
  createGrpcTransport,
  createGrpcWebTransport
} from "@connectrpc/connect-node";
import {
  ExecuteRequestSchema,
  HealthRequestSchema,
  PluginRuntime,
  type ExecuteResponse
} from "@ragdoll/proto-gen/plugin";
import type {
  ExternalPluginEndpoint,
  PluginExecutionInput,
  PluginExecutionOutput,
  RegisteredPlugin
} from "./index.ts";

/** Default execute/health timeout. Crawls are slow, so this is generous. */
const DEFAULT_EXTERNAL_TIMEOUT_MS = 300000;

function transportFor(endpoint: ExternalPluginEndpoint): Transport {
  const protocol = endpoint.protocol ?? "connect";
  // grpc REQUIRES h2; connect/grpc-web default to 1.1 unless caller overrides.
  if (protocol === "grpc") {
    return createGrpcTransport({ baseUrl: endpoint.baseUrl });
  }
  const httpVersion = endpoint.httpVersion ?? "1.1";
  if (protocol === "grpc-web") {
    return createGrpcWebTransport({ baseUrl: endpoint.baseUrl, httpVersion });
  }
  return createConnectTransport({ baseUrl: endpoint.baseUrl, httpVersion });
}

// protobuf-es maps google.protobuf.Struct ⇄ JsonObject natively in TS — no
// hand-written conversion needed. The JSON.parse(JSON.stringify(...)) round-trip
// strips any undefined / function / Date / Map values that wouldn't survive the
// Struct wire encoding anyway (matches the strictness of the old HTTP body).
function asJsonObject(value: unknown): JsonObject {
  const json = JSON.parse(JSON.stringify(value ?? {})) as unknown;
  return json && typeof json === "object" && !Array.isArray(json) ? (json as JsonObject) : {};
}

/** Build the ExecuteRequest proto from the in-process PluginExecutionInput. */
function buildExecuteRequest(
  plugin: RegisteredPlugin,
  input: PluginExecutionInput
): ReturnType<typeof create<typeof ExecuteRequestSchema>> {
  const ctx = input.context;
  return create(ExecuteRequestSchema, {
    plugin: plugin.manifest.id,
    version: plugin.manifest.version,
    nodeId: input.node.id,
    tenantId: ctx.tenantId,
    environment: ctx.environment,
    requestId: ctx.requestId,
    config: asJsonObject(input.config),
    inputs: asJsonObject(input.inputs),
    dataset: input.dataset ? asJsonObject(input.dataset) : undefined,
    secrets: asJsonObject(input.secrets),
    // int64 on the wire → bigint in TS. Far-future Dates can exceed int32's
    // ~24-day ms ceiling, so bigint is necessary; 0n means "no deadline."
    deadlineMs:
      ctx.deadline instanceof Date && !Number.isNaN(ctx.deadline.getTime())
        ? BigInt(Math.max(0, ctx.deadline.getTime() - Date.now()))
        : 0n
  });
}

/** Decode an ExecuteResponse proto into the in-process PluginExecutionOutput. */
function fromExecuteResponse(resp: ExecuteResponse): PluginExecutionOutput {
  const result: PluginExecutionOutput = { outputs: (resp.outputs ?? {}) as Record<string, unknown> };
  if (resp.metadata && Object.keys(resp.metadata).length > 0) {
    result.metadata = resp.metadata as Record<string, unknown>;
  }
  if (resp.usage) {
    result.usage = {
      provider: resp.usage.provider || undefined,
      model: resp.usage.model || undefined,
      inputTokens: resp.usage.inputTokens || undefined,
      outputTokens: resp.usage.outputTokens || undefined,
      embeddingTokens: resp.usage.embeddingTokens || undefined,
      estimatedCostUsd: resp.usage.estimatedCostUsd || undefined
    };
  }
  if (resp.artifacts && resp.artifacts.length > 0) {
    result.artifacts = resp.artifacts.map((a) => ({
      kind: a.kind,
      uri: a.uri || undefined,
      data: a.data && a.data.length > 0 ? a.data : undefined,
      sensitive: a.sensitive || undefined
    }));
  }
  return result;
}

/**
 * Liveness + capability probe. Resolves (never rejects) so callers can probe
 * without try/catch; on any transport error returns `{ ok: false, message }`.
 */
export async function externalPluginHealth(
  endpoint: ExternalPluginEndpoint
): Promise<{ ok: boolean; plugins?: string[]; message?: string }> {
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const client = createClient(PluginRuntime, transportFor(endpoint));
    const resp = await client.health(create(HealthRequestSchema, {}), { signal: controller.signal });
    return {
      ok: resp.ok,
      plugins: resp.plugins.length > 0 ? resp.plugins : undefined,
      message: resp.message || undefined
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Unary external plugin call over connect-rpc. Retries transient connection
 * failures (3 attempts, 250ms / 750ms / 2250ms backoff) but NOT timeouts —
 * those usually mean the plugin is genuinely hung, not flaky.
 */
async function executeExternalConnect(
  plugin: RegisteredPlugin,
  endpoint: ExternalPluginEndpoint,
  input: PluginExecutionInput
): Promise<PluginExecutionOutput> {
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
  const req = buildExecuteRequest(plugin, input);
  const client = createClient(PluginRuntime, transportFor(endpoint));
  const attempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await client.execute(req, { signal: controller.signal });
      clearTimeout(timer);
      return fromExecuteResponse(resp);
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new Error(`External plugin request timed out after ${timeoutMs}ms`);
      }
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * Math.pow(3, attempt - 1)));
        continue;
      }
    }
  }
  throw new Error(
    `External plugin request failed after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

/**
 * Server-streaming external plugin call. Yields ExecuteChunks until the
 * server completes. Tokens are emitted via `input.onToken` when present;
 * the final `outputs` envelope is returned as the resolved value.
 *
 * Used when a plugin's manifest declares `streaming: true` and the runtime
 * is executing inside an SSE / chunked-response handler. Unlike the unary
 * path, streaming calls are NOT retried — partial output is irrecoverable.
 */
export async function executeExternalConnectStream(
  plugin: RegisteredPlugin,
  endpoint: ExternalPluginEndpoint,
  input: PluginExecutionInput
): Promise<PluginExecutionOutput> {
  const timeoutMs = endpoint.timeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const client = createClient(PluginRuntime, transportFor(endpoint));
    const req = buildExecuteRequest(plugin, input);
    let final: PluginExecutionOutput | undefined;
    const partialOutputs: Record<string, unknown> = {};
    for await (const chunk of client.executeServerStream(req, { signal: controller.signal })) {
      switch (chunk.payload.case) {
        case "token":
          input.onToken?.(chunk.payload.value);
          break;
        case "delta":
          Object.assign(partialOutputs, chunk.payload.value as Record<string, unknown>);
          break;
        case "final":
          final = fromExecuteResponse(chunk.payload.value);
          break;
      }
    }
    if (final) return final;
    // Server closed the stream without sending a final envelope — synthesise
    // one from accumulated deltas (or empty). Plugins SHOULD send a final
    // chunk on success; this is the lenient fallback.
    return { outputs: partialOutputs };
  } finally {
    clearTimeout(timer);
  }
}

export async function executeRegisteredPlugin(
  plugin: RegisteredPlugin,
  input: PluginExecutionInput
): Promise<PluginExecutionOutput> {
  if (plugin.mode === "in_process" && plugin.implementation) {
    return plugin.implementation.execute(input);
  }
  if (plugin.mode === "external" && plugin.external) {
    // Route to streaming variant when the caller provided an onToken sink AND
    // the plugin manifest opted into streaming. Without `streaming: true` the
    // server may not implement ExecuteServerStream; unary is the safe default.
    if (input.onToken && plugin.manifest.streaming === true) {
      return executeExternalConnectStream(plugin, plugin.external, input);
    }
    return executeExternalConnect(plugin, plugin.external, input);
  }
  throw new Error("External plugin execution is scaffolded; deploy plugin gateway before enabling external plugins");
}
