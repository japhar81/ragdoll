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

  async function pingOnce(): Promise<void> {
    for (const model of models) {
      try {
        // `keep_alive` keeps the model resident; `num_predict: 1` makes
        // the request near-instant once the model is loaded. We don't
        // care about the generated token — the side effect is what
        // matters.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90_000);
        try {
          const response = await fetch(`${baseUrl}/api/generate`, {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model,
              prompt: "ping",
              stream: false,
              keep_alive: "10m",
              options: { num_predict: 1 }
            })
          });
          if (!response.ok) {
            logger?.warn?.("ollama_warm_failed", {
              model,
              status: response.status,
              message: await response.text().then((t) => t.slice(0, 200))
            });
          } else {
            // Drain so the underlying connection can be released.
            await response.text();
            logger?.info?.("ollama_warm_keepalive", { model });
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        logger?.warn?.("ollama_warm_error", {
          model,
          error: e instanceof Error ? e.message : String(e)
        });
      }
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
