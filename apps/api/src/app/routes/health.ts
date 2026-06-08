/**
 * Liveness + readiness probes.
 *
 *  /healthz — process is up. No deps touched. Use this for k8s liveness.
 *  /readyz  — every dep the API needs to handle traffic is reachable. Use
 *             this for k8s readiness so a pod with a dead DB or dead Redis
 *             is taken out of the service rotation BEFORE requests hit it.
 *
 * Each check is best-effort: it runs with a short deadline so a slow probe
 * can never wedge the k8s readiness loop. On any failure /readyz returns
 * 503 with a per-component breakdown so the alert tells you what's down.
 */
import { ok } from "../http-utils.ts";
import type { RouteRegistry } from "./types.ts";
import type { PoolLike } from "../../../../../packages/db/src/index.ts";
import type { QueuePort } from "../../../../worker/src/index.ts";

export interface HealthDeps {
  pool?: PoolLike;
  queue?: QueuePort;
  readinessTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1500;

interface CheckResult {
  ok: boolean;
  error?: string;
  duration_ms?: number;
}

async function runCheck(
  fn: () => Promise<unknown>,
  timeoutMs: number
): Promise<CheckResult> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`readiness check timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      )
    ]);
    return { ok: true, duration_ms: Date.now() - start };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      duration_ms: Date.now() - start
    };
  }
}

export function registerHealthRoutes(
  api: RouteRegistry,
  health: HealthDeps = {}
): void {
  api.route("GET", "/healthz", async () => ok({ ok: true, status: "alive" }));

  api.route("GET", "/readyz", async () => {
    const timeoutMs = health.readinessTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const checks: Record<string, CheckResult> = {};

    if (health.pool) {
      checks.database = await runCheck(
        () => health.pool!.query("SELECT 1"),
        timeoutMs
      );
    }
    if (health.queue?.ping) {
      checks.queue = await runCheck(
        () => health.queue!.ping!(),
        timeoutMs
      );
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    const body = { ok: allOk, status: allOk ? "ready" : "degraded", checks };
    return { status: allOk ? 200 : 503, body, headers: {} };
  });
}
