/**
 * Liveness + readiness probes. Two static endpoints; no auth, no deps.
 */
import { ok } from "../http-utils.ts";
import type { RouteRegistry } from "./types.ts";

export function registerHealthRoutes(api: RouteRegistry): void {
  api.route("GET", "/healthz", async () => ok({ ok: true, status: "alive" }));
  api.route("GET", "/readyz", async () => ok({ ok: true, status: "ready" }));
}
