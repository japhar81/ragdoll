/**
 * Periodic git-mode tenant reconciler.
 *
 * Each tick: list tenants whose `last_synced_at + poll_interval_sec` is in
 * the past, then run `reconcileTenant` for each. Sequential — one tenant
 * at a time — so a slow git host can't pile up worktrees in parallel.
 *
 * The actual reconcile lives in `apps/api/src/git-mirror.ts` so the same
 * code runs whether the trigger is this poller, a UI "Sync now" click,
 * or (future) a write-mutation hook.
 */
import type { StructuredLogger } from "../../../packages/observability/src/index.ts";
import { reconcileTenant, type MirrorDeps } from "../../api/src/git-mirror.ts";
import type { TenantGitConfigRepository } from "../../../packages/db/src/index.ts";

export interface GitPollerDeps {
  tenantGitConfigs: TenantGitConfigRepository;
  mirror: MirrorDeps;
  now?: () => Date;
  logger?: StructuredLogger;
}

export interface GitPoller {
  tick(): Promise<{ synced: number; failed: number }>;
  /** Returns a stop function that clears the interval. */
  start(intervalMs?: number): () => void;
}

const DEFAULT_INTERVAL_MS = 30_000;

export function createGitPoller(deps: GitPollerDeps): GitPoller {
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger;

  async function tick(): Promise<{ synced: number; failed: number }> {
    const due = await deps.tenantGitConfigs.listDue(now().toISOString());
    let synced = 0;
    let failed = 0;
    for (const cfg of due) {
      const result = await reconcileTenant(deps.mirror, cfg.tenantId).catch((e) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e)
      }));
      if (result.ok) {
        synced++;
      } else {
        failed++;
        logger?.warn("git_poller: reconcile failed", {
          tenantId: cfg.tenantId,
          error: result.error
        });
      }
    }
    if (synced + failed > 0) {
      logger?.info("git_poller: tick", { synced, failed });
    }
    return { synced, failed };
  }

  function start(intervalMs = DEFAULT_INTERVAL_MS): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async (): Promise<void> => {
      if (stopped) return;
      try {
        await tick();
      } catch (e) {
        logger?.error("git_poller: tick threw", {
          error: e instanceof Error ? e.message : String(e)
        });
      }
      if (!stopped) timer = setTimeout(loop, intervalMs);
    };
    timer = setTimeout(loop, intervalMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  return { tick, start };
}
