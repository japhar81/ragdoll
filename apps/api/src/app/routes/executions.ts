/**
 * Read-only execution endpoints: list with cursor pagination, get one,
 * and the full trace (parent + node records). Mutations live with the
 * pipeline-run routes — these only serve already-recorded data.
 */
import { enforce } from "../../../../../packages/auth/src/index.ts";
import { ok, error } from "../http-utils.ts";
import type { AppDeps } from "../types.ts";
import type { RouteContext, RouteRegistry } from "./types.ts";

interface ExecutionsServices {
  deps: AppDeps;
  tenantScope: (ctx: RouteContext) => string | undefined;
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
    // Cursor pagination: `?limit=<1..200>&cursor=<base64>`. When neither is
    // supplied the legacy "all rows" path runs to preserve back-compat for
    // existing API clients (and the test suite). The web Executions screen
    // always passes a limit so it hits the paginated path.
    const rawLimit = ctx.request.query.limit;
    if (rawLimit !== undefined && deps.executionStore.listExecutionsPage) {
      const limit = Math.max(1, Math.min(200, Number(rawLimit) || 50));
      const page = await deps.executionStore.listExecutionsPage({
        tenantId: scope,
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
    const executions = await deps.executionStore.listExecutions(scope);
    return ok({ executions });
  });

  api.route("GET", "/api/executions/:id", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const execution = await deps.executionStore.getExecution(ctx.params.id);
    if (!execution) return error(404, "not_found");
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId &&
      execution.tenantId !== ctx.principal.tenantId
    ) {
      return error(403, "forbidden");
    }
    return ok({ execution });
  });

  api.route("GET", "/api/executions/:id/trace", async (ctx) => {
    enforce(ctx.principal, "execution:view_logs");
    const execution = await deps.executionStore.getExecution(ctx.params.id);
    if (!execution) return error(404, "not_found");
    if (
      !ctx.principal.roles.includes("platform_admin") &&
      ctx.principal.tenantId &&
      execution.tenantId !== ctx.principal.tenantId
    ) {
      return error(403, "forbidden");
    }
    const nodes = await deps.executionStore.listNodes(ctx.params.id);
    return ok({ executionId: ctx.params.id, execution, nodes });
  });
}
