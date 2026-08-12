/**
 * Read-only execution endpoints: list with cursor pagination, get one,
 * the full trace (parent + node records), a live SSE result stream
 * (ADR-0037), and fetch-by-ref for a large streamed step body. Mutations
 * live with the pipeline-run routes — these only serve recorded/streamed data.
 */
import { enforce } from "../../../../../packages/auth/src/index.ts";
import {
  toStepWireFrame,
  type ChangeEvent
} from "../../../../../packages/events/src/index.ts";
import type { ExecutionRecord } from "../../../../../packages/runtime/src/index.ts";
import { ok, error } from "../http-utils.ts";
import type { AppDeps } from "../types.ts";
import type { RouteContext, RouteRegistry } from "./types.ts";

interface ExecutionsServices {
  deps: AppDeps;
  tenantScope: (ctx: RouteContext) => string | undefined;
}

/** Terminal execution statuses — once reached, no more step/lifecycle frames
 *  will follow, so the SSE stream ends. */
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "denied", "cancelled"]);

/** Shared read-authorization: a non-platform-admin principal may only see
 *  executions in its own tenant. Returns undefined when allowed, else the
 *  AppResponse to return. */
function executionTenantGuard(
  ctx: RouteContext,
  execution: ExecutionRecord
): ReturnType<typeof error> | undefined {
  if (
    !ctx.principal.roles.includes("platform_admin") &&
    ctx.principal.tenantId &&
    execution.tenantId !== ctx.principal.tenantId
  ) {
    return error(403, "forbidden");
  }
  return undefined;
}

export function registerExecutionsRoutes(
  api: RouteRegistry,
  svc: ExecutionsServices
): void {
  const { deps, tenantScope } = svc;

  api.route("GET", "/api/executions", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const tenantId = tenantScope(ctx);
    const scope =
      ctx.principal.roles.includes("platform_admin") || !tenantId
        ? undefined
        : tenantId;
    // Optional `?pipelineId=<uuid>` scopes results to one pipeline's runs.
    // Clients (e.g. the Bulwark pipeline console) rely on this to read a
    // single pipeline's real run state rather than the global latest.
    const pipelineId =
      typeof ctx.request.query.pipelineId === "string"
        ? ctx.request.query.pipelineId
        : undefined;
    // Cursor pagination: `?limit=<1..200>&cursor=<base64>`. When neither is
    // supplied the legacy "all rows" path runs to preserve back-compat for
    // existing API clients (and the test suite). The web Executions screen
    // always passes a limit so it hits the paginated path.
    const rawLimit = ctx.request.query.limit;
    if (rawLimit !== undefined && deps.executionStore.listExecutionsPage) {
      const limit = Math.max(1, Math.min(200, Number(rawLimit) || 50));
      const page = await deps.executionStore.listExecutionsPage({
        tenantId: scope,
        pipelineId,
        limit,
        cursor:
          typeof ctx.request.query.cursor === "string"
            ? ctx.request.query.cursor
            : undefined
      });
      return ok({
        executions: page.rows,
        nextCursor: page.nextCursor,
        total: page.total
      });
    }
    const executions = await deps.executionStore.listExecutions(
      scope,
      pipelineId
    );
    return ok({ executions });
  });

  api.route("GET", "/api/executions/:id", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const execution = await deps.executionStore.getExecution(ctx.params.id);
    if (!execution) return error(404, "not_found");
    const denied = executionTenantGuard(ctx, execution);
    if (denied) return denied;
    return ok({ execution });
  });

  api.route("GET", "/api/executions/:id/trace", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const execution = await deps.executionStore.getExecution(ctx.params.id);
    if (!execution) return error(404, "not_found");
    const denied = executionTenantGuard(ctx, execution);
    if (denied) return denied;
    const nodes = await deps.executionStore.listNodes(ctx.params.id);
    return ok({ executionId: ctx.params.id, execution, nodes });
  });

  // ADR-0037: live result stream for a single execution. Replays the step
  // frames already recorded (so a late joiner catches up), then tails the
  // change bus for this execution until it reaches a terminal status. Frames:
  //   event: hello                 — {executionId}
  //   event: step                  — a StepWireFrame (+ `replayed:true` on replay)
  //   event: execution.node.started/completed — node lifecycle passthrough
  //   event: execution.completed/failed/denied — terminal lifecycle
  //   event: done                  — stream is closing
  // A step whose body exceeded the inline cap arrives truncated (preview +
  // frameId); fetch the full body from GET /api/executions/:id/steps/:frameId.
  api.route("GET", "/api/executions/:id/stream", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const executionId = ctx.params.id;
    const execution = await deps.executionStore.getExecution(executionId);
    if (!execution) return error(404, "not_found");
    const denied = executionTenantGuard(ctx, execution);
    if (denied) return denied;

    const bus = deps.changeBus;
    const store = deps.executionStore;

    async function* frames(): AsyncGenerator<string> {
      const seen = new Set<string>();
      const queue: string[] = [];
      let wake: (() => void) | undefined;
      let ended = false;
      const f = (event: string, data: unknown): string =>
        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const push = (frame: string): void => {
        queue.push(frame);
        wake?.();
        wake = undefined;
      };
      const onEvent = (ev: ChangeEvent): void => {
        if (ev.targetType !== "execution" || ev.targetId !== executionId) return;
        const action = ev.action;
        if (action === "execution.step") {
          const frameId = (ev.payload as { frameId?: string } | undefined)?.frameId;
          if (frameId) {
            if (seen.has(frameId)) return; // already replayed / delivered
            seen.add(frameId);
          }
          push(f("step", ev.payload ?? {}));
        } else if (
          action === "execution.node.started" ||
          action === "execution.node.completed"
        ) {
          push(f(action, ev.payload ?? {}));
        } else if (
          action === "execution.completed" ||
          action === "execution.failed" ||
          action === "execution.denied"
        ) {
          push(f(action, ev.payload ?? {}));
          push(f("done", { executionId }));
          ended = true;
          wake?.();
          wake = undefined;
        }
      };
      // Subscribe BEFORE the replay read so a frame emitted in between is
      // buffered (and deduped by frameId) rather than lost.
      const unsub = bus ? bus.subscribe(onEvent) : () => undefined;
      try {
        yield f("hello", { executionId, status: execution!.status });
        if (store.listStepEvents) {
          try {
            const persisted = await store.listStepEvents(executionId);
            for (const step of persisted) {
              if (seen.has(step.frameId)) continue;
              seen.add(step.frameId);
              yield f("step", { ...toStepWireFrame(step), replayed: true });
            }
          } catch {
            /* replay is best-effort — a store without step reads just tails live */
          }
        }
        // Re-read status: if the run already finished (or there's no bus to
        // tail), drain whatever the subscription buffered and close.
        const latest = await store.getExecution(executionId);
        const finished =
          !!latest && TERMINAL_STATUSES.has(latest.status);
        if (finished || !bus) {
          while (queue.length) yield queue.shift()!;
          yield f("done", { executionId, status: latest?.status ?? execution!.status });
          return;
        }
        // Live tail until a terminal lifecycle event arrives.
        while (!ended) {
          while (queue.length) yield queue.shift()!;
          if (ended) break;
          await new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
              timer = undefined;
              push(":\n\n"); // SSE heartbeat comment — keeps idle connections open
            }, 15000);
            wake = () => {
              if (timer) {
                clearTimeout(timer);
                timer = undefined;
              }
              resolve();
            };
          });
        }
        while (queue.length) yield queue.shift()!;
      } finally {
        unsub();
      }
    }

    return {
      status: 200,
      body: frames(),
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    };
  });

  // ADR-0037: fetch the FULL body of a streamed step by frame id. A large step
  // travels truncated on the wire (preview + frameId); the client calls this to
  // pull the whole (redacted) payload on demand.
  api.route("GET", "/api/executions/:id/steps/:frameId", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const execution = await deps.executionStore.getExecution(ctx.params.id);
    if (!execution) return error(404, "not_found");
    const denied = executionTenantGuard(ctx, execution);
    if (denied) return denied;
    if (!deps.executionStore.getStepEvent) return error(404, "not_found");
    const step = await deps.executionStore.getStepEvent(
      ctx.params.id,
      ctx.params.frameId
    );
    if (!step) return error(404, "not_found");
    return ok({ step });
  });
}
