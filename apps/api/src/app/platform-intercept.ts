/**
 * API-side platform-plugin PRE interception (ADR 0036). The API loads the same
 * RAGDOLL_PLATFORM_PLUGINS registry as the worker and runs the synchronous
 * `before()` interceptors at two kinds of chokepoint:
 *
 *   - {@link interceptAccept} — `execution.accept`, in enqueuePipelineRun,
 *     BEFORE a run is enqueued. A veto becomes a 4xx (the run is never
 *     accepted); a mutate can rewrite the accepted input / environment.
 *   - {@link interceptMutation} — a mutation's PRE phase, called by a route
 *     BEFORE it performs the write. A veto becomes a 4xx (the mutation never
 *     happens). (Mutating a mutation's before/after only reshapes the
 *     event/audit, not the write, so veto is the practical capability here.)
 *
 * Returns an AppResponse to short-circuit the route on a veto, else undefined.
 */
import { randomUUID } from "node:crypto";
import type {
  ExecutionEvent,
  MutationEvent
} from "../../../../packages/platform-plugins/src/index.ts";
import { error } from "./http-utils.ts";
import type { AppDeps, AppResponse } from "./types.ts";
import type { RouteContext } from "./routes/types.ts";

function actorOf(ctx: RouteContext) {
  return {
    id: ctx.principal.id ?? "system",
    type: ctx.principal.type,
    tenantId: ctx.principal.tenantId ?? undefined
  };
}

function denyResponse(
  decision: { action: "deny" | "fail"; reason: string; status?: number }
): AppResponse {
  const status =
    decision.action === "deny" ? decision.status ?? 403 : 422;
  return error(status, "blocked_by_platform_plugin", { message: decision.reason });
}

/** `execution.accept` gate. Mutates the passed-in run params in place when a
 *  hook rewrites input/environment; returns a 4xx response on veto. */
export async function interceptAccept(
  deps: AppDeps,
  ctx: RouteContext,
  run: {
    pipelineId: string;
    tenantId: string;
    environment: string;
    input: unknown;
  }
): Promise<AppResponse | undefined> {
  if (!deps.platformDispatcher) return undefined;
  const event: ExecutionEvent = {
    id: randomUUID(),
    correlationId: randomUUID(),
    event: "execution.accept",
    phase: "pre",
    category: "execution",
    at: new Date().toISOString(),
    actor: actorOf(ctx),
    tenantId: run.tenantId ?? null,
    target: { type: "pipeline", id: run.pipelineId },
    executionId: "",
    pipelineId: run.pipelineId,
    environment: run.environment,
    input: run.input
  };
  const result = await deps.platformDispatcher.intercept(event);
  if (result.decision.action === "deny" || result.decision.action === "fail") {
    return denyResponse(result.decision);
  }
  if (result.patch.input !== undefined) run.input = result.patch.input;
  if (typeof result.patch.environment === "string") {
    run.environment = result.patch.environment;
  }
  return undefined;
}

/** Mutation PRE gate — call BEFORE the write. Returns a 4xx on veto. */
export async function interceptMutation(
  deps: AppDeps,
  ctx: RouteContext,
  action: string,
  targetType: string,
  targetId: string,
  before: unknown
): Promise<AppResponse | undefined> {
  if (!deps.platformDispatcher) return undefined;
  const event: MutationEvent = {
    id: randomUUID(),
    correlationId: targetId,
    event: action,
    phase: "pre",
    category: "mutation",
    at: new Date().toISOString(),
    actor: actorOf(ctx),
    tenantId: ctx.principal.tenantId ?? null,
    target: { type: targetType, id: targetId },
    before
  };
  const result = await deps.platformDispatcher.intercept(event);
  if (result.decision.action === "deny" || result.decision.action === "fail") {
    return denyResponse(result.decision);
  }
  return undefined;
}
