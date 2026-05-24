/**
 * File-watcher sidecar for RAGdoll codebase ingestion.
 *
 * Watches a mounted host directory (`WATCH_PATH`, mapped to /workspace by
 * docker-compose) and POSTs to a RAGdoll webhook trigger URL whenever
 * something changes. Events are debounced so a burst of saves
 * (e.g. a `git pull` rewriting hundreds of files) results in exactly one
 * pipeline run, not hundreds.
 *
 * Auth is whatever the webhook URL carries — the trigger token lives in the
 * path (`/api/triggers/webhook/<token>`) so no extra credential is needed
 * on the request itself.
 *
 * Zero deps on purpose: `node:fs.watch` with `{recursive: true}` is
 * supported on Linux/macOS/Windows from Node 20 onward, which the worker
 * image (node:22-alpine) satisfies. A misconfigured watch (no URL, missing
 * directory) logs and idles — the container stays up so `docker compose
 * ps` shows the configuration drift, instead of looping crash-restart.
 */
import { watch } from "node:fs";
import { stat } from "node:fs/promises";

interface Env {
  watchPath: string;
  webhookUrl: string;
  debounceMs: number;
  ignore: string[];
}

function readEnv(): Env {
  return {
    watchPath: process.env.WATCH_PATH ?? "/workspace",
    webhookUrl: process.env.FILE_WATCHER_WEBHOOK_URL ?? "",
    debounceMs: Number(process.env.FILE_WATCHER_DEBOUNCE_MS ?? 5000),
    ignore: (process.env.FILE_WATCHER_IGNORE ?? "node_modules,.git,dist,build")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  };
}

function shouldIgnore(relPath: string, ignore: string[]): boolean {
  // A simple substring-match keeps the watcher dependency-free. Patterns are
  // anchored on `/<token>/` or `/<token>$` so `node_modules/foo` ignores but
  // `nodejs_modules.md` does not. Empty/relative-root paths never match.
  if (!relPath || relPath === "/") return false;
  const padded = relPath.startsWith("/") ? relPath : `/${relPath}`;
  for (const token of ignore) {
    if (!token) continue;
    if (padded.includes(`/${token}/`)) return true;
    if (padded.endsWith(`/${token}`)) return true;
  }
  return false;
}

async function postWebhook(
  url: string,
  payload: Record<string, unknown>
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`webhook ${res.status}: ${body.slice(0, 200)}`);
  }
}

function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
  // Match the JSON-line shape the rest of the platform emits so this lands in
  // the same Loki query without a new parser.
  const entry = {
    level,
    ts: new Date().toISOString(),
    service: "ragdoll-file-watcher",
    msg,
    ...fields
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
}

async function main(): Promise<void> {
  const env = readEnv();
  // Sanity-check the watch directory exists — fs.watch on a missing path
  // throws ENOENT; pre-check so we can surface a clear log line instead.
  try {
    const s = await stat(env.watchPath);
    if (!s.isDirectory()) {
      log("error", "watch_path_not_a_directory", { path: env.watchPath });
      keepAlive();
      return;
    }
  } catch (e) {
    log("error", "watch_path_missing", {
      path: env.watchPath,
      error: e instanceof Error ? e.message : String(e)
    });
    keepAlive();
    return;
  }

  log("info", "watcher_starting", {
    watchPath: env.watchPath,
    debounceMs: env.debounceMs,
    ignore: env.ignore,
    webhookConfigured: Boolean(env.webhookUrl)
  });

  // Debounce: collect every changed path between bursts; fire once when the
  // event stream goes quiet for `debounceMs`. Keeping the path Set lets us
  // log meaningful "X files changed" hints in the same fire, and avoids
  // racing the webhook into multiple parallel pipeline runs.
  const changed = new Set<string>();
  let timer: NodeJS.Timeout | null = null;

  async function fire(): Promise<void> {
    timer = null;
    const paths = [...changed];
    changed.clear();
    if (paths.length === 0) return;
    if (!env.webhookUrl) {
      log("warn", "webhook_url_unset_skipping", { count: paths.length });
      return;
    }
    try {
      await postWebhook(env.webhookUrl, {
        source: "file-watcher",
        changedCount: paths.length,
        // Cap the sample so a huge bulk change doesn't bloat the request.
        sample: paths.slice(0, 50)
      });
      log("info", "webhook_posted", { count: paths.length });
    } catch (e) {
      log("error", "webhook_failed", {
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  function schedule(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      fire().catch((e) =>
        log("error", "fire_threw", {
          error: e instanceof Error ? e.message : String(e)
        })
      );
    }, env.debounceMs);
  }

  watch(env.watchPath, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    const rel = filename.toString();
    if (shouldIgnore(rel, env.ignore)) return;
    changed.add(rel);
    schedule();
  }).on("error", (e: Error) =>
    log("error", "fs_watch_error", { error: e.message })
  );

  keepAlive();
}

/** A no-op interval keeps the process alive when `watch` cannot start —
 *  preferable to a crash loop while the operator fixes the mount. */
function keepAlive(): void {
  setInterval(() => undefined, 60_000).unref?.();
}

main().catch((e) => {
  log("error", "watcher_crashed", {
    error: e instanceof Error ? e.message : String(e)
  });
  // Exit non-zero so docker restart=unless-stopped reincarnates us with
  // potentially-updated env.
  process.exit(1);
});
