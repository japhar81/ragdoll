/**
 * Adapts the platform-plugin dispatcher into the runtime's decoupled
 * {@link ExecutionLifecycleHooks} (ADR 0036 pre-lane). Builds the
 * `execution.start` / `execution.finish` PRE events, runs the interceptors,
 * and translates the {@link InterceptResult} back into the narrow
 * deny/mutate/force-fail shape the DagExecutor understands.
 *
 * Cheap when no interceptors are installed: `intercept()` finds no matching
 * `before` hooks and returns `continue` with an empty patch, so both hooks
 * resolve to "no change".
 */
import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "../../../packages/core/src/index.ts";
import type { ExecutionLifecycleHooks } from "../../../packages/runtime/src/index.ts";
import type {
  ExecutionEvent,
  PlatformEventDispatcher
} from "../../../packages/platform-plugins/src/index.ts";

function execEvent(
  context: RuntimeContext,
  event: string,
  extra: { input?: unknown; output?: unknown }
): ExecutionEvent {
  return {
    id: randomUUID(),
    correlationId: context.executionId,
    event,
    phase: "pre",
    category: "execution",
    at: new Date().toISOString(),
    actor: { id: context.actor?.id ?? "system", tenantId: context.tenantId },
    tenantId: context.tenantId ?? null,
    target: { type: "execution", id: context.executionId },
    executionId: context.executionId,
    pipelineId: context.pipelineId,
    versionId: context.pipelineVersionId,
    environment: context.environment,
    ...extra
  };
}

export function lifecycleHooksFrom(
  dispatcher: PlatformEventDispatcher
): ExecutionLifecycleHooks {
  return {
    async onStart({ context, input }) {
      const result = await dispatcher.intercept(
        execEvent(context, "execution.start", { input })
      );
      if (result.decision.action === "deny" || result.decision.action === "fail") {
        return { deny: { reason: result.decision.reason } };
      }
      if (result.patch.input !== undefined) {
        return { input: result.patch.input as Record<string, unknown> };
      }
      return undefined;
    },
    async onFinish({ context, output }) {
      const result = await dispatcher.intercept(
        execEvent(context, "execution.finish", { output })
      );
      // A finish veto and a force-fail both mean "don't commit success".
      if (result.decision.action === "fail" || result.decision.action === "deny") {
        return { fail: { reason: result.decision.reason } };
      }
      if (result.patch.output !== undefined) {
        return { output: result.patch.output as Record<string, unknown> };
      }
      return undefined;
    }
  };
}
