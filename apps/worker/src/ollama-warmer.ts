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
  logger?: StructuredLogger;
}

/**
 * Start the warmer; returns a stop function that clears the interval
 * and resolves once the in-flight ping settles. Idempotent — calling
 * stop twice is a no-op.
 */
export function startOllamaWarmer(opts: OllamaWarmerOptions): () => void {
  if (opts.models.length === 0) {
    return () => {};
  }
  const { models, baseUrl, intervalMs, logger } = opts;

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

  // Kick once synchronously to warm immediately on boot; subsequent
  // pings happen on the interval. void the promise so the caller
  // doesn't block on the first wave.
  void pingOnce();
  const handle = setInterval(() => {
    void pingOnce();
  }, intervalMs);
  // Don't keep the process alive solely for the warmer.
  const timer = handle as unknown as { unref?: () => void };
  if (typeof timer.unref === "function") timer.unref();

  return () => clearInterval(handle);
}
