/**
 * Phase 13 cleanup: keep local Ollama models warm so the first real
 * request doesn't pay a 30-60 second cold-start cost. We learned that
 * with `qwen2.5:72b` on CPU the model takes >60s to load from disk;
 * meanwhile the user's chat request hangs on what they assume is a
 * crash.
 *
 * Mechanism: a tiny periodic ping (`POST /api/generate` with one-token
 * settings) per listed model. Ollama caches loaded models in RAM until
 * idle for a few minutes, so a 5-minute heartbeat keeps them resident
 * indefinitely.
 *
 * Configuration:
 *   OLLAMA_WARM_MODELS=qwen2.5:0.5b,nomic-embed-text
 *     Comma-separated model ids. Unset/empty disables the warmer
 *     entirely — no-op on stacks that don't ship local Ollama.
 *   OLLAMA_WARM_INTERVAL_MS=300000   (default 5 minutes)
 *   OLLAMA_BASE_URL=http://ollama:11434  (default; matches compose)
 */
import type { StructuredLogger } from "../../../packages/observability/src/index.ts";

export interface OllamaWarmerOptions {
  models: string[];
  baseUrl: string;
  intervalMs: number;
  /**
   * Max wall-clock time the `ready` promise will wait for every model
   * to respond successfully before rejecting. Defaults to 10 minutes —
   * long enough for `ollama-pull` to fetch CPU models on a cold
   * cache, short enough to fail visibly if Ollama is misconfigured.
   */
  readyTimeoutMs?: number;
  /** Poll interval for the readiness gate. Defaults to 5 seconds. */
  readyPollMs?: number;
  logger?: StructuredLogger;
}

export interface OllamaWarmerHandle {
  /** Stop the periodic heartbeat. Idempotent. */
  stop: () => void;
  /**
   * Resolves once every configured model has responded successfully
   * at least once (i.e. is pulled AND loadable). Rejects if any model
   * cannot be made ready within {@link OllamaWarmerOptions.readyTimeoutMs}.
   *
   * Callers (e.g. the BullMQ consumer) await this to avoid taking
   * jobs while `ollama-pull` is still fetching weights — otherwise the
   * first /api/embed comes back 404 and the pipeline crashes.
   */
  ready: Promise<void>;
}

/**
 * Start the warmer; returns a handle exposing a `stop` callback and a
 * `ready` promise that resolves once every model has been verified
 * pullable + servable.
 */
export function startOllamaWarmer(opts: OllamaWarmerOptions): OllamaWarmerHandle {
  if (opts.models.length === 0) {
    return { stop: () => {}, ready: Promise.resolve() };
  }
  const { models, baseUrl, intervalMs, logger } = opts;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 600_000; // 10 min default
  const readyPollMs = opts.readyPollMs ?? 5_000;

  async function ping(
    endpoint: "/api/generate" | "/api/embed",
    model: string
  ): Promise<{ ok: boolean; status?: number; body?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    const body =
      endpoint === "/api/generate"
        ? {
            model,
            prompt: "ping",
            stream: false,
            keep_alive: "10m",
            options: { num_predict: 1 }
          }
        : { model, input: "ping", keep_alive: "10m" };
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, body: text };
    } finally {
      clearTimeout(timer);
    }
  }

  async function warmModel(model: string): Promise<void> {
    // Try /api/generate first (correct for chat models). Embedding-only
    // models like nomic-embed-text reject it with `does not support
    // generate` — fall back to /api/embed so the model still gets
    // pre-loaded. `keep_alive: 10m` on either endpoint pins the model
    // in RAM so the first real request pays no cold-start cost.
    try {
      const gen = await ping("/api/generate", model);
      if (gen.ok) {
        logger?.info?.("ollama_warm_keepalive", { model, via: "generate" });
        return;
      }
      const isEmbedModel =
        gen.status === 400 && /does not support generate/i.test(gen.body ?? "");
      if (!isEmbedModel) {
        logger?.warn?.("ollama_warm_failed", {
          model,
          status: gen.status,
          message: (gen.body ?? "").slice(0, 200)
        });
        return;
      }
      const embed = await ping("/api/embed", model);
      if (embed.ok) {
        logger?.info?.("ollama_warm_keepalive", { model, via: "embed" });
      } else {
        logger?.warn?.("ollama_warm_failed", {
          model,
          status: embed.status,
          message: (embed.body ?? "").slice(0, 200)
        });
      }
    } catch (e) {
      logger?.warn?.("ollama_warm_error", {
        model,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  async function pingOnce(): Promise<void> {
    for (const model of models) {
      await warmModel(model);
    }
  }

  /**
   * Probe a single model with a small request until it responds 2xx,
   * polling at `readyPollMs` until `deadline`. Resolves true on
   * success, false on deadline. Used by the boot readiness gate so
   * the worker doesn't accept jobs while `ollama-pull` is still
   * fetching weights.
   */
  async function waitUntilModelReady(
    model: string,
    deadline: number
  ): Promise<boolean> {
    while (Date.now() < deadline) {
      try {
        const gen = await ping("/api/generate", model);
        if (gen.ok) return true;
        // 400 "does not support generate" still means the model is
        // pulled — the embed path is what matters for these models.
        if (
          gen.status === 400 &&
          /does not support generate/i.test(gen.body ?? "")
        ) {
          const embed = await ping("/api/embed", model);
          if (embed.ok) return true;
        }
        // 404 = model not yet pulled. Keep waiting.
      } catch {
        // Network error during `ollama-pull` startup. Keep waiting.
      }
      logger?.info?.("ollama_warm_waiting_for_model", { model });
      await new Promise((resolve) => setTimeout(resolve, readyPollMs));
    }
    return false;
  }

  const readyDeadline = Date.now() + readyTimeoutMs;
  const ready: Promise<void> = (async () => {
    const results = await Promise.all(
      models.map((model) => waitUntilModelReady(model, readyDeadline))
    );
    const failed = models.filter((_, i) => !results[i]);
    if (failed.length > 0) {
      throw new Error(
        `ollama warmer timed out waiting for ${failed.join(", ")} after ${
          readyTimeoutMs / 1000
        }s`
      );
    }
    logger?.info?.("ollama_warmer_ready", { models });
  })();

  // Subsequent pings happen on the interval. The initial pings are
  // covered by the readiness probe above, so we don't double-fire
  // here.
  const handle = setInterval(() => {
    void pingOnce();
  }, intervalMs);
  const timer = handle as unknown as { unref?: () => void };
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => clearInterval(handle),
    ready
  };
}
